#!/usr/bin/env bash
# Runs a compiler test file through esbuild (matching how the app itself is bundled)
# then executes the result with plain node. Usage: tests/run.sh tests/foo-smoke.ts
set -euo pipefail
ESBUILD="$(dirname "$0")/../../../node_modules/.bin/esbuild"
OUT="$(mktemp /tmp/compiler-test-XXXXXX.mjs)"
"$ESBUILD" "$1" --bundle --platform=node --format=esm --outfile="$OUT" --log-level=warning
node "$OUT"
rm -f "$OUT"
