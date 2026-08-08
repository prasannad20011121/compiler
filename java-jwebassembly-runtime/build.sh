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
#   2. Network access to github.com (git) and Maven Central (repo1.maven.org)
#      — jwebassembly-head-build/build.sh builds the compiler+api jars from
#      pinned upstream source commits, not the stale 0.4 release; see that
#      directory's README for why.
#   3. Node + Playwright with a Chromium build available, for test/run.mjs.
#
# Run this script from the java-jwebassembly-runtime/ directory:
#     ./build.sh
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

compiler_jar="lib/jwebassembly-compiler-head.jar"
api_jar="lib/jwebassembly-api-head.jar"

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

# ── 2. Build JWebAssembly compiler+api from pinned upstream source ─────────
mkdir -p lib out classes
echo ""
echo "  Building JWebAssembly from source (see jwebassembly-head-build/README.md)..."
./jwebassembly-head-build/build.sh

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
