# browser-ide

A browser-based VS Code-style IDE where **all code execution happens locally in the browser via WebAssembly** — the server never runs user code.

| Language | Execution method | Version |
|---|---|---|
| JavaScript | Sandboxed Web Worker (ES module graph via blob URLs) | browser engine |
| TypeScript | TS 5.9 compiler in worker → run as JS | TS 5.9.3 |
| Python | Pyodide (CPython in WASM), self-hosted core | 3.14.2 |
| C / C++ | clang 8 + lld in WASM (binji/wasm-clang) → WASI-ish shim | C11 / C++17 |
| Java | teavm-javac (javac 21 in WASM → TeaVM) | Java 21 |
| C# | .NET 9 WASM + Roslyn in-browser compiler | .NET 9.0 |

## Structure

- `client/` — Angular IDE (Monaco, xterm.js, OPFS workspace, per-language WASM runners)
- `server/` — Express + MongoDB API (auth + project save **only**; no execution endpoints, ever)
- `csharp-wasm-runtime/` — Standalone C# .NET WASM AppBundle builder & pre-built zip installer

## Rules

1. No API in the code-execution path. Run = zero network requests.
2. No third-party CDNs. Every runtime is a self-hosted, checksum-pinned static asset (`client/runtimes.json`).
3. Free-tier deployment only: Cloudflare Pages + Render free + MongoDB Atlas M0.

## How to Run

### 1. Frontend (Client IDE)

```bash
cd client
npm install
npm run runtimes   # Verifies and installs all WASM runtimes locally
npm start          # Starts Angular dev server at http://localhost:4200/
```

Open [http://localhost:4200/](http://localhost:4200/) in your browser. All code execution runs 100% locally client-side.

### 2. Backend Server (Optional — for Cloud Save & Auth)

```bash
cd server
npm install
npm start          # Starts Express server (requires MONGODB_URI)
```

*(Note: The IDE functions fully offline without the server; the backend is only used if you sign in to persist workspace snapshots).*

### 3. C# WASM Runtime Setup

- **Pre-built Zip Install (No .NET SDK needed):**
  ```powershell
  cd csharp-wasm-runtime
  powershell -ExecutionPolicy Bypass -File install.ps1
  ```
- **Rebuilding C# Runtime (Requires .NET 9 SDK + `wasm-tools`):**
  ```powershell
  cd csharp-wasm-runtime
  .\build.ps1
  ```

