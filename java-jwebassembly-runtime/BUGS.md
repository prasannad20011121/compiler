# JWebAssembly 0.4 — bugs found by testing

This is a systematic bug hunt against the JWebAssembly compiler itself
(`de.inetsoftware:jwebassembly-compiler:0.4`, the only version published to
Maven Central), run through the same JDK-8 pipeline `build.sh` uses. 23 small
Java programs covering loops, arrays, inheritance, interfaces, switch,
recursion, static fields/initializers, string concatenation, long/double
math, lambdas, `ArrayList`, `StringBuilder`, boxing, varargs, generics,
`instanceof`/casts, and five different try/catch/finally shapes were each
compiled to `.wasm` and actually run in real Chromium via Playwright — not
just checked for a clean `compileToBinary()`. Reproduction sources are in
`bug-hunt/src/`.

Everything **not** listed below (loops, arrays incl. 2D, inheritance,
interfaces, switch, recursion, static fields/init blocks, string
concatenation, `long`/`double` math, lambdas, `ArrayList`, `StringBuilder`,
boxing, varargs, generics, `instanceof`/casts, multi-catch, nested try/catch)
compiled and ran correctly. The three bugs below are real, reproducible
defects in JWebAssembly 0.4 itself, found empirically, not inferred from
its docs or issue tracker.

## 1. `try { } catch (...) { } finally { }` emits invalid WebAssembly (severe)

Any try statement with **both** a `catch` and a `finally` clause on the same
`try` compiles "successfully" (`compileToBinary` returns normally) but the
resulting `.wasm` binary is structurally invalid and fails to even load:

```
CompileError: WebAssembly.instantiate(): Compiling function #44 failed:
  function body must end with "end" opcode @+2734
```

Confirmed independent of:
- the `WASM_USE_EH` property (fails identically with it on or off)
- the caught exception type (`RuntimeException`, `ArithmeticException`)
- whether the exception is user-thrown or VM-thrown (division by zero)

Confirmed **not** to affect:
- plain `try/finally` with no `catch` — works (`bug-hunt/src/T20bTryFinally.java`)
- plain `try/catch` with no `finally`, single or multi-catch, nested — works
  (`T12DivZero.java`, `T22MultiCatch.java`, `T23NestedTry.java`)

Repro: `bug-hunt/src/T20Finally.java`, `T20cCatchFinallySimple.java`. This
means `try/catch/finally` — a completely ordinary, common Java construct —
cannot be used anywhere in code destined for JWebAssembly 0.4, with no
workaround short of manually restructuring every such block into nested
try/catch plus duplicated cleanup code at each exit path.

## 2. NullPointerException from a null field write is not thrown at all — crashes instead as an unrelated, uncatchable JS TypeError

```java
Box b = null;
try {
    b.v = 5;               // real Java: throws NullPointerException, caught below
} catch (NullPointerException e) {
    return -1;
}
```

Expected: the catch block runs, returns -1. Actual: the program crashes with

```
TypeError: Cannot set properties of null (setting '2')
    at set_i32 (<anonymous>:7:24)
```

— a raw exception thrown from inside JWebAssembly's own auto-generated JS
shim (the `NonGC.set_i32` import), completely outside the compiled Wasm
module's control flow. The Java `catch (NullPointerException e)` never
triggers because JWebAssembly's default (non-GC) backend does not insert a
null check before the field store at all — it just lets the underlying JS
property write blow up. From the Java program's perspective this is worse
than an uncaught exception: it's a crash the program's own exception
handling cannot intercept, because the failure happens one layer below the
compiled code, in hand-written glue JS.

Repro: `bug-hunt/src/T11NPE.java`, run with `run(1)`.

## 3. Array out-of-bounds access is silently wrong instead of throwing

```java
int[] arr = new int[3];
return arr[5];   // real Java: throws ArrayIndexOutOfBoundsException
```

Expected (with `WASM_USE_EH=true` and no catch, this should at minimum
surface as *some* thrown exception): actual result is `0`, silently, both
for out-of-bounds reads and writes. No exception is thrown, at the Java
level or otherwise — `NonGC.array_get_i32`/`array_set_i32` are plain
`a[2][i]`/`a[2][i]=v` on a JS typed array, which JS itself treats as a
silent no-op/`undefined` rather than an error. This holds even with
`WASM_USE_EH=true` (bug #1 and #2's exception mechanism exists and works —
see `java-jwebassembly-runtime/README.md`'s verified exception-handling
section — it's specifically array bounds checking that's entirely absent).

This is worse than a crash: it's silent data corruption. Any code relying
on `ArrayIndexOutOfBoundsException` for correctness (not just as a safety
net) will silently compute wrong answers under JWebAssembly's default mode.

Repro: `bug-hunt/src/T19ArrayOOB.java`, run with `run(5)`.

## Reproducing

```bash
cd bug-hunt
./t.sh T20Finally --eh        # bug 1
node run.mjs T20Finally run 0
./t.sh T11NPE --eh            # bug 2
node run.mjs T11NPE run 1
./t.sh T19ArrayOOB --eh       # bug 3
node run.mjs T19ArrayOOB run 5
```

(`t.sh`/`run.mjs`/`Compile.java` here are a slightly more generic version of
`../build.sh`/`../test/run.mjs`/`../tool/Compile.java`, parameterized over
class name instead of hardcoded to `Hello`, to make running many small test
programs practical.)
