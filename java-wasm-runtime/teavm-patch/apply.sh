#!/usr/bin/env bash
# Clones TeaVM at the 0.13.1 tag, overlays the patched classlib+core files in this directory,
# and publishes core+classlib to mavenLocal as version 0.13.1-patched7. See README.md in
# this directory for what's patched and why. Called automatically by ../build.sh.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src_cache="$script_dir/teavm-src-cache"
patched_version="0.13.1-patched7"

if [ ! -d "$src_cache" ] || [ -z "$(ls -A "$src_cache" 2>/dev/null)" ]; then
  echo "  Fetching konsoletyper/teavm @ 0.13.1 (first run only, ~400 MB)..."
  rm -rf "$src_cache"
  mkdir -p "$src_cache"
  git init -q "$src_cache"
  git -C "$src_cache" remote add origin https://github.com/konsoletyper/teavm.git
  git -C "$src_cache" fetch --depth 1 origin refs/tags/0.13.1:refs/tags/0.13.1
  git -C "$src_cache" checkout -q 0.13.1
else
  echo "  Using cached TeaVM source at $src_cache"
fi

echo "  Overlaying patched classlib + core files..."
cp "$script_dir/classlib/java/util/TFormatter.java" \
  "$src_cache/classlib/src/main/java/org/teavm/classlib/java/util/TFormatter.java"
cp "$script_dir/classlib/java/text/TDecimalFormat.java" \
  "$src_cache/classlib/src/main/java/org/teavm/classlib/java/text/TDecimalFormat.java"
cp "$script_dir/core/model/transformation/BoundCheckInsertion.java" \
  "$src_cache/core/src/main/java/org/teavm/model/transformation/BoundCheckInsertion.java"
cp "$script_dir/core/gc/vtable/WasmGCVirtualTableBuilder.java" \
  "$src_cache/core/src/main/java/org/teavm/backend/wasm/gc/vtable/WasmGCVirtualTableBuilder.java"

echo "  Publishing patched core+classlib to mavenLocal as $patched_version..."
(
  cd "$src_cache"
  JAVA_HOME="${JAVA_HOME:-}" ./gradlew :core:publishToMavenLocal :classlib:publishToMavenLocal \
    -Pteavm.project.version="$patched_version"
)
