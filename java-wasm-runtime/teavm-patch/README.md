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

**Divide-by-zero and modulo-by-zero** (`ArithmeticException`) are still uncatchable. Unlike
array bounds, there's no existing (but misconfigured) check-and-throw mechanism to fix — TeaVM's
WASM-GC backend (`BaseWasmGenerationVisitor.visit(BinaryExpr)`) lowers integer `/` and `%`
directly to the raw `i32.div_s`/`i32.rem_s` WASM instructions with no check at all. Making this
catchable would mean adding new codegen (emit a zero-check and throw `ArithmeticException`
before the division), not patching an existing pass — a materially bigger and riskier change
than the fixes above, so it hasn't been attempted.

## Rebuilding

`../build.sh` calls `apply.sh` in this directory automatically, which:
1. Clones `konsoletyper/teavm` at the `0.13.1` tag (git, not the archive-zip endpoint — same
   reasoning as the OpenJDK source fetch documented in the main fork note).
2. Copies the patched files in `classlib/` and `core/` over the corresponding paths in that
   checkout.
3. Publishes `core` and `classlib` to `mavenLocal()` as version `0.13.1-patched7` (bumped each
   time the patch set changes, since Gradle/mavenLocal can otherwise serve a stale cached
   artifact for a version string it's already seen).

`../gradle/libs.versions.toml` points `teavm-core`/`teavm-classlib` at that version
specifically (a separate `teavmPatched` version variable) — everything else (`teavm-tooling`,
`teavm-jso*`, `teavm-interop`, `teavm-platform`, the Gradle plugin) stays on the real
published `0.13.1`, since only these two modules were patched. `compiler/build.gradle` then
has to actively *force* Gradle to honor that choice (see bug #2 above) rather than silently
letting a transitive dependency override it.
