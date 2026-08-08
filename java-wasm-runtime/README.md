> **Fork note (browser-ide):** this is a fork of
> [konsoletyper/teavm-javac](https://github.com/konsoletyper/teavm-javac)
> vendored into this repo so the WASM Java compiler used by `client/`'s
> Java runner is built here from real OpenJDK source, rather than trusted
> as a pre-built binary downloaded from teavm.org.
>
> Build-environment changes from upstream, none of which change what gets
> built (network workarounds only):
> - `settings.gradle` drops the `teavm.org` custom Maven repo — everything
>   it was needed for (TeaVM 0.13.1, ASM 9.8) is on Maven Central.
> - `javac/build.gradle` can source the pinned OpenJDK commit from a local
>   git checkout (`javac/jdk-src-cache/`, gitignored) instead of downloading
>   a zip from GitHub's archive endpoint, falling back to the original
>   download when that cache is absent.
> - The `ui/` module (upstream's standalone CodeMirror-based playground) is
>   dropped — this repo already has its own IDE UI in `client/`, and only
>   `:compiler:build` (the `javac`, `protocol`, `compiler` modules) is used.
>
> Behavioral changes from upstream, fixing real gaps found in testing
> (both are declaration/protocol-only — no TeaVM core or classlib code is
> touched, so this stays within teavm-javac's own project):
> - `compiler/.../StdlibConverter.java` — the compile-time SDK classlib
>   TeaVM's `teavm-classlib` exposes final/native real-JDK methods (like
>   `Throwable.getMessage()`, `Object.getClass()`) only under a "0"-suffixed
>   name (`getMessage0()`) that TeaVM's own WASM codegen knows to route to,
>   but this converter never re-exposed under the real name — so javac
>   rejected any call to e.g. `e.getMessage()`. `visitEnd()` now emits a
>   declaration-only alias (this archive is stripped of method bodies
>   already) under the real name wherever one doesn't already exist,
>   fixing this for every class, not just Throwable.
> - `protocol/CompileMessage.java` + `compiler/.../Worker.java` — the
>   simple worker protocol's `compile` command took one source file
>   (hardcoded to `Main.java`); the underlying `Compiler` API already
>   supported adding several. Added a `files: {path, content}[]` field
>   (the old single-`text` field still works as a fallback) so a workspace
>   with multiple `.java` files compiles them together — one may reference
>   another, so long as exactly one file has a `main` method.
>
> Behavioral changes that DO touch TeaVM's own core/classlib (via
> `teavm-patch/` — see that directory's README for the full explanation of
> each patch, and why patching TeaVM itself was necessary instead of
> working around it from this fork alone):
> - `printf`/`String.format` calls using a `%f`/float conversion used to
>   crash at runtime with a WASM-GC backend null-deref bug in
>   `TDecimalFormat`'s symbol-cloning code; patched in `teavm-classlib`.
>   The `%n` conversion, entirely unimplemented, was added too.
> - Array-bounds exceptions (`ArrayIndexOutOfBoundsException`) are now
>   catchable by user `try`/`catch`. Two separate bugs combined to make
>   these uncatchable: (1) `teavm-core`'s `BoundCheckInsertion` pass
>   incorrectly elided the bounds check whenever both the index and array
>   size were compile-time constants, without checking whether the index
>   was actually in range — so a literal out-of-bounds access like
>   `new int[3]` then `arr[5]` fell through to a raw, uncatchable WASM
>   trap instead of TeaVM's managed exception-throwing check; and
>   (2) `WasmGCTarget`'s own `strict` flag (which gates whether bounds/null
>   checks are inserted at all, separate from `DependencyAnalyzer`'s
>   similarly-named flag) defaults to `false` and was never being set —
>   fixed in `compiler/.../Compiler.java` (`target.setStrict(true)`) plus a
>   `compiler/build.gradle` fix for a Gradle dependency-resolution bug that
>   was silently discarding the patched `teavm-core` in favor of the real
>   unpatched one (`teavm-tooling` transitively depends on plain `0.13.1`,
>   and Gradle ranks an unsuffixed version higher than a suffixed one).
>
> - Calling `e.getMessage()` on a caught VM-thrown exception (array-bounds,
>   implicit null pointer, etc. — as opposed to one the program throws
>   itself) used to crash with `"dereferencing a null pointer"`, even though
>   the `catch` itself worked fine. Root cause: TeaVM's WASM-GC backend only
>   gave a method a real vtable implementor if its own whole-program
>   devirtualization pass had independently flagged that method as needing
>   virtual dispatch — but `Throwable.getMessage()` is never overridden
>   anywhere, so devirtualization correctly decided nothing needs a
>   *virtual* call to `Throwable`'s own copy, while the backend's separate
>   per-call-site scan still allocated `ArrayIndexOutOfBoundsException` its
>   own vtable entry for `getMessage()` (since `e`'s static type at the call
>   site is the concrete exception class, not `Throwable`) — leaving that
>   entry's implementor permanently null. Fixed in
>   `teavm-patch/core/gc/vtable/WasmGCVirtualTableBuilder.java`; see that
>   directory's README for the full writeup.
> - Integer divide-by-zero and modulo-by-zero (`5 / 0` where the divisor
>   comes from a variable, computed value, etc. — not a source-literal
>   constant) now throw a catchable `ArithmeticException` instead of hard
>   crashing with an uncatchable raw Wasm trap. This needed genuinely new
>   codegen (TeaVM's WASM-GC backend had no existing check-and-throw
>   mechanism for arithmetic at all, unlike array bounds) plus a
>   `WasmGCDependencies` fix for a `getMessage()`-shaped reachability gap
>   that otherwise broke `ArithmeticException`'s own Wasm-GC struct
>   generation. See `teavm-patch/README.md` for the three-part writeup.
> - `System.in` now reads real terminal input instead of always throwing
>   `EOFException`, wired to the same `SharedArrayBuffer`/`Atomics.wait`
>   synchronous stdin bridge (`client/src/workers/stdin-bridge.ts`) the
>   C/C++ and Python workers already used — the Java worker just wasn't
>   passing it through. `java.util.Scanner` — entirely absent from TeaVM's
>   classlib, not merely broken — is now implemented from scratch, reading
>   bytes directly off `System.in` and decoding UTF-8 by hand rather than
>   going through `BufferedReader`/`InputStreamReader` (which don't compile
>   at all for Wasm-GC — see `teavm-patch/README.md`). Covers
>   next/nextLine/nextInt/nextLong/nextDouble/nextFloat/nextBoolean, their
>   hasNextXxx() forms, and both `Scanner(System.in)` (blocks for more
>   input; there's no stdin-close affordance in this terminal, so it never
>   really hits EOF) and `Scanner(String)` (finite content, real EOF).
>
> Known remaining gaps (real, but need changes to TeaVM's own core/classlib
> beyond what's patched so far — out of scope for now): `BufferedReader`/
> `InputStreamReader` over `System.in` still don't compile for Wasm-GC — a
> `java.nio` (`TByteBuffer`/`TCharBuffer`) limitation, not something fixed
> by the stdin/Scanner work above (`Scanner` is the supported way to read
> stdin in this runtime for now); a *literal* constant division like
> `5 / 0` written directly in source still crashes with the old uncatchable
> raw trap — the divide-by-zero fix above only covers the general
> (non-literal-constant) case, and something upstream of normal codegen
> handles literal-constant divisions differently in a way not yet
> root-caused; and `e.toString()` /
> `e.getClass().getName()` on a VM-thrown exception still crash — a
> *different, deeper* bug than the `getMessage()` one just fixed.
> `Throwable.toString()`'s body is stripped entirely by TeaVM's main
> dependency analyzer before the WASM-GC backend ever runs, because that
> analyzer (unlike the backend's own call-site scan) never recognized
> `e.toString()` on a catch-bound variable as real usage — so there's no
> body left for the backend to wire up, and the `getMessage()` fix can't
> help. Fixing this means changing the shared, cross-backend dependency
> analyzer's handling of exception values flowing out of `catch` blocks, not
> just the WASM-GC backend module patched so far — meaningfully bigger and
> riskier, so not attempted. All gaps here were confirmed present in the
> original teavm.org-hosted binary too (except the array-bounds,
> `getMessage()`, divide-by-zero, and stdin/`Scanner` fixes above), i.e.
> pre-existing upstream limitations, not regressions introduced by this fork.
>
> Run `./build.sh` from this directory to rebuild; see that script for
> prerequisites. Output goes to `../client/public/runtimes/teavm-javac/25/`,
> which is committed to the repo (see `client/runtimes.json`'s `teavm-javac`
> entry, `source: "local"`) — same pattern as `csharp-wasm-runtime/`.
>
> Everything below this note is upstream's original README.

An offline Java compiler that runs in the browser.

This is two compilers in one WebAssembly module:

* Java compiler from OpenJDK
* [TeaVM](https://teavm.org).

Both are compiled into JAR with TeaVM.

See in action: https://teavm.org/playground.html


## Running example locally

```
./gradlew :ui:appRunWar
```

## Building

```
./gradlew :ui:war
```

Resulting `.war` file can be found in `ui/build/libs`.


## Using as a library

The latest WebAssembly module can be found here: https://teavm.org/playground/compiler.wasm

You should load it with TeaVM WebAssembly runtime. For example:

```js
import { load } from "./compiler.wasm-runtime.js";

let teavm = await load("./compiler.wasm");
let compilerLib = teavm.exports;
```

where compilerLib is `CompilerLibrary` object defined as follows:

```ts
declare interface CompilerLibrary {
    createCompiler(): Compiler
    installWorker()
} 
```

where `installWorker` is a convenience function that installs simple worker protocol which is described below.

`Compiler` is defined as follows:

```ts
declare class Compiler {
    addSourceFile(path: string, content: string)
    
    clearSourceFiles()
    
    // This can be not only `.class` file, but any file, e.g. some resources
    addClassFile(path: string, content: Int8Array)
    
    // Content is supposed to be a zip archive containing number of class files
    // It's equivalent for unpacking files from archive and passing each 
    // file to `addClassFile`
    addJarFile(content: Int8Array)
    
    clearInputClassFiles()
    
    // Set archive that includes definitions of standard Java library,
    // necessary for javac. This archive is generated with special tool,
    // the latest version can be found here: 
    // https://teavm.org/playground/compile-classlib-teavm.bin
    setSdk(content: Int8Array)

    // Set archive that includes implementation of standard Java library,
    // necessary for TEaVM. This archive is generated with special tool,
    // the latest version can be found here: 
    // https://teavm.org/playground/runtime-classlib-teavm.bin
    setTeaVMClasslib(content: Int8Array)

    onDiagnostic(listener: (Diagnostic) => void): ListenerRegistration;

    // Takes given source files and given input binary class files as dependencies.
    // 
    // Returns `true` if compilation was successful.
    // During execution may call listeners, passed to `onDiagnostic` method
    // when compiler finds any error in input files.
    compile(): boolean
    
    // Returns list of class files, produced by Java compiler
    listOutputFiles: string[]

    // Gets file, produced by Java compiler or 'null', if none found with given name
    getOutputFile(name: string): Int8Array

    // Gets all files, produced by Java compiler, as a zip archive
    getOutputJar(): Int8Array
    
    // Add class file to output files.
    // This can be useful when using this library only to produce WebAssembly 
    // from existing class files
    addOutputClassFile(path: string, content: Int8Array)

    // Content is supposed to be a zip archive containing number of class files
    // It's equivalent for unpacking files from archive and passing each 
    // file to `addOutputClassFile`
    addOutputJarFile(content: Int8Array)

    clearOutputFiles(): Int8Array

    // Finds classes that contain valid `main` method among output class files.
    detectMainClasses(): string[]

    // Takes given output class files (either produced by calling `compile` 
    // or written manually).
    // 
    // Returns `true` if compilation was successful.
    // During execution may call listeners, passed to `onDiagnostic` method
    // when compiler finds any error in input files.
    generateWebAssembly(options: {
        outputName: string, // base name for WebAssembly module
        mainClass: string, 
    }): boolean

    listWebAssemblyOutputFiles(): string[]
    getWebAssemblyOutputFile(path: string): Int8Array
    
    // Gets WebAssembly output files as a zip archive
    getWebAssemblyOutputArchive(): Int8Array
}
```

where 

```ts
declare class ListenerRegistration {
    destroy()
}

declare class Diagnostic {
    type: "javac" | "teavm"
    severity: "error" | "warning" | "other"
    fileName: string
    lineNumber: number
    message: string
}
declare class JavaDiagnostic extends Diagnostic {
    type: "javac"
    columnNumber: number
    startPosition: number
    position: number
    endPosition: number
}
declare class TeaVMDiagnostic extends Diagnostic {
    type: "teavm"
}
```

Please note that methods, that are supposed to add a file, overwrite existing files.

simple example:

```ts
let response = await fetch("https://teavm.org/playground/compile-classlib-teavm.bin");
compiler.setSdk(new Int8Array(await response.arrayBuffer()));

response = await fetch("https://teavm.org/playground/compile-classlib-teavm.bin");
compiler.setTeaVMClasslib(new Int8Array(await response.arrayBuffer()));

compiler.onDiagnostic(diagnostic => {
    console.log(diagnostic.type, diagnostic.severity, diagnostic.fileName, diagnostic.lineNumber,
        diagnostic.message);
});

compiler.addSourceFile("Main.java", HELLO_WORLD_JAVA_CODE);
compiler.compile();
compiler.generateWebAssembly({
    outputName: "app",
    mainClass: "Main"
});
let generatedWasm = compiler.getWebAssemblyOutputFile("app.wasm");

let outputTeaVM = await load(generatedWasm);
outputTeaVM.exports.main([]);
```

In a more complex scenario, you can re-use existing compiler instance without passing SDK and classlib again.
This should also make repeated compilation faster, since compilers can re-use results of previous builds.


### Using simple worker

When the worker initializes, it sends the following message to the page:

```js
{
    command: "initialized"
}
```

When you send a message to the worker, you should pass additional `id` property,
worker will tag its responses to given request with the same `id`.

Available requests:

```js
{
    command: "load-classlib",
    url: "URL of Java class library for javac",
    runtimeUrl: "URL of Java class library for TeaVM"
}
```

which is responded with

```js
{
    command: "ok"
}
```

upon completion, and 

```js
{
    command: "compile",
    text: "text of Main.java"
}
```

which is responded with:

```js
{
    command: "compilation-complete",
    status: "successful" | "errors"
    script: result /* Int8Array, containing WebAssembly module, if successful */
}
```

Additionally, worker sends the following messages during compilation:

```js
{
    command: "compiler-diagnostic" | "diagnostic",
    severity: "error" | "warning" | "other",
    fileName: string,
    lineNumber: number,
    // etc, see JavaDiagnostic and TeaVMDiagnostic
}
```

where `compiler-diagnostic` stands for "Java compiler diagnostic" and `diagnostic` stands for
"TeaVM diagnostic"


### Building library from sources

You need Java 21 installed on your machine.

Run

```
./gradlew :compiler:build
```

Library can be found at `compiler/build/distributions/dist.zip`.


## Roadmap

* ~~Document compiler library API~~
* Run TeaVM tests against this compiler
* Java parsing/AST attribution API
* Semantic highlighting and autocompletion


## License

This project is licensed under the Apache License 2.0.

NOTICE: This project uses components from the OpenJDK project, which is licensed under
the GNU General Public License v2 with the Classpath Exception.
See: https://openjdk.org/legal/gplv2+ce.html

No code from OpenJDK is modified or included in source form in this project.
During the build process, OpenJDK source code may be downloaded and compiled into bytecode
for inclusion in the final WebAssembly output, as permitted by the Classpath Exception.