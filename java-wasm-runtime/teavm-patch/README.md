# TeaVM classlib patch

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

## Rebuilding

`../build.sh` calls `apply.sh` in this directory automatically, which:
1. Clones `konsoletyper/teavm` at the `0.13.1` tag (git, not the archive-zip endpoint — same
   reasoning as the OpenJDK source fetch documented in the main fork note).
2. Copies the patched files in `classlib/` over the corresponding paths in that checkout.
3. Publishes `core` and `classlib` to `mavenLocal()` as version `0.13.1-patched1`.

`../gradle/libs.versions.toml` points `teavm-core`/`teavm-classlib` at that version
specifically (a separate `teavmPatched` version variable) — everything else (`teavm-tooling`,
`teavm-jso*`, `teavm-interop`, `teavm-platform`, the Gradle plugin) stays on the real
published `0.13.1`, since only these two modules were patched.
