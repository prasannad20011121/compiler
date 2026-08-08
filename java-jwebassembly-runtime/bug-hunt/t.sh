#!/usr/bin/env bash
# Compiles one bug-hunt/src/<ClassName>.java through JWebAssembly, using the
# jars ../build.sh already fetched into ../lib/. Run ../build.sh at least
# once first.
#
# Usage: ./t.sh <ClassName> [--eh] [--gc] [--ignorenative]
set -uo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

java8_home="${JAVA8_HOME:-}"
if [ -z "$java8_home" ] && [ -d /usr/lib/jvm/java-8-openjdk-amd64 ]; then
  java8_home=/usr/lib/jvm/java-8-openjdk-amd64
fi
if [ -z "$java8_home" ] || [ ! -x "$java8_home/bin/javac" ]; then
  echo "ERROR: no JDK 8 found. Set JAVA8_HOME, or: apt install openjdk-8-jdk-headless" >&2
  exit 1
fi
javac8="$java8_home/bin/javac"
java8="$java8_home/bin/java"

compiler_jar="../lib/jwebassembly-compiler-head.jar"
api_jar="../lib/jwebassembly-api-head.jar"
if [ ! -f "$compiler_jar" ] || [ ! -f "$api_jar" ]; then
  echo "ERROR: ${compiler_jar} / ${api_jar} not found — run ../build.sh once first." >&2
  exit 1
fi

name="$1"; shift
extra_props=()
for a in "$@"; do
  case "$a" in
    --eh) extra_props+=(-Djwa.eh=true) ;;
    --gc) extra_props+=(-Djwa.gc=true) ;;
    --ignorenative) extra_props+=(-Djwa.ignorenative=true) ;;
  esac
done

mkdir -p classes out
echo "=== $name ==="
"$javac8" -encoding UTF-8 -cp "$api_jar" -d classes "src/$name.java" 2>&1
if [ ! -f "classes/$name.class" ]; then echo "JAVAC FAILED"; exit 1; fi

"$javac8" -encoding UTF-8 -cp "$compiler_jar:$api_jar" Compile.java 2>&1

"$java8" "${extra_props[@]}" -Djwebassembly.api.jar="$api_jar" \
  -cp ".:classes:$compiler_jar:$api_jar" \
  Compile "$name.class" classes "out/$name.wasm"
