# JWebAssembly — bugs found by testing, and how far they got fixed

This started as a bug hunt against JWebAssembly `0.4` (the only version
published to Maven Central). One of the bugs found — `try/catch/finally`
emitting invalid WebAssembly — turned out to already be fixed in
unreleased upstream commits, so this runtime now builds from a pinned HEAD
commit instead of `0.4` (see `jwebassembly-head-build/README.md` for
exactly which commits and why). This file reflects the **current, HEAD-built
state**: what got fixed by that upgrade, what's still broken, and what's
improved-but-not-actually-fixed.

25+ small Java programs covering loops, arrays, inheritance, interfaces,
switch, recursion, static fields/initializers, string concatenation,
long/double math, lambdas, `ArrayList`, `StringBuilder`, boxing, varargs,
generics, `instanceof`/casts, five different try/catch/finally shapes, and
stdin input were each compiled to `.wasm` and actually run in real
Chromium via Playwright — not just checked for a clean `compileToBinary()`.
Reproduction sources are in `bug-hunt/src/`; run `../build.sh` once first to
build the jars into `../lib/`, then `./t.sh <Name> --eh` from `bug-hunt/`.

Everything **not** listed below (loops, arrays incl. 2D, inheritance,
interfaces, switch, recursion, static fields/init blocks, string
concatenation, `long`/`double` math, lambdas, `ArrayList`, `StringBuilder`,
boxing, varargs, generics, `instanceof`/casts, multi-catch, nested
try/catch) compiled and ran correctly in both HEAD's default mode and 0.4.

## Fixed by upgrading to HEAD

### `try { } catch (...) { } finally { }` no longer emits invalid WebAssembly

Under `0.4`, any try statement with **both** a `catch` and a `finally`
clause compiled "successfully" but produced a `.wasm` binary that failed to
even load: `CompileError: ... function body must end with "end" opcode`.
Confirmed independent of `WASM_USE_EH`, the caught exception type, and
whether the exception was user- or VM-thrown; confirmed **not** to affect
plain `try/finally` or plain `try/catch` (incl. multi-catch, nesting) —
see git history of this file for the original write-up if needed.

Upstream fixed this before `0.4` was tagged as a release — commit
`c6fc938 Give CATCH blocks the right order with finally most outer block`
is 161 commits ahead of the `v0.4` tag. Building from that HEAD and
re-running `T20Finally.java`/`T20cCatchFinallySimple.java` confirms it:
both now return the correct value instead of failing to load.

```
$ node run.mjs T20Finally run 0   # try{x=1}catch{x=2}finally{x+=10}
{"ok":true,"result":11}
$ node run.mjs T20Finally run 1   # (flag=1 takes the throw+catch path)
{"ok":true,"result":12}
```

Repro: `bug-hunt/src/T20Finally.java`, `T20cCatchFinallySimple.java`.

## Still broken on HEAD (no fix available without patching JWebAssembly's own codegen)

### NullPointerException from a null field write is still not thrown

```java
Box b = null;
try {
    b.v = 5;               // real Java: throws NullPointerException, caught below
} catch (NullPointerException e) {
    return -1;
}
```

Same failure as under `0.4`, unchanged by the HEAD upgrade: the program
crashes with `TypeError: Cannot set properties of null (setting '2')`
thrown from inside JWebAssembly's own auto-generated JS shim
(`NonGC.set_i32`), one layer below the compiled module's control flow — the
Java `catch (NullPointerException e)` never runs, because the default
(non-GC) backend still doesn't insert a null check before the field store.

Switching to `WASM_USE_GC=true` doesn't fix this either — it fails
differently: the module doesn't even *load* for this specific test,
`WebAssembly.instantiate(): ... type error in branch[0] (expected
externref, got (ref null 2))`, a separate type-inference bug in the new GC
backend's handling of a ternary expression whose two branches are `null`
and an object reference (`makeNull != 0 ? null : new Box()`).

