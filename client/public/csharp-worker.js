/**
 * browser-ide C# execution worker (module worker, served from public/).
 *
 * Loads the self-hosted .NET 9 WASM runtime (dotnet-wasm) which embeds the
 * Roslyn C# compiler. Compiles and executes user .cs files entirely in the
 * browser — no server, no CDN at runtime, all assets same-origin.
 *
 * Protocol (identical to java-worker.js / py-runner.worker.ts):
 *   ← { type: 'run', entry: string, files: {path,content}[], indexURL: string, stdinSab?: SharedArrayBuffer }
 *   → { type: 'stdout' | 'stderr' | 'system', text: string }
 *   → { type: 'stdin-request' }
 *   → { type: 'done', ok: boolean, ms: number }
 *
 * stdin: Console.ReadLine() blocks synchronously on stdinSab via Atomics.wait,
 * same SharedArrayBuffer protocol as cpp-worker.js / stdin-bridge.ts. The
 * bridge functions are installed directly on `self` (this worker's global)
 * as __stdinConfigure/__stdinRequestLine, and Program.cs calls them via
 * `[JSImport("globalThis.__stdinRequestLine")]` — simpler than a dynamic JS
 * module import (JSHost.ImportAsync) since there's nothing to register.
 * The "has stdin" flag rides along appended to baseUrl (as "#stdin=1") rather
 * than as a 3rd RunCSharp parameter, just to keep the JSExport signature
 * identical to the original 2-string-param shape.
 *
 * stdout/stderr: streamed live via __stdoutWrite/__stderrWrite globals, which
 * Program.cs's StreamingWriter calls on every Console.Write/WriteLine — not
 * buffered until RunCSharp returns. result.streamed tells us whether the
 * final result.stdout/stderr were already emitted this way (true for any run
 * that got past compilation) or still need posting (false: compile-time
 * diagnostics, emitted before any redirection happens).
 */
'use strict';

/** @type {Promise<{RunCSharp: (filesJson: string, baseUrlAndFlags: string) => Promise<string>}> | null} */
let dotnetReady = null;
let base        = null;   // indexURL with trailing slash

const post = (m) => self.postMessage(m);

// ── stdin bridge, installed as worker globals for Program.cs's [JSImport] ─────
const STDIN_STATE_IDLE = 0;
const STDIN_STATE_REQUESTED = 1;
const STDIN_HEADER_BYTES = 8;
let stdinStateArr = null;
let stdinPayloadArr = null;

self.__stdinConfigure = (sab) => {
  stdinStateArr = new Int32Array(sab, 0, 2);
  stdinPayloadArr = new Uint8Array(sab, STDIN_HEADER_BYTES);
};

self.__stdinRequestLine = () => {
  if (!stdinStateArr) throw new Error('stdin bridge not configured for this run (no stdinSab provided)');
  Atomics.store(stdinStateArr, 1, 0);
  Atomics.store(stdinStateArr, 0, STDIN_STATE_REQUESTED);
  post({ type: 'stdin-request' });
  Atomics.wait(stdinStateArr, 0, STDIN_STATE_REQUESTED);
  const length = Atomics.load(stdinStateArr, 1);
  const text = new TextDecoder().decode(stdinPayloadArr.slice(0, length));
  Atomics.store(stdinStateArr, 0, STDIN_STATE_IDLE);
  return text;
};

// ── stdout/stderr streaming, called directly from Program.cs's StreamingWriter ─
self.__stdoutWrite = (text) => post({ type: 'stdout', text });
self.__stderrWrite = (text) => post({ type: 'stderr', text });

