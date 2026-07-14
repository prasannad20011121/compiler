# browser-ide

A browser-based VS Code-style IDE where **all code execution happens locally in the browser via WebAssembly** — the server never runs user code.

| Language | Execution method | Version |
|---|---|---|
| JavaScript | Sandboxed Web Worker (ES module graph via blob URLs) | browser engine |
| TypeScript | TS 5.9 compiler in worker → run as JS | TS 5.9.3 |
| Python | Pyodide (CPython in WASM), self-hosted core | 3.14.2 |
| C / C++ | clang 8 + lld in WASM (binji/wasm-clang) → WASI-ish shim | C11 / C++17 |
| Java | teavm-javac (javac 21 in WASM → TeaVM) | Java 21 |

## Structure

- `client/` — Angular IDE (Monaco, xterm.js, OPFS workspace, per-language WASM runners)
- `server/` — Express + MongoDB API (auth + project save **only**; no execution endpoints, ever)

## Rules

1. No API in the code-execution path. Run = zero network requests.
2. No third-party CDNs. Every runtime is a self-hosted, checksum-pinned static asset (`client/runtimes.json`).
3. Free-tier deployment only: Cloudflare Pages + Render free + MongoDB Atlas M0.

## Dev

```
cd client
npm ci
node scripts/download-runtimes.mjs   # fetch pinned WASM runtimes (once)
npm start                            # ng serve with COOP/COEP headers
```
