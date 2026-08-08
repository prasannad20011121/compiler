# Why this builds from source instead of using the 0.4 release

The only JWebAssembly version published to Maven Central is `0.4`, from
2022. Testing against it (see `../BUGS.md`'s original findings) found a
severe bug: any `try { } catch (...) { } finally { }` compiles without
error but produces a `.wasm` binary that fails to even load
(`CompileError: ... function body must end with "end" opcode`) — a
correctness-breaking defect on ordinary, ubiquitous Java code, not an edge
case.

Checking upstream turned up 161 commits since the `v0.4` tag, still
unreleased, including one that looks directly relevant:
`c6fc938 Give CATCH blocks the right order with finally most outer block.`
Building from that commit and re-running every test in `../bug-hunt/`
confirmed it: **the try/catch/finally bug is fixed on HEAD.** Nothing else
in the 25+ program regression suite changed behavior — same results as 0.4
everywhere else, no new failures introduced.

The same HEAD also switches JWebAssembly's exception handling from the old
experimental WASM 1.0 EH proposal to the finalized WebAssembly 3.0 encoding
(`1aa78d1`), and modernizes WASM-GC output from the obsolete RTT-based
encoding (`rtt.canon`, removed from the GC proposal before it was
finalized) to the real `struct.new`/recursive-type encoding current
browsers actually implement (`e461d67`, `d73e769`, `f003c09`). That
GC-mode work is what makes `WASM_USE_GC=true` output load in a real browser
at all now — 0.4's GC output was confirmed to fail
`WebAssembly.instantiate()` outright in every current browser. It's not a
finished fix, though — see `../BUGS.md` for what specifically still breaks
in GC mode (a virtual-dispatch bug and an EH-tag-signature bug, both new,
neither present in 0.4's default non-GC mode because 0.4's GC mode never
got far enough to hit them).

## What's pinned and why

Two repos, two commits, both the tip of each repo's default branch as of
this investigation (2026-08-08) — there's no tagged pre-release between 0.4
and HEAD to pin to instead:

- `i-net-software/JWebAssembly` @ `9d08f5c175405783a891d74a872a43f500c034e3`
- `i-net-software/JWebAssembly-API` @ `d52979ad607212e5c1c4bc5cfd11822aa626544f`

Pinned to exact commits, not a branch name, so this build is reproducible
and doesn't silently pick up whatever upstream has changed to by the next
`./build.sh` run — upgrading the pin is a deliberate, separate decision
(re-run the full `../bug-hunt/` suite before doing so).

## Why direct `javac`, not each repo's own Gradle build

Neither repo ships a Gradle wrapper, and `JWebAssembly`'s own
`build.gradle` depends on a `jitpack.io` snapshot build of the API jar
(`com.github.i-net-software:JWebAssembly-API:master-SNAPSHOT`) that may not
be reachable from every network policy. Both repos' main source is a flat
`src/` tree with no non-`.java` resources bundled into the jar, so
compiling directly with `javac` and jarring the output is equivalent to
what running their real Gradle build would produce — this was checked
empirically, not assumed: every test in `../bug-hunt/` behaves identically
whether compiled this way.

One directory is excluded: `JWebAssembly-API`'s `emulator/` package (a
standalone JavaFX desktop GUI for running `.wasm` output outside a browser)
depends on JavaFX, which isn't a JDK 8 platform module and isn't needed for
anything this runtime does — compiling to a `.wasm` file and running it in
a real browser never touches that package.

## Reproducing

```bash
./build.sh    # writes ../lib/jwebassembly-compiler-head.jar, ../lib/jwebassembly-api-head.jar
```

Safe to re-run — the source checkouts (`src-cache/`) and dependency jars
(`deps/`) are cached after the first run. Delete `src-cache/` to force a
re-fetch (e.g. after changing the pinned commits above).
