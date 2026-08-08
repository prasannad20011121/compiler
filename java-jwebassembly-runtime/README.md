# java-jwebassembly-runtime

An **alternate-toolchain exploration**: compiling Java to WebAssembly with
[JWebAssembly](https://github.com/i-net-software/JWebAssembly)
(`de.inetsoftware:jwebassembly-compiler`), instead of TeaVM (used by
`../java-wasm-runtime/`, the runtime actually wired into the IDE).

**This does not replace `java-wasm-runtime/` and is not wired into the
client.** It's a separate, honest evaluation of a fundamentally different
architecture, kept on its own branch. See "Why this can't replace
java-wasm-runtime" below before assuming otherwise.

## Quick start

```bash
./build.sh                # needs a real JDK 8, see below — writes out/hello.wasm
cd test && npm install     # first time only
node run.mjs                # verifies it in a real headless Chromium
```

Expected output:

```
output: "Hello from Java via JWebAssembly!\nsum computed\n"
sum: 15
PASS
```

## Architecture: fundamentally different from TeaVM

JWebAssembly compiles **pre-built `.class` bytecode files** to WASM. It has
no javac of its own and no live source-to-WASM path. `java-wasm-runtime/`
runs a real `javac` *inside the browser* at request time, compiling whatever
source the user typed; JWebAssembly instead needs source compiled to
`.class` files **before** the WASM module is built, by an external `javac`
that isn't part of the shipped artifact. There is no way to give a browser
"Java source in, WASM module out" with JWebAssembly alone — you'd need to
separately get *a Java compiler* running as WASM (e.g. TeaVM again, or
JWebAssembly compiling itself, neither of which was attempted here) and
somehow feed its output back into a second WASM compile stage. That's a
different, much larger project than what's in this directory.

So this directory demonstrates the narrower, already-interesting question:
given Java bytecode, how good is JWebAssembly's output?

## Why JDK 8, specifically

JWebAssembly (last released 2022) resolves supporting JDK classes like
`java.lang.String` from **whichever JVM is running the JWebAssembly compiler
itself** — not from whatever JDK originally compiled the input `.class`
file. Compile a source file with `javac --release 8` on a modern JDK and the
`.class` file's bytecode is release-8-shaped, but the JVM running
JWebAssembly still resolves `java.lang.String.class` from its own runtime.
Under JDK 17+ (including 25), `String` methods route through
`jdk.internal.misc.Unsafe`-based compact-string field access internally —
and JWebAssembly's classlib polyfills (`ReplacementForString`,
`ReplacementForSystem`, etc., from `jwebassembly-api`) don't cover that, so
compilation fails:

```
WasmException: Abstract or native method can not be used:
  jdk/internal/misc/Unsafe.getLongVolatile(Ljava/lang/Object;J)J
```

`--release 8` does **not** fix this — it only restricts the bytecode/API
surface a program is allowed to use; it does not change which JDK's actual
runtime classes get referenced during compilation, since JWebAssembly reads
those via its own classpath scanning, driven by whatever JVM launched it.
The only fix is running the **entire JWebAssembly compile step** — not just
`javac` — under a genuine JDK 8 JVM, so `java.lang.String` resolves to
JDK 8's older, `char[]`-based implementation that JWebAssembly's
era-matched polyfills actually support. `build.sh` does exactly this: both
`javac` and `java` (to run the compiler) come from `JAVA8_HOME`.

This is also why `System.out.println` still doesn't compile even under
JDK 8 — `PrintStream`'s `Thread.currentThread()` dependency chain isn't
polyfilled by `jwebassembly-api` at all, JDK version notwithstanding.
`examples/Hello.java` works around this with a hand-written `print`/`println`
built on a custom `@Import`-based `putChar`, mirroring the
`WasmGCSupport.putCharStdout` pattern from the TeaVM runtime.

## What's verified working (real browser, not just "compiles")

