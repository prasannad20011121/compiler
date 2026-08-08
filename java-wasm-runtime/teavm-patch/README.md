# TeaVM core + classlib patches

`org.teavm:teavm-core`/`teavm-classlib` at the pinned `0.13.1` release have a bug that
crashed every `printf`/`String.format` call using a `%f`/float conversion: `TDecimalFormat`
copies its `TDecimalFormatSymbols` via `(TDecimalFormatSymbols) x.clone()` in three places,
and casting the result of `Object.clone()` back to its own concrete type trips a WASM-GC
backend bug — confirmed by isolated repro: the `clone()` call itself returns non-null, but
the very next field access on the cast result null-derefs. This is a backend (`org.teavm.backend.wasm`)
issue, not a classlib logic bug, and is out of scope to fix directly (see the main fork note
in `../README.md` for why touching TeaVM's backend codegen isn't something this fork attempts).

Instead, `classlib/java/util/TFormatter.java` and `classlib/java/text/TDecimalFormat.java`
in this directory are patched, drop-in replacements for the same files in TeaVM's own
`0.13.1` tag:

- `TDecimalFormat.java`: replaces all three `(TDecimalFormatSymbols) x.clone()` call sites
  with a manual field-by-field copy (via the class's own public getters/setters) that never
  calls `Object.clone()` or casts its result — sidestepping the backend bug rather than
  fixing it, entirely within classlib source.
- `TFormatter.java`: adds the `%n` (platform line separator) conversion, which wasn't
  implemented at all (`UnknownFormatConversionException: n`) — unrelated to the clone bug,
  just a genuinely missing feature noticed while fixing the above.

Known remaining gap: a fresh page's very first-ever compile of a program that hits this
code path can still occasionally crash with an unrelated-looking WASM trap
(`array element access out of bounds`) — reproducible deterministically in a synthetic
single-shot test, but not observed once a few unrelated programs have already been compiled
in the same browser session first. This looks like a V8/WASM JIT-tiering timing issue (the
bug disappears once the WASM engine has "warmed up"), not something fixable from classlib
source, and not the same bug as the clone/cast NPE above (that one was 100% reproducible
regardless of warm-up). Flagging as a known caveat rather than something claimed fixed.

## `teavm-core` patch: array-bounds exceptions weren't catchable

`ArrayIndexOutOfBoundsException` used to be uncatchable — a program's own
`try`/`catch (ArrayIndexOutOfBoundsException e)` around an out-of-bounds array access never
ran; the WASM module just hard-crashed with a raw, opaque `array.get`/`array.set` trap. Two
independent bugs combined to cause this, and both needed fixing:

1. **`core/model/transformation/BoundCheckInsertion.java`** (patched in this directory): the
   IR pass that decides where to insert a managed bounds check, before codegen ever runs. For
   a *constant* index into a *constant-sized* array, it elided the upper-bound check whenever
   both were merely constants — without comparing their actual values. So a literal
   out-of-bounds access like `new int[3]` followed by `arr[5]` (both operands constant) lost
   its bounds check entirely and fell straight through to the raw WASM instruction, which
   still traps on out-of-bounds but as an uncatchable low-level trap instead of a catchable
   `ArrayIndexOutOfBoundsException`. The patch adds the missing value comparison
   (`constantValue[index] >= 0 && constantValue[index] < constantValue[array]`) so the check
   is only elided when the access is actually provably in-bounds. See the comment inline in
   the patched file for the exact diff reasoning.
2. A **second, separate bug** in how this fork was consuming `teavm-core` — not something
   patchable inside TeaVM's own source, so it's fixed in this repo's own files instead:
   `compiler/.../Compiler.java` wasn't setting `WasmGCTarget`'s own `strict` flag (distinct
   from `TeaVMBuilder`/`DependencyAnalyzer`'s similarly-named flag), which gates whether
   `BoundCheckInsertion`/`NullCheckInsertion` run at all — defaults to `false` upstream. And
   even after setting it, `compiler/build.gradle`'s dependency resolution was silently
   discarding this patched `teavm-core` in favor of the real unpatched `0.13.1` for the
   `compiler` module's whole-program WASM-GC analysis, because `teavm-tooling` transitively
   depends on plain `0.13.1` and Gradle's default conflict resolution ranks an unsuffixed
   version higher than a suffixed one like `0.13.1-patched5` — so the patched core was being
   built and published correctly but never actually compiled into `compiler.wasm`. Fixed with
   a `resolutionStrategy.force` + `resolutionStrategy.eachDependency` block in
   `compiler/build.gradle` that forces `teavm-core`/`teavm-classlib` to the patched version
   and redirects every other `org.teavm:*` module back to the real release (since only core
   and classlib were actually patched and republished).

Both bugs had to be fixed together — fixing only #1 had no observable effect, since bug #2
meant the patched `BoundCheckInsertion` was never even being compiled into the shipped
`compiler.wasm` in the first place.

## `teavm-core` patch: `e.getMessage()` on a caught VM-thrown exception crashed

Once the array-bounds fix above made `catch` blocks for VM-thrown exceptions actually run, a
second, previously-unreachable bug surfaced: calling an inherited, never-overridden instance
method — `e.getMessage()` was the case that mattered in practice — on the caught exception
crashed with `"dereferencing a null pointer"`, even though the catch itself (type matching,
printing a literal string) worked fine. Reproduced for both `ArrayIndexOutOfBoundsException`
(via the bounds check above) and implicit `NullPointerException`
(`String s = null; s.length();`), so it's general to any VM-constructed exception, not specific
to bounds checks — user code doing `throw new RuntimeException("msg")` and calling
`.getMessage()` on *that* was always fine.

Root cause, confirmed by instrumenting the backend directly (adding temporary `System.err`
prints into `WasmGCVirtualTableBuilder`/`WasmGCClassGenerator`/`WasmGCVirtualCallGenerator`,
republishing, and reading the output back through the compiled compiler's own stderr stream —
since `compiler.wasm` runs this exact backend code, in the browser, to compile whatever program
is handed to it): TeaVM's WASM-GC backend builds each class's virtual-dispatch table via
`WasmGCVirtualTableBuilder`. For every class, it scans that class's own declared methods to find
implementations to register (`fillTable()`), but it only kept a method as a candidate
implementor if `isVirtual.test(methodRef)` returned true — `isVirtual` here is the SEPARATE,
whole-program result of TeaVM's devirtualization pass (does *any* call site anywhere in the
program require *this specific declaring class's* copy of the method to be dispatched
virtually). For `Throwable.getMessage()`, devirtualization had concluded — correctly, in
isolation — that no override exists anywhere, so no call site needs `Throwable`'s own vtable
slot for it (`isVirtual` = false for `Throwable.getMessage()`). But `WasmGCVirtualTableBuilder`
also independently allocates a vtable *entry* for any concrete class actually named as a call
site's static receiver type (`groupedMethodsAtCallSites`, built from a separate, later scan of
the compiled program's real invoke instructions) — and `e.getMessage()`, where `e`'s static type
is `ArrayIndexOutOfBoundsException` specifically (not `Throwable`), registers exactly such an
entry on `ArrayIndexOutOfBoundsException`'s own table. The `isVirtual` gate meant that entry got
allocated (a real struct field, a real slot index) but never received an implementor — it kept
its default value from `WasmStructNewDefault`, a null function reference. Calling `getMessage()`
through that slot at runtime meant invoking a null function reference: `"dereferencing a null
pointer"`. The two passes (devirtualization's per-method-declaration classification, and the
backend's per-call-site entry allocation) simply disagreed, and `isVirtual` was gating the wrong
thing — a method needing a vtable slot at all (decided correctly, independently, by
`groupedMethodsAtCallSites`) is not the same question as whether devirtualization happened to
rewrite every call site referencing it.

Fixed in `core/gc/vtable/WasmGCVirtualTableBuilder.java` by dropping the `isVirtual` check when
registering a class's own methods as implementor candidates — any non-static, non-private,
non-abstract method with a real compiled body is always safe to reference here: if nothing else,
the call sites devirtualization *did* rewrite to direct calls already require the body to exist
and be compiled. See the comment left inline in the patched file for the exact reasoning.

**Still-known remaining gap in the same area:** `e.toString()` and `e.getClass().getName()` on a
VM-thrown exception still crash, but this is a *different, deeper* bug than the one above — not
yet fixed. Instrumenting the same way showed `Throwable.toString()` reaches
`WasmGCVirtualTableBuilder` as `abstract=true, hasProgram=false` — its body was stripped
entirely, upstream of anything the WASM-GC backend controls, by TeaVM's main dependency
analyzer/dead-code-eliminator, because *that* pass (unlike the backend's own
`groupedMethodsAtCallSites` scan) never recognized `e.toString()` — called on a variable bound
by a `catch` clause — as real usage requiring the method to stay compiled. By the time the
backend's vtable-entry allocation runs, there is no body left to point the entry at, so the
`isVirtual` fix above can't help: the method was never merely mis-classified, it was actually
deleted. Fixing this would mean changing how TeaVM's core dependency analyzer (not the WASM-GC
backend module patched here) tracks exception values flowing out of `catch` blocks — a
materially larger, riskier change touching the shared reachability analysis used by every
backend, not just WASM-GC, so it wasn't attempted this round. `getClass()` alone (without
`.getName()` or `toString()`) does not reliably crash — likely because it reads class metadata
through a different, special-cased path — but chaining anything through `toString()` still does.

