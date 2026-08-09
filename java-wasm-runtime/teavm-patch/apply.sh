#!/usr/bin/env bash
# Clones TeaVM at the 0.13.1 tag, overlays the patched classlib+core files in this directory,
# and publishes core+classlib to mavenLocal as version 0.13.1-patched12. See README.md in
# this directory for what's patched and why. Called automatically by ../build.sh.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src_cache="$script_dir/teavm-src-cache"
patched_version="0.13.1-patched12"

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
cp "$script_dir/core/generate/common/methods/BaseWasmGenerationVisitor.java" \
  "$src_cache/core/src/main/java/org/teavm/backend/wasm/generate/common/methods/BaseWasmGenerationVisitor.java"
cp "$script_dir/core/generate/gc/methods/WasmGCGenerationVisitor.java" \
  "$src_cache/core/src/main/java/org/teavm/backend/wasm/generate/gc/methods/WasmGCGenerationVisitor.java"
cp "$script_dir/core/generate/gc/methods/WasmGCGenerationContext.java" \
  "$src_cache/core/src/main/java/org/teavm/backend/wasm/generate/gc/methods/WasmGCGenerationContext.java"
cp "$script_dir/core/generate/WasmGenerationVisitor.java" \
  "$src_cache/core/src/main/java/org/teavm/backend/wasm/generate/WasmGenerationVisitor.java"
cp "$script_dir/core/runtime/ExceptionHandling.java" \
  "$src_cache/core/src/main/java/org/teavm/runtime/ExceptionHandling.java"
cp "$script_dir/core/runtime/gc/WasmGCSupport.java" \
  "$src_cache/core/src/main/java/org/teavm/backend/wasm/runtime/gc/WasmGCSupport.java"
cp "$script_dir/core/gc/WasmGCDependencies.java" \
  "$src_cache/core/src/main/java/org/teavm/backend/wasm/gc/WasmGCDependencies.java"
cp "$script_dir/classlib/java/lang/TConsoleInputStream.java" \
  "$src_cache/classlib/src/main/java/org/teavm/classlib/java/lang/TConsoleInputStream.java"
cp "$script_dir/classlib/java/util/TScanner.java" \
  "$src_cache/classlib/src/main/java/org/teavm/classlib/java/util/TScanner.java"
cp "$script_dir/classlib/java/util/TInputMismatchException.java" \
  "$src_cache/classlib/src/main/java/org/teavm/classlib/java/util/TInputMismatchException.java"
cp "$script_dir/classlib/java/lang/TInteger.java" \
  "$src_cache/classlib/src/main/java/org/teavm/classlib/java/lang/TInteger.java"
cp "$script_dir/classlib/java/lang/TLong.java" \
  "$src_cache/classlib/src/main/java/org/teavm/classlib/java/lang/TLong.java"
cp "$script_dir/classlib/java/lang/TDouble.java" \
  "$src_cache/classlib/src/main/java/org/teavm/classlib/java/lang/TDouble.java"
cp "$script_dir/classlib/java/lang/TFloat.java" \
  "$src_cache/classlib/src/main/java/org/teavm/classlib/java/lang/TFloat.java"
cp "$script_dir/classlib/java/util/TIterator.java" \
  "$src_cache/classlib/src/main/java/org/teavm/classlib/java/util/TIterator.java"

echo "  Publishing patched core+classlib to mavenLocal as $patched_version..."
(
  cd "$src_cache"
  JAVA_HOME="${JAVA_HOME:-}" ./gradlew :core:publishToMavenLocal :classlib:publishToMavenLocal \
    -Pteavm.project.version="$patched_version"
)