All of the following were checked by actually instantiating the compiled
`.wasm` in Chromium via Playwright and asserting on results — not just that
`compileToBinary` didn't throw. Two of the three below (String support, EH)
looked fine at compile time and were still worth verifying: this session
also found the WASM-GC mode's compiled output loads in the compiler but
outright fails `WebAssembly.instantiate()` in every current browser (see
below), so "the compiler was happy" is not evidence of anything on its own.

- **Primitive arithmetic** — static methods with `int` params/returns.
- **Object allocation, instance fields, virtual dispatch** — `new`,
  constructors, getters, `this.field` reads/writes.
- **Real `String` operations** — `.length()`, `.charAt()` — under the JDK 8
  pipeline above. This is what makes `examples/Hello.java`'s hand-rolled
  `println` possible at all.
- **Exception handling** (`JWebAssembly.WASM_USE_EH = "true"`) — `throw` /
  `try` / `catch` of a user-defined exception type across a real call
  boundary, using native WASM exception-handling instructions (no polyfill
  import needed for this part). Verified: an uncaught-vs-caught branch
  returns different values as expected, in-browser.

## What's broken

Full write-up with repro sources for these four, plus the 20+ other
constructs that were tested and worked fine, is in [`BUGS.md`](BUGS.md):

- **`try { } catch (...) { } finally { }` emits invalid WebAssembly.** Any
  try statement with both a `catch` and a `finally` on it "compiles"
  without error but the emitted `.wasm` fails to even load:
  `CompileError: ... function body must end with "end" opcode`. Plain
  `try/finally` (no catch) and plain `try/catch` (no finally, incl.
  multi-catch and nesting) both work fine — it's specifically the
  combination that's broken. No workaround short of manually restructuring
  every such block.
- **A `NullPointerException` from a null field write isn't thrown by the
  compiled code at all** — it crashes as an unrelated, uncatchable
  `TypeError: Cannot set properties of null` thrown from inside
  JWebAssembly's own JS shim, one layer below the Java program's control
  flow, so `catch (NullPointerException e)` around it never runs.
- **WASM-GC mode is non-functional in every current browser.**
  `JWebAssembly.WASM_USE_GC = "true"` compiles without error, but the
  emitted module uses `rtt.canon` / `struct.new_default_with_rtt` — an
  **obsolete, pre-standardization** encoding of the WASM GC proposal
  (RTT-based typing was dropped before the proposal was finalized). Every
  current browser implements the final spec and rejects this at load time:
  `WebAssembly.instantiate(): invalid value type 0x5`. Confirmed directly in
  Chromium, not inferred from docs. (JWebAssembly's GitHub repo has active,
  unreleased commits migrating to the modern `struct.new` encoding, but none
  of that work is on Maven Central — the last published artifact is `0.4`,
  from 2022.) **The default (non-GC) mode used by this whole directory is
  the only mode that actually runs anywhere.**
- **Default non-GC mode represents every Java object as a plain sealed JS
  object**, with field access routed through JS-imported functions
  (`NonGC.get_i32`, `NonGC.set_i32`, `NonGC.array_get_i32`, ...) that
  JWebAssembly auto-generates into a companion `.wasm.js` shim next to the
  `.wasm` binary — the module cannot be instantiated with just the binary;
  the shim (or an equivalent hand-written import object) is mandatory. This
  is a real, working object model, but it's not what "WASM-GC" usually
  promises (linear-memory-independent, engine-native object representation)
  — it's closer to asm.js-style JS interop with a WASM veneer.
  `array_get_i32`/`array_set_i32` on a `NonGC`-backed typed array also don't
  throw on out-of-bounds access in this mode — they silently no-op/return 0,
  same as raw JS typed-array semantics — so bounds safety isn't real here
  even where EH is enabled; see `../java-wasm-runtime/` for how TeaVM's
  WASM-GC backend makes that catchable as a real `ArithmeticException`
  /`ArrayIndexOutOfBoundsException` instead.
