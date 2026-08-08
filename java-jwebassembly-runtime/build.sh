#!/usr/bin/env bash
#
# Builds the Hello.java example through JWebAssembly (de.inetsoftware, NOT
# TeaVM) into a .wasm binary + a JS "NonGC" import shim, and runs a real
# in-browser check with Playwright.
#
# This is an alternate-toolchain exploration, independent of java-wasm-runtime/
# (the TeaVM-based runtime actually wired into the IDE). See README.md for why
# JWebAssembly *cannot* replace it: it compiles pre-built .class files ahead of
# time, not Java source live in the browser.
#
# Prerequisites:
#   1. A genuine JDK 8 install (JAVA8_HOME, or /usr/lib/jvm/java-8-openjdk-amd64).
#      This is not optional and `javac --release 8` on a newer JDK does NOT
#      substitute for it — see "Why JDK 8, specifically" in README.md.
#   2. Network access to Maven Central (repo1.maven.org) to fetch the
#      JWebAssembly 0.4 jars (cached in lib/ after the first run).
#   3. Node + Playwright with a Chromium build available, for test/run.mjs.
#
# Run this script from the java-jwebassembly-runtime/ directory:
#     ./build.sh
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

compiler_jar="lib/jwebassembly-compiler-0.4.jar"
api_jar="lib/jwebassembly-api-0.4.jar"
compiler_sha="ed7b7c39264235c28023b6a170644e3acffd9042281acc524e561ab7afb1c7ed"
api_sha="b84243d55813c9420104d3087c10d7f888b234555d8a30e1c8ef1e54cb068c76"

echo "=== JWebAssembly Hello demo build ==="

# ── 1. Locate a genuine JDK 8 ────────────────────────────────────────────────
java8_home="${JAVA8_HOME:-}"
if [ -z "$java8_home" ] && [ -d /usr/lib/jvm/java-8-openjdk-amd64 ]; then
  java8_home=/usr/lib/jvm/java-8-openjdk-amd64
fi
if [ -z "$java8_home" ] || [ ! -x "$java8_home/bin/javac" ]; then
  echo "ERROR: no JDK 8 found. Set JAVA8_HOME, or: apt install openjdk-8-jdk-headless" >&2
  exit 1
fi
echo "  JAVA8_HOME: $java8_home"
"$java8_home/bin/java" -version

javac8="$java8_home/bin/javac"
java8="$java8_home/bin/java"

# ── 2. Fetch JWebAssembly 0.4 jars (cached, checksum-verified) ─────────────
mkdir -p lib out classes
fetch() {
  local dest="$1" url="$2" want_sha="$3"
  if [ -f "$dest" ] && echo "$want_sha  $dest" | sha256sum -c - >/dev/null 2>&1; then
    return
  fi
  echo "  Fetching $(basename "$dest")..."
  curl -fsSL -o "$dest" "$url"
  echo "$want_sha  $dest" | sha256sum -c -
}
fetch "$compiler_jar" \
  "https://repo1.maven.org/maven2/de/inetsoftware/jwebassembly-compiler/0.4/jwebassembly-compiler-0.4.jar" \
  "$compiler_sha"
fetch "$api_jar" \
  "https://repo1.maven.org/maven2/de/inetsoftware/jwebassembly-api/0.4/jwebassembly-api-0.4.jar" \
  "$api_sha"

# ── 3. Compile the example + the compiler driver, both with real JDK 8 ─────
echo ""
echo "  Compiling examples/Hello.java (JDK 8)..."
"$javac8" -encoding UTF-8 -cp "$api_jar" -d classes examples/Hello.java

echo "  Compiling tool/Compile.java (JDK 8)..."
"$javac8" -encoding UTF-8 -cp "$compiler_jar:$api_jar" -d classes tool/Compile.java

# ── 4. Run the JWebAssembly compiler itself under JDK 8 ────────────────────
# This matters, not just the input .class file's origin: JWebAssembly
# resolves supporting JDK classes (java.lang.String, etc.) from whichever
# JVM is running the compiler. Run it under JDK 25 and String methods pull in
# Unsafe-based internals JWebAssembly's classlib polyfills don't cover.
echo ""
echo "  Running JWebAssembly compiler (JDK 8)..."
"$java8" -Djwebassembly.api.jar="$api_jar" \
  -cp "classes:$compiler_jar:$api_jar" \
  Compile Hello.class classes out/hello.wasm

echo ""
echo "  Output: out/hello.wasm + out/hello.wasm.js"
echo ""
echo "  Run 'node test/run.mjs' (requires Playwright) to verify it in a real browser."