// ── Load the .NET 9 runtime (once, kept warm between runs) ────────────────────
function ensureRuntime() {
  dotnetReady ??= (async () => {
    post({ type: 'system', text: 'loading C# (.NET 9 WASM) runtime (first run only, ~40 MB)…' });

    // dotnet.js is the official ES-module bootstrap shipped in the AppBundle.
    // The .NET 9 API: import → destructure dotnet → call create() → getAssemblyExports().
    const { dotnet } = await import(/* @vite-ignore */ `${base}dotnet.js`);

    // dotnet.js reads blazor.boot.json for the full asset manifest (assemblies,
    // native wasm, ICU data, and now jsModuleWorker → main.mjs).
    // locateFile ensures every asset URL resolves to our versioned runtime dir.
    const { getAssemblyExports } = await dotnet
      .withConfigSrc(`${base}blazor.boot.json`)
      .withModuleConfig({
        locateFile: (fileName) => `${base}${fileName}`,
      })
      .create();

    // Retrieve the JS-exported surface of our CSharpRunner assembly.
    // The string must match the assembly name (without .wasm/.dll extension).
    const exports = await getAssemblyExports('CSharpRunner');
    return exports.CSharpRunnerInterop;   // exposes: RunCSharp(source) → jsonString
  })();
  return dotnetReady;
}

// ── Message handler ────────────────────────────────────────────────────────────
// NOTE: must use addEventListener, not the `self.onmessage` property — assigning
// that property causes the .NET 9 browser-wasm bootstrap (dotnet.create()) to
// hang forever. Confirmed by direct testing: create() never resolves in a worker
// where self.onmessage has been set, even if no message was ever dispatched.
self.addEventListener('message', async (event) => {
  const { entry, files, indexURL, stdinSab } = event.data;
  base = indexURL;   // e.g. "https://example.com/runtimes/dotnet-wasm/9.0/"
  const started = Date.now();

  try {
    const interop = await ensureRuntime();

    if (stdinSab) self.__stdinConfigure(stdinSab);

    // Gather all .cs files in the workspace
    const csFiles = files.filter((f) => f.path.endsWith('.cs'));
    if (csFiles.length === 0) throw new Error('No .cs files found in workspace.');

    if (csFiles.length > 1) {
      post({
        type: 'system',
        text: `note: compiling ${csFiles.length} .cs files together`,
      });
    }

    // Each file becomes its own Roslyn SyntaxTree server-side (see Program.cs),
    // so file order here never matters.
    const filesJson = JSON.stringify(csFiles.map((f) => ({ path: f.path, content: f.content })));

    // ── Call into .NET ────────────────────────────────────────────────────────
    // baseUrl lets RunCSharp fetch reference-assembly bytes for the Roslyn
    // compiler references (see GatherReferencesAsync in Program.cs). The
    // "#stdin=1" suffix (parsed off before use) tells it whether to wire up
    // Console.In — the buffer itself is already reachable via the
    // __stdinConfigure/__stdinRequestLine globals set up above.
    const baseUrlAndFlags = base + (stdinSab ? '#stdin=1' : '');
    const resultJson = await interop.RunCSharp(filesJson, baseUrlAndFlags);
    const result = JSON.parse(resultJson);

    // Program output (result.streamed === true) was already posted live via
    // __stdoutWrite/__stderrWrite as it happened — posting it again here would
    // duplicate it. Only compile-time diagnostics (result.streamed === false,
    // produced before Console ever gets redirected) still need posting now.
    if (!result.streamed) {
      if (result.stdout) {
        const lines = result.stdout.split('\n');
        // Don't emit a trailing empty newline from the split
        for (let i = 0; i < lines.length; i++) {
          if (i < lines.length - 1 || lines[i] !== '') {
            post({ type: 'stdout', text: lines[i] + '\n' });
          }
        }
      }

      if (result.stderr) {
        for (const line of result.stderr.split('\n')) {
          if (line.trim()) post({ type: 'stderr', text: line + '\n' });
        }
      }
    }

    post({ type: 'done', ok: result.ok, ms: Date.now() - started });

  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    post({ type: 'stderr', text: message + '\n' });
    post({ type: 'done', ok: false, ms: Date.now() - started });
  }
});