- **No `System.out`/`PrintStream` support at all** under the shipped
  `jwebassembly-api` — the `Thread.currentThread()` dependency in
  `PrintStream`'s init path isn't polyfilled, JDK 8 or not. Any real console
  output has to bypass `System.out` entirely (as `examples/Hello.java` does).
- **`System.in`/`Scanner` are both dead ends, but fixable the same way
  `println` was.** `Scanner` fails to *compile* (`Unsafe.objectFieldOffset`
  used internally, unpolyfilled). Raw `System.in.read()` compiles but
  `System.in` is never initialized (no stdin import hook exists in this
  classlib at all, unlike `../java-wasm-runtime/`'s `readStdinByte()`), so
  it's permanently `null` and crashes the same uncatchable way as the NPE
  bug above. The same custom-`@Import` bypass that makes `println` possible
  also works for input — `bug-hunt/src/T26StdinWorkaround.java` verifies a
  `readbyte` import + hand-rolled `readLine()` end-to-end in a real browser.
  What that doesn't cover: real terminal input is asynchronous but Wasm
  imports are synchronous calls, so wiring this to an actual keyboard would
  need the same `SharedArrayBuffer`/`Atomics.wait` bridge
  `java-wasm-runtime/`'s TeaVM runtime already built for this — reusable as
  a mechanism, not attempted here. See `BUGS.md` #4.
- **No live in-browser Java-source compilation is possible with
  JWebAssembly alone** — see "Architecture" above.

## Comparison with `java-wasm-runtime/` (TeaVM)

| | `java-wasm-runtime/` (TeaVM) | `java-jwebassembly-runtime/` (this dir) |
|---|---|---|
| Input | Java **source**, compiled live in-browser by a real javac (itself compiled to WASM) | Pre-built **.class bytecode**, compiled ahead-of-time on a server/build machine |
| Object model | Real WASM-GC (`struct`/`array` types), modern encoding | Non-GC only — GC mode is broken (obsolete RTT encoding); objects are sealed JS objects behind imported accessor functions |
| `System.out` / `String.format` / printf | Works (patched — see `../java-wasm-runtime/README.md`) | `System.out` unsupported entirely; `String` basics only work with a JDK-8-run toolchain |
| Exceptions | Catchable VM-thrown exceptions (array bounds, div-by-zero, NPE-adjacent cases), patched over several TeaVM bugs | User-thrown/caught exceptions verified working via native WASM EH; VM-level bounds/arithmetic traps are not caught at all in the default mode (see above) |
| stdin | Real terminal stdin + a from-scratch `java.util.Scanner` | `System.in`/`Scanner` both broken, but a custom-import workaround (bypassing both, same pattern as `println`) verified working — see `BUGS.md` #4. Not wired to a real terminal here. |
| Toolchain maturity | Actively maintained upstream (TeaVM), patched here for known WASM-GC backend bugs | Last released **2022** (`0.4`); GC-mode work is unreleased/unpublished |

**Bottom line:** `java-wasm-runtime/` is the right choice for the IDE, and
remains so. JWebAssembly's non-GC mode is a genuinely interesting, working
result — real objects, real strings, real exception handling — but its only
functional object model is a JS-interop shim, its GC mode is unusable in
any current browser, and it fundamentally cannot do what the IDE needs
(compile arbitrary user-typed source live, in the browser). This directory
exists to make that comparison concrete and checkable, not to propose a
swap.

## Layout

```
java-jwebassembly-runtime/
  build.sh              # fetches JWebAssembly 0.4, compiles + runs it under JDK 8
  examples/Hello.java   # the verified demo: println (hand-rolled) + object + String
  tool/Compile.java     # thin driver around the JWebAssembly Java API
  test/run.mjs           # Playwright: instantiates out/hello.wasm in real Chromium
  lib/, classes/, out/  # build outputs, gitignored
```

## Reproducing

```bash
# Prereqs: a real JDK 8 (apt install openjdk-8-jdk-headless, or set JAVA8_HOME),
# network access to Maven Central, Node + Playwright with a Chromium build.
./build.sh
cd test && npm install && node run.mjs
```
