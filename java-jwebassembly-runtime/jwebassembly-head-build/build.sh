#!/usr/bin/env bash
#
# Builds jwebassembly-compiler + jwebassembly-api from pinned upstream source
# commits (NOT the stale 0.4 release on Maven Central) and writes the two
# jars into ../lib/. See README.md in this directory for why: 0.4 (2022) has
# real, confirmed bugs that these specific upstream commits fix.
#
# Neither repo ships a Gradle wrapper, and jwebassembly-compiler's own
# build.gradle depends on a jitpack.io snapshot of the API jar that may not
# be reachable from every network policy, so this compiles both repos
# directly with javac instead of running their Gradle builds. Both repos'
# main sourceSet is a flat `src/` tree with no non-.java resources, so this
# is equivalent to what Gradle would produce, checked empirically against
# every test in ../bug-hunt/ (compiles clean, no behavior differences from
# what a real `gradle jar` would need to do beyond what's here).
#
# Prerequisites: a genuine JDK 8 (JAVA8_HOME or /usr/lib/jvm/java-8-openjdk-amd64
# — same as ../build.sh), network access to github.com (git) and Maven
# Central (jsr305 + asm, both real small transitive deps of the two repos).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

compiler_commit="9d08f5c175405783a891d74a872a43f500c034e3"
api_commit="d52979ad607212e5c1c4bc5cfd11822aa626544f"

java8_home="${JAVA8_HOME:-}"
if [ -z "$java8_home" ] && [ -d /usr/lib/jvm/java-8-openjdk-amd64 ]; then
  java8_home=/usr/lib/jvm/java-8-openjdk-amd64
fi
if [ -z "$java8_home" ] || [ ! -x "$java8_home/bin/javac" ]; then
  echo "ERROR: no JDK 8 found. Set JAVA8_HOME, or: apt install openjdk-8-jdk-headless" >&2
  exit 1
fi
javac8="$java8_home/bin/javac"
jar8="$java8_home/bin/jar"

echo "=== JWebAssembly (HEAD) build ==="

mkdir -p src-cache deps ../lib
compiler_src="src-cache/JWebAssembly"
api_src="src-cache/JWebAssembly-API"

fetch_repo() {
  local dir="$1" url="$2" commit="$3"
  if [ -d "$dir/.git" ]; then
    echo "  Using cached $(basename "$dir") checkout"
    return
  fi
  echo "  Fetching $(basename "$dir") @ ${commit:0:12}..."
  rm -rf "$dir"
  mkdir -p "$dir"
  git init -q "$dir"
  git -C "$dir" remote add origin "$url"
  git -C "$dir" fetch --depth 1 origin "$commit"
  git -C "$dir" checkout -q FETCH_HEAD
}
fetch_repo "$compiler_src" "https://github.com/i-net-software/JWebAssembly.git" "$compiler_commit"
fetch_repo "$api_src" "https://github.com/i-net-software/JWebAssembly-API.git" "$api_commit"

fetch_jar() {
  local dest="$1" url="$2"
  [ -f "$dest" ] && return
  echo "  Fetching $(basename "$dest")..."
  curl -fsSL -o "$dest" "$url"
}
fetch_jar deps/jsr305-3.0.1.jar \
  "https://repo1.maven.org/maven2/com/google/code/findbugs/jsr305/3.0.1/jsr305-3.0.1.jar"
fetch_jar deps/asm-9.8.jar \
  "https://repo1.maven.org/maven2/org/ow2/asm/asm/9.8/asm-9.8.jar"

# ── jwebassembly-api: everything except the emulator/ package, which needs
# JavaFX (a desktop standalone-emulator GUI, irrelevant to compiling Java to
# a .wasm file and running it in a real browser — nothing else depends on it).
echo ""
echo "  Compiling jwebassembly-api..."
rm -rf classes-api
mkdir -p classes-api
find "$api_src/src" -name '*.java' -not -path '*/emulator/*' > api-sources.txt
"$javac8" -encoding UTF-8 -nowarn \
  -cp "deps/jsr305-3.0.1.jar:deps/asm-9.8.jar" \
  -d classes-api @api-sources.txt
(cd classes-api && "$jar8" cf "../../lib/jwebassembly-api-head.jar" -C . .)

# ── jwebassembly-compiler: compileOnly-depends on the API jar just built.
echo "  Compiling jwebassembly-compiler..."
rm -rf classes-compiler
mkdir -p classes-compiler
find "$compiler_src/src" -name '*.java' > compiler-sources.txt
"$javac8" -encoding UTF-8 -nowarn \
  -cp "deps/jsr305-3.0.1.jar:../lib/jwebassembly-api-head.jar" \
  -d classes-compiler @compiler-sources.txt
(cd classes-compiler && "$jar8" cf "../../lib/jwebassembly-compiler-head.jar" -C . .)

echo ""
echo "  Built: ../lib/jwebassembly-compiler-head.jar, ../lib/jwebassembly-api-head.jar"