Fixing the non-GC case means adding null-check-before-field-access codegen
to JWebAssembly's `NonGC` backend — real compiler work in an unfamiliar
15k+ line codebase, not attempted.

Repro: `bug-hunt/src/T11NPE.java`, run with `run(1)`.

### Array out-of-bounds access is still silently wrong in the default mode

```java
int[] arr = new int[3];
return arr[5];   // real Java: throws ArrayIndexOutOfBoundsException
```

Unchanged in the default non-GC mode: returns `0` silently instead of
throwing anything, for both reads and writes — `NonGC.array_get_i32`/
`array_set_i32` are plain `a[2][i]`/`a[2][i]=v` on a JS typed array, which
JS itself treats as a silent no-op/`undefined`, not an error. This holds
even with `WASM_USE_EH=true` — the exception mechanism itself works fine
(see `T20Finally` above and the multi-catch/nested-try tests), it's
specifically array bounds checking that's absent from non-GC codegen.

`WASM_USE_GC=true` **does** change this — see "Improved but still not
release-ready: WASM-GC mode" below — but not into something a Java `catch`
can intercept, and not without hitting other new bugs.

Repro: `bug-hunt/src/T19ArrayOOB.java`, run with `run(5)`.

### `Scanner` still doesn't compile — confirmed a dead end even with the new `IgnoreNative` flag

Same `Unsafe.objectFieldOffset` compile failure as under `0.4`. HEAD adds a
new `JWebAssembly.IGNORE_NATIVE` property (stub out any unpolyfilled native
method instead of hard-failing) — tried it specifically to see if it would
get `Scanner` compiling. It gets further (past `objectFieldOffset`, past a
dozen `ZipFile`/`URLClassPath` native methods it now stubs successfully)
but then hits a **hard, non-stubbable failure**:

```
WasmException: Unsupported Unsafe method: sun/misc/Unsafe.ensureClassInitialized(Ljava/lang/Class;)V
	at sun.misc.SharedSecrets.getJavaUtilZipFileAccess(SharedSecrets.java:188)
```

— triggered by `Scanner`'s transitive dependency chain pulling in JDK
zip-file/classloading bootstrap internals that have nothing conceptually to
do with parsing input, and that `IGNORE_NATIVE`'s stub mechanism doesn't
cover (some `Unsafe` methods fail before the general native-method fallback
path even runs). `Scanner` remains unusable with JWebAssembly, full stop —
this isn't a "write your own Scanner" situation like it was for TeaVM
(which had no Scanner at all but could otherwise compile arbitrary
`java.util` code); here the class itself can't be compiled by any means
tried, including the newest available escape hatch.

