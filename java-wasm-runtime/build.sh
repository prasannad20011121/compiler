#!/usr/bin/env bash
#
# Builds the teavm-javac WASM compiler (real javac, built from OpenJDK source,
# run through TeaVM to WASM-GC) and copies the output into the browser-ide
# public/runtimes folder.
#
# Prerequisites:
#   1. JDK 25   -> apt install openjdk-25-jdk (or https://jdk.java.net/25/)
#   2. Network access to Maven Central and github.com (git, not just https).
#
# This is a fork of konsoletyper/teavm-javac (Apache-2.0) with several changes,
# explained inline where they're made and in this directory's README.md:
#   - settings.gradle no longer lists the teavm.org custom Maven repo. Every
#     artifact this build actually needs (TeaVM 0.13.1, ASM 9.8) is on Maven
#     Central; some sandboxed environments block teavm.org specifically.
#   - javac/build.gradle can source the pinned OpenJDK commit from a local
#     git checkout (javac/jdk-src-cache/) instead of downloading a zip from
#     GitHub's archive endpoint, which some sandboxed environments also block
#     even though git's own smart-HTTP protocol goes through fine.
#   - teavm-patch/ builds a patched TeaVM core+classlib from source and
#     publishes it to mavenLocal (see teavm-patch/README.md) — works around a
#     WASM-GC backend bug that crashed every printf/String.format call using
#     a float conversion, and adds missing %n format-specifier support.
#
# Run this script from the java-wasm-runtime/ directory:
#     ./build.sh
#
# The resulting WASM module + classlib archives are written to:
#     ../client/public/runtimes/teavm-javac/<version>/
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

revision=$(grep '^jdk.revision=' gradle.properties | cut -d= -f2)
out_dir="$script_dir/../client/public/runtimes/teavm-javac/25"

echo "=== teavm-javac WASM build ==="

# ── 1. Verify prerequisites ─────────────────────────────────────────────────
if ! command -v java >/dev/null; then
  echo "ERROR: no 'java' on PATH. Install JDK 25: apt install openjdk-25-jdk" >&2
  exit 1
fi
java_home="${JAVA_HOME:-}"
if [ -z "$java_home" ]; then
  # Prefer an explicit JDK 25 install if one exists alongside other JDKs.
  if [ -d /usr/lib/jvm/java-25-openjdk-amd64 ]; then
    java_home=/usr/lib/jvm/java-25-openjdk-amd64
  fi
fi
if [ -n "$java_home" ]; then
  echo "  JAVA_HOME: $java_home"
  export JAVA_HOME="$java_home"
fi
"${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")}/bin/java" -version

# ── 2. Pre-fetch the pinned OpenJDK source commit, if not already cached ───
src_cache="$script_dir/javac/jdk-src-cache"
if [ ! -d "$src_cache" ] || [ -z "$(ls -A "$src_cache" 2>/dev/null)" ]; then
  echo ""
  echo "  Fetching openjdk/jdk25u @ $revision (first run only, ~1 GB)..."
  rm -rf "$src_cache"
  mkdir -p "$src_cache"
  git init -q "$src_cache"
  git -C "$src_cache" remote add origin https://github.com/openjdk/jdk25u.git
  git -C "$src_cache" fetch --depth 1 origin "$revision"
  git -C "$src_cache" checkout -q FETCH_HEAD
  rm -rf "$src_cache/.git"
else
  echo "  Using cached OpenJDK source at $src_cache"
fi

# ── 3. Build & publish the patched TeaVM core+classlib this fork needs ─────
echo ""
echo "  Building patched TeaVM (see teavm-patch/README.md)..."
./teavm-patch/apply.sh

# ── 4. Build (javac from OpenJDK source -> TeaVM -> WASM-GC) ───────────────
echo ""
echo "  Running ./gradlew :compiler:build ..."
./gradlew :compiler:build

# ── 5. Copy output artifacts ────────────────────────────────────────────────
mkdir -p "$out_dir"
cp compiler/build/generated/teavm/wasm-gc/compiler.wasm "$out_dir/"
cp compiler/build/generated/teavm/wasm-gc/compiler.wasm-runtime.js "$out_dir/"
cp compiler/build/classlib/compile-classlib-teavm.bin "$out_dir/"
cp compiler/build/classlib/runtime-classlib-teavm.bin "$out_dir/"
date -u +%Y-%m-%dT%H:%M:%S.000Z > "$out_dir/.complete"

echo ""
echo "=== Output written to: $out_dir ==="
du -h "$out_dir"/* | sed 's/^/  /'

echo ""
echo "Done! Copy the contents of:"
echo "  $out_dir"
echo "to the target machine at the same path, then run 'npm run runtimes' there."
