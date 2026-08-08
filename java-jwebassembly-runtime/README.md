# java-jwebassembly-runtime

An **alternate-toolchain exploration**: compiling Java to WebAssembly with
[JWebAssembly](https://github.com/i-net-software/JWebAssembly)
(`de.inetsoftware:jwebassembly-compiler`), instead of TeaVM (used by
`../java-wasm-runtime/`, the runtime actually wired into the IDE).

**This does not replace `java-wasm-runtime/` and is not wired into the
client.** It's a separate, honest evaluation of a fundamentally different
architecture, kept on its own branch. See "Why this can't replace
java-wasm-runtime" below before assuming otherwise.

This runtime builds JWebAssembly from a **pinned unreleased upstream
commit**, not the `0.4` release on Maven Central — testing against `0.4`
found a severe bug (`try/catch/finally` emitting invalid WebAssembly) that
was already fixed upstream but never released. See
[`jwebassembly-head-build/README.md`](jwebassembly-head-build/README.md)
for exactly which commits and why, and [`BUGS.md`](BUGS.md) for the full
bug-hunt writeup: what got fixed by that upgrade, what's still broken, and
what's improved but not release-ready.

## Quick start

```bash
./build.sh                 # needs a real JDK 8, see below — writes out/hello.wasm
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

JWebAssembly resolves supporting JDK classes like `java.lang.String` from
**whichever JVM is running the JWebAssembly compiler itself** — not from
whatever JDK originally compiled the input `.class` file. Compile a source
file with `javac --release 8` on a modern JDK and the `.class` file's
bytecode is release-8-shaped, but the JVM running JWebAssembly still
resolves `java.lang.String.class` from its own runtime. Under JDK 17+
(including 25), `String` methods route through
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
`javac` and `java` (to run the compiler, and to build JWebAssembly itself —
see `jwebassembly-head-build/`) come from `JAVA8_HOME`.

This is also why `System.out.println` still doesn't compile even under
JDK 8 — `PrintStream`'s `Thread.currentThread()` dependency chain isn't
polyfilled by `jwebassembly-api` at all, JDK version notwithstanding.
`examples/Hello.java` works around this with a hand-written `print`/`println`
built on a custom `@Import`-based `putChar`, mirroring the
`WasmGCSupport.putCharStdout` pattern from the TeaVM runtime.

## What's verified working (real browser, not just "compiles")

All of the following were checked by actually instantiating the compiled
`.wasm` in Chromium via Playwright and asserting on results — not just that
`compileToBinary` didn't throw; a "the compiler was happy" result is not
evidence of anything on its own (WASM-GC mode's compiled output, for
instance, loads fine in the compiler but failed `WebAssembly.instantiate()`
outright under `0.4`, and still has its own runtime bugs under HEAD — see
below).

- **Primitive arithmetic** — static methods with `int` params/returns.
- **Object allocation, instance fields, virtual dispatch** — `new`,
  constructors, getters, `this.field` reads/writes (in the default non-GC
  mode; virtual dispatch through an array is broken in GC mode, see below).
- **Real `String` operations** — `.length()`, `.charAt()` — under the JDK 8
  pipeline above. This is what makes `examples/Hello.java`'s hand-rolled
  `println` possible at all.
- **Exception handling** (`JWebAssembly.WASM_USE_EH = "true"`) — `throw` /
  `try` / `catch` of a user-defined exception type across a real call
  boundary, including `try/catch/finally` together (broken under `0.4`,
  fixed by building from HEAD — see `BUGS.md`), multi-catch, and nested
  try/catch — all verified returning the correct value in-browser.
- **stdin, via a workaround** — `System.in`/`Scanner` are both broken (see
  below), but the same custom-`@Import` bypass used for `println` also
  works for input: verified end-to-end with a `readbyte` import and a
  hand-rolled `readLine()`. See `BUGS.md`'s stdin section.

## What's broken

Full write-up with repro sources for all of these, plus the 25+ other
constructs that were tested and worked fine, is in [`BUGS.md`](BUGS.md):

- **A `NullPointerException` from a null field write isn't thrown by the
  compiled code at all**, in the default non-GC mode — it crashes as an
  unrelated, uncatchable `TypeError: Cannot set properties of null` thrown
  from inside JWebAssembly's own JS shim, one layer below the Java
  program's control flow, so `catch (NullPointerException e)` around it
  never runs. GC mode doesn't fix this either — it fails differently (a
  module load error on this specific null-ternary pattern).
- **Array out-of-bounds access is silently wrong instead of throwing**, in
  the default non-GC mode — `arr[5]` on a 3-element array just returns `0`
  silently, both for reads and writes, even with `WASM_USE_EH=true`. GC
  mode does turn this into a real trap, but an uncatchable one (a raw WASM
  `RuntimeError`, not a Java exception) — see below.
- **`Scanner` doesn't compile at all** — confirmed a dead end even with a
  newly-tried `IGNORE_NATIVE` escape hatch that stubs out most unpolyfilled
  native methods; `Scanner`'s dependency chain hits one JDK-internal
  `Unsafe` call that can't be stubbed. Raw `System.in.read()` compiles but
  crashes the same uncatchable way as the NullPointerException bug above,
  since `System.in` is never initialized by JWebAssembly's classlib at all.
  The `println`-style custom-`@Import` bypass works around this (see
  "What's verified working" above) but there's no way to use `System.in`
  or `Scanner` directly.
- **WASM-GC mode loads in a real browser now (this was fixed by building
  from HEAD instead of `0.4`), but has its own new bugs that make it
  unusable as a default:** array bounds violations trap as an uncatchable
  raw WASM error rather than a catchable Java exception; virtual/interface
  dispatch through an array of a common supertype crashes at runtime
  (`RuntimeError: null function or function signature mismatch`); and
  combining GC mode with exception handling can fail to even *load*
  (`tag signature ... has non-void return`). None of these were attempted
  as fixes — real compiler work in code the upstream maintainer is still
  actively reworking. **The default (non-GC) mode remains what this whole
  directory uses**, same as before.
- **No `System.out`/`PrintStream` support at all** under the shipped
  `jwebassembly-api` — the `Thread.currentThread()` dependency in
  `PrintStream`'s init path isn't polyfilled, JDK 8 or not. Any real console
  output has to bypass `System.out` entirely (as `examples/Hello.java` does).
- **No live in-browser Java-source compilation is possible with
  JWebAssembly alone** — see "Architecture" above.

## Comparison with `java-wasm-runtime/` (TeaVM)

| | `java-wasm-runtime/` (TeaVM) | `java-jwebassembly-runtime/` (this dir) |
|---|---|---|
| Input | Java **source**, compiled live in-browser by a real javac (itself compiled to WASM) | Pre-built **.class bytecode**, compiled ahead-of-time on a server/build machine |
| Object model | Real WASM-GC (`struct`/`array` types), modern encoding, in production use | Default mode: objects are sealed JS objects behind imported accessor functions. GC mode now loads (fixed vs. `0.4`) but has its own new bugs — vtable dispatch and EH-tag bugs — not usable as default |
| `System.out` / `String.format` / printf | Works (patched — see `../java-wasm-runtime/README.md`) | `System.out` unsupported entirely; `String` basics only work with a JDK-8-run toolchain |
| Exceptions | Catchable VM-thrown exceptions (array bounds, div-by-zero, NPE-adjacent cases), patched over several TeaVM bugs | try/catch/finally now works (fixed vs. `0.4`); VM-thrown exceptions (null deref, array bounds) still uncatchable in default mode; GC mode traps them but not catchably |
| stdin | Real terminal stdin + a from-scratch `java.util.Scanner` | `System.in`/`Scanner` both broken, but a custom-import workaround (bypassing both, same pattern as `println`) verified working — see `BUGS.md`. Not wired to a real terminal here. |
| Toolchain maturity | Actively maintained upstream (TeaVM), patched here for known WASM-GC backend bugs | No tagged release since `0.4` (2022); this runtime builds from a pinned unreleased commit instead — see `jwebassembly-head-build/README.md` |

**Bottom line:** `java-wasm-runtime/` is the right choice for the IDE, and
remains so. JWebAssembly is a genuinely interesting, partially-working
result — real objects, real strings, real exception handling including
try/catch/finally, and (as of building from HEAD) a WASM-GC mode that at
least loads — but its only *reliable* object model is still the JS-interop
shim, GC mode has real bugs of its own beyond just loading, and it
fundamentally cannot do what the IDE needs (compile arbitrary user-typed
source live, in the browser). This directory exists to make that
comparison concrete and checkable, not to propose a swap.

## Layout

```
java-jwebassembly-runtime/
  build.sh                  # builds JWebAssembly from source, then the Hello demo, under JDK 8
  jwebassembly-head-build/  # builds JWebAssembly compiler+api from a pinned upstream commit
  examples/Hello.java       # the verified demo: println (hand-rolled) + object + String
  tool/Compile.java         # thin driver around the JWebAssembly Java API
  test/run.mjs               # Playwright: instantiates out/hello.wasm in real Chromium
  bug-hunt/                 # 25+ regression tests + the specific bug repros in BUGS.md
  lib/, classes/, out/      # build outputs, gitignored
```

## Reproducing

```bash
# Prereqs: a real JDK 8 (apt install openjdk-8-jdk-headless, or set JAVA8_HOME),
# network access to github.com + Maven Central, Node + Playwright with a Chromium build.
./build.sh
cd test && npm install && node run.mjs
```