## `teavm-core` patch: divide-by-zero/modulo-by-zero made catchable (new codegen)

Unlike array bounds, there was no existing-but-misconfigured check-and-throw mechanism to fix
here — TeaVM's WASM-GC backend (`BaseWasmGenerationVisitor.visit(BinaryExpr)`) lowered integer
`/` and `%` directly to the raw `i32.div_s`/`i64.div_s`/`i32.rem_s`/`i64.rem_s` Wasm instructions
with no check at all, so `5 / 0` (or, much more commonly, a variable divisor that happens to be
zero at runtime) hard-crashed the whole module with an uncatchable low-level trap instead of
throwing a catchable `ArithmeticException`. This needed genuinely new codegen, not a bug fix, so
it's a bigger change than the others in this document — three separate problems had to be found
and fixed together for it to actually work end-to-end:

1. **New managed check-and-throw wrapper** in
   `core/generate/common/methods/BaseWasmGenerationVisitor.java`
   (`generateIntDivisionWithZeroCheck`), replacing the old direct
   `i32.div_s`/`i64.div_s`/`i32.rem_s`/`i64.rem_s` codegen for `DIVIDE` and integer `MODULO`.
   The **first attempt** used the same "branch with result" pattern as the existing null-check
   and array-bounds-check codegen (`WasmBranch` + `.setResult(...)`, wrapped in `WasmDrop` when
   the branch isn't taken) — but that pattern is only safe when the "result" value being carried
   is something already-computed and side-effect-free (a plain local read), which is true for
   null/bounds checks but NOT here: the "result" would be the division itself, i.e. exactly the
   operation whose safety depends on the branch outcome. Wasm's `br_if` renders the carried
   result *before* evaluating the branch condition (confirmed by reading
   `WasmBinaryRenderingVisitor.visit(WasmBranch)`), so that first attempt computed the
   (potentially trapping) division unconditionally regardless of the guard — it never actually
   prevented anything. Fixed by switching to a real `WasmConditional` (`if`/`then`/`else`, the
   same construct `visit(ConditionalExpr)` above uses for Java's `?:` operator), which lazily
   evaluates only the taken arm: the division lives in the `then` block (only reached once the
   divisor is confirmed nonzero), the throw lives in the `else` block.
2. **New runtime helper**: `WasmGCSupport.ae()` in
   `core/runtime/gc/WasmGCSupport.java` (`return new ArithmeticException("/ by zero");`,
   matching the existing `npe()`/`aiiobe()`/`cce()` pattern exactly), wired up via a new
   `WasmGCGenerationContext.aeMethod()` (`core/generate/gc/methods/WasmGCGenerationContext.java`)
   and a new `generateThrowArithmeticException()` override in
   `core/generate/gc/methods/WasmGCGenerationVisitor.java`. For completeness (so the classic,
   non-GC Wasm backend this fork doesn't use still compiles), a parallel
   `ExceptionHandling.throwArithmeticException()` was added to `core/runtime/ExceptionHandling.java`
   and wired into `core/generate/WasmGenerationVisitor.java` the same way that backend wires
   `throwNullPointerException`/`throwArrayIndexOutOfBoundsException`.
3. **The real blocker, found only after step 1 and 2 compiled fine in isolation**: calling
   `ae()` from real test programs crashed with a *Wasm module compile-time validation error*
   (`WebAssembly.compile(): ... expected 1 elements on the stack for fallthru, found 0`) — not a
   runtime trap. Root-caused by dumping the actual generated Wasm-GC module bytes out of the
   browser (via a temporary hook in the compiler worker) and reading the module's own `name`
   custom section with a small standalone script (general Wasm-GC tooling like `wabt`/`wasm2wat`
   couldn't parse TeaVM's Wasm-GC output at all, even recent versions — a dead end): the error
   was inside `WasmGCSupport::ae` itself, and swapping `ae()` for the already-working `npe()` in
   the same call site made it disappear, isolating the fault to `ArithmeticException` specifically
   — not the new `WasmConditional` codegen, and not `ae()`'s own trivial body (a no-arg
   `new ArithmeticException()` failed identically). The actual cause: `WasmGCDependencies
   .contributeExceptionUtils()` explicitly registers `npe()`/`aiiobe()`/`cce()` with TeaVM's
   *main* dependency analyzer (`analyzer.linkMethod(...).use()`) so their exception classes get
   properly processed through the normal, early reachability pipeline — the same pipeline
   responsible for generating a class's real Wasm-GC struct type. `ae()` was never added to that
   list, so `ArithmeticException` was reachable *only* through the codegen-time function cache
   (`context.aeMethod()`) — precisely the same kind of "helper method bypasses normal dependency
   analysis" gap documented in the `getMessage()` section above, just manifesting as a
   mismatched/fallback struct type at Wasm validation time instead of a null vtable slot at
   runtime. `NullPointerException`/`ArrayIndexOutOfBoundsException`/`ClassCastException` never
   hit this because they're already reachable through countless other paths throughout the
   classlib; `ArithmeticException` had no other path in a small test program. Fixed by adding
   `analyzer.linkMethod(new MethodReference(WasmGCSupport.class, "ae",
   ArithmeticException.class)).use();` to `contributeExceptionUtils()` in
   `core/gc/WasmGCDependencies.java`, matching the existing `npe`/`aiiobe`/`cce` lines exactly.

All three fixes were required together — verified via a variable-divisor test
(`int x = a / b;` where `b` is 0 at runtime, not a literal), which now compiles, throws a real
catchable `ArithmeticException`, and either gets caught by a matching `try`/`catch` or is
reported the same way any other uncaught exception is when there's no catch.

**Known remaining gap:** a *literal* constant division like `5 / 0` written directly in source
still crashes with the old raw, uncatchable trap — the fix above only covers the general case,
where the division's operands come from anywhere other than two Java compile-time-constant
literals. Something upstream of `visit(BinaryExpr)` handles that narrower literal-constant case
differently (not yet root-caused — a next candidate would be `org.teavm.model.Interpreter`, an
IR-level constant-folding evaluator that TeaVM's own optimizer passes use, though it also
contains an unrelated pre-existing copy-paste bug of its own: its own `DIVIDE` case computes
`a * b` instead of `a / b`). Since this only affects literal-constant divisors — an edge case
essentially never seen outside synthetic test programs, as opposed to the runtime/variable case
this fix actually targets — it's flagged as a known caveat rather than chased further this round.

## `teavm-classlib` patch: `System.in` wired to real terminal input, plus a from-scratch `Scanner`

`System.in` used to be a complete stub: `TConsoleInputStream.read()` unconditionally threw
`EOFException`, so any program reading from stdin failed instantly, and `java.util.Scanner`
didn't exist in TeaVM's classlib *at all* — not a bug in an existing implementation, a genuinely
missing class. Fixing "Scanner and stdin" needed three pieces:

1. **A real synchronous stdin transport.** This IDE already has a working mechanism for this,
   shared by the C/C++ and Python workers: a `SharedArrayBuffer` + `Atomics.wait`/`Atomics.notify`
   bridge (`client/src/workers/stdin-bridge.ts`) that blocks the *worker thread* (not the main/UI
   thread, where blocking isn't allowed) until the main thread delivers a line typed in the
   terminal. The Java worker (`client/public/java-worker.js`) just wasn't wired up to it —
   `runner.service.ts`'s Java branch was the only language not passing `stdinSab` to its worker.
   Fixed by passing it through (matching the C++/Python/C# branches exactly) and adding a
   `readStdinByte()` function to `java-worker.js` that blocks via the same bridge, decodes a full
   line the first time it's needed, and serves it back one byte at a time (mirroring
   `cpp-worker.js`'s own `refillStdin`/`stdinStrPos` buffering) until a new line is needed.
2. **A Wasm-GC import bridging that into compiled Java.** `WasmGCSupport.readStdinByte()`
   (`core/runtime/gc/WasmGCSupport.java`) is a new `@Import(module = "teavmConsole", ...)` native
   method — the same mechanism `putCharStdout`/`putCharStderr` already use for stdout/stderr,
   just for input, wired to `java-worker.js`'s function above via
   `installImports(o) { o.teavmConsole.readStdinByte = ...; }`. `TConsoleInputStream.read()`
   (`classlib/java/lang/TConsoleInputStream.java`) now calls it (gated behind
   `PlatformDetector.isWebAssemblyGC()`, the same runtime-branch-that-DCE-strips-per-target
   pattern `JSStdoutPrintStream`/`JSStderrPrintStream` already use to call the analogous output
   functions) instead of always throwing. There's no "close stdin" affordance in this browser
   terminal, so reads block indefinitely for more input rather than ever returning real EOF —
   matching how the C/C++ and Python workers' own interactive stdin already behaves in this IDE.
3. **A `Scanner` implementation, from scratch** (`classlib/java/util/TScanner.java` +
   `TInputMismatchException.java`, a new supporting exception `Scanner` throws on malformed
   numeric/boolean tokens). The obvious alternative — `BufferedReader` wrapping an
   `InputStreamReader`, both of which *do* already exist in TeaVM's classlib — doesn't compile
   for Wasm-GC at all: `InputStreamReader` unconditionally allocates `TByteBuffer`/`TCharBuffer`
   (java.nio) in its field initializers, and those classes have JS-target-only branches (guarded
   by a runtime `PlatformDetector.isJavaScript()` check, not compile-time exclusion) using
   `@JSByRef`-annotated methods (`Int8Array.fromJavaArray`) — which the Wasm-GC backend rejects
   outright with `"@JSByRef, which is not supported in Wasm GC"`, regardless of which branch
   would actually execute for this target. That's a NIO-wide gap, not a one-line fix, so rather
   than chase it, `TScanner` reads bytes directly off the underlying `TInputStream` and decodes
   UTF-8 by hand (mirroring `WasmGCSupport.nextCharArray()`'s existing manual decode elsewhere in
   this fork), sidestepping `TByteBuffer`/`TCharBuffer`/`InputStreamReader` entirely. Covers the
   subset real programs actually use: `next`/`nextLine`/`nextInt`/`nextLong`/`nextDouble`/
   `nextFloat`/`nextBoolean` and their `hasNextXxx()` peek forms, whitespace-delimited
   tokenizing, and both `Scanner(InputStream)` (for `System.in`, blocking/no-EOF as above) and
   `Scanner(String)` (finite content, real EOF via `hasNext()`/`hasNextLine()` returning `false`).
   Four-byte UTF-8 sequences (astral code points) decode to the replacement character rather than
   a correct surrogate pair — a deliberate simplification, since console input essentially never
   contains them.

Verified end-to-end: a program blocking on `Scanner(System.in).nextInt()` after typing multiple
space-separated tokens on one line, reading several subsequent lines, and a separate
`Scanner(String)` correctly hitting real EOF, all work as expected; a raw byte-by-byte
`System.in.read()` loop (no Scanner at all) confirms the underlying transport independently.

**Known remaining gap:** `BufferedReader`/`InputStreamReader` over `System.in` still don't
compile, for the NIO/`@JSByRef` reason explained above — `Scanner` is the way to read stdin in
this runtime for now. Fixing `InputStreamReader` would mean either gating `TByteBuffer`/
`TCharBuffer`'s JS-specific branches behind compile-time (not runtime) target exclusion, or
rewriting `InputStreamReader` to avoid NIO the same way `Scanner` does above — a large enough
change to `java.nio` itself that it wasn't attempted this round.

## Rebuilding

`../build.sh` calls `apply.sh` in this directory automatically, which:
1. Clones `konsoletyper/teavm` at the `0.13.1` tag (git, not the archive-zip endpoint — same
   reasoning as the OpenJDK source fetch documented in the main fork note).
2. Copies the patched files in `classlib/` and `core/` over the corresponding paths in that
   checkout.
3. Publishes `core` and `classlib` to `mavenLocal()` as version `0.13.1-patched9` (bumped each
   time the patch set changes, since Gradle/mavenLocal can otherwise serve a stale cached
   artifact for a version string it's already seen).

`../gradle/libs.versions.toml` points `teavm-core`/`teavm-classlib` at that version
specifically (a separate `teavmPatched` version variable) — everything else (`teavm-tooling`,
`teavm-jso*`, `teavm-interop`, `teavm-platform`, the Gradle plugin) stays on the real
published `0.13.1`, since only these two modules were patched. `compiler/build.gradle` then
has to actively *force* Gradle to honor that choice (see bug #2 above) rather than silently
letting a transitive dependency override it.