Repro: `bug-hunt/src/T25Scanner.java`; the `IgnoreNative` variant is not
checked in (transient experiment, not something worth keeping as a fixture
since it doesn't get further than confirming the class is unusable).

## Improved but still not release-ready: WASM-GC mode

Under `0.4`, `WASM_USE_GC=true` output used an obsolete pre-standardization
RTT-based encoding (`rtt.canon`, `struct.new_default_with_rtt`) that every
current browser rejects outright: `WebAssembly.instantiate(): invalid value
type 0x5`. HEAD switches to the finalized WebAssembly GC encoding
(`struct.new`, recursive types) — confirmed **this part is fixed**: basic
object/array GC-mode output now actually loads and runs in real Chromium
(`T03Inherit`'s shape array, `T19ArrayOOB`'s array allocation).

That's real progress, but GC mode is not close to usable as a default —
testing surfaced two more bugs specific to it, neither present in `0.4`
because `0.4`'s GC mode never got far enough to hit them:

- **Array bounds violations now trap — but as an uncatchable raw WASM
  error, not a Java exception.** `T19ArrayOOB.run(5)` in GC mode throws
  `RuntimeError: array element access out of bounds` — real safety
  (better than silently returning 0), but it's a WASM engine trap, not
  something `catch (ArrayIndexOutOfBoundsException e)` can intercept, even
  with `WASM_USE_EH=true`.
- **Virtual/interface dispatch through an array is broken in GC mode.**
  `T03Inherit.totalArea()` (an array of an abstract `Shape` type, each
  element a different concrete subclass, called through `s.area()`) loads
  fine but crashes at runtime: `RuntimeError: null function or function
  signature mismatch` — a GC-mode-specific vtable bug, structurally similar
  to the TeaVM `WasmGCVirtualTableBuilder` bug this session's earlier
  TeaVM work found and patched, except here it's in unfamiliar,
  actively-changing upstream code with no prior root-cause investigation to
  build on.
- **Combining GC mode with exception handling can fail to load entirely.**
  `T22MultiCatch.java` (a plain `try` with two `catch` clauses, no
  `finally`) compiles under `WASM_USE_GC=true` + `WASM_USE_EH=true` but the
  output fails to load: `WebAssembly.compile(): tag signature 227 has
  non-void return` — an EH-tag-declaration bug specific to the GC backend.

None of these three were attempted as fixes — they're genuine compiler bugs
in code the upstream maintainer is still actively reworking (161 commits
past the last release, GC support mid-migration), not narrow, root-caused
issues like the TeaVM patches earlier in this project. Patching them
correctly would mean understanding JWebAssembly's vtable model and its new
WASM-3.0 exception-tag generation well enough to fix them without
introducing different breakage — realistically a multi-day investigation
with no guarantee of success, not attempted here.

**Practical implication: the default non-GC mode remains what this whole
runtime uses**, same as under `0.4`. GC mode is worth re-checking again as
upstream's migration continues, but isn't usable today for anything beyond
the simplest object/array code with no virtual dispatch and no exceptions.

## Stdin — solved with a workaround, same as before (unaffected by the HEAD upgrade)

`System.in` is still permanently `null` (no stdin plumbing in the
classlib), and `Scanner` still doesn't compile (see above) — but the same
custom-`@Import` bypass that makes `println` work also works for input.
`bug-hunt/src/T26StdinWorkaround.java` adds a `readbyte` import next to
`putchar`, builds `readLine()` out of it with a plain `StringBuilder` loop,
and uses it plus `Integer.parseInt` — verified end-to-end in a real
browser, unchanged behavior on HEAD:

```
input:  "42\nAda Lovelace\n"
output: "Enter a number:\nYou entered: 42\nEnter your name:\nHello, Ada Lovelace!\n"
result: 84   (42 * 2, returned from the exported function)
```

This only proves the *mechanism* works — the mock in `run-stdin-demo.mjs`
hands back a whole pre-supplied string synchronously, trivial in a test
harness but not how a real terminal works. A production `readbyte` would
need the same `SharedArrayBuffer`/`Atomics.wait` synchronous-blocking
bridge `../java-wasm-runtime/`'s `client/src/workers/stdin-bridge.ts`
already built for the TeaVM runtime's real `System.in` — reusable as a
mechanism, not wired up here.

Repro: `bug-hunt/src/T24StdinRaw.java`, `T25Scanner.java` (confirm the
gap); `T26StdinWorkaround.java` + `run-stdin-demo.mjs` (the fix).

## Reproducing

```bash
../build.sh                          # builds ../lib/jwebassembly-*-head.jar first
./t.sh T20Finally --eh               # now fixed
node run.mjs T20Finally run 0
./t.sh T11NPE --eh                   # still broken
node run.mjs T11NPE run 1
./t.sh T19ArrayOOB --eh              # still broken (default mode)
node run.mjs T19ArrayOOB run 5
./t.sh T19ArrayOOB --eh --gc         # traps instead, but uncatchable
node run-gc.mjs T19ArrayOOB run 5    # see bug-hunt/ for this GC-mode runner
```

(`t.sh`/`run.mjs`/`Compile.java` here are a slightly more generic version of
`../build.sh`/`../test/run.mjs`/`../tool/Compile.java`, parameterized over
class name instead of hardcoded to `Hello`, to make running many small test
programs practical.)
