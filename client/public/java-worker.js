/**
 * browser-ide Java execution worker (module worker, served from public/).
 * Uses the self-built teavm-javac toolchain (Apache-2.0): real javac 25,
 * compiled from OpenJDK source by java-wasm-runtime/ in this repo, run
 * through TeaVM to WASM-GC, running entirely in the browser.
 *
 * Architecture: a nested "compiler worker" runs compiler.wasm and speaks the
 * teavm-javac protocol (load-classlib / compile). The resulting WASM-GC
 * module is then loaded and executed here, with System.out/err streamed to
 * the terminal. All .java files in the workspace are compiled together, so
 * classes may reference each other; exactly one file may contain a valid
 * main method. System.in reads real terminal input via the same
 * SharedArrayBuffer + Atomics.wait bridge the C/C++ and Python workers use
 * (see ../src/workers/stdin-bridge.ts) — java-wasm-runtime's teavm-patch
 * wires this into TConsoleInputStream/WasmGCSupport.readStdinByte.
 */
'use strict';

let base = null;
let compilerWorker = null;
let compilerReady = null;
let runtimeLoad = null;
let nextId = 1;

const STDIN_STATE_IDLE = 0;
const STDIN_STATE_REQUESTED = 1;
let stdinState = null;
let stdinPayload = null;
// Bytes of the current line (UTF-8, with a trailing '\n' appended) not yet
// consumed by readStdinByte — refilled one line at a time from the bridge.
let stdinLineBytes = new Uint8Array(0);
let stdinLinePos = 0;

// System.out/err are buffered a character at a time (see putcharStdout/Stderr
// below) and normally only flushed to the terminal on '\n' — but a prompt
// printed with System.out.print (no trailing newline) immediately followed
// by a blocking Scanner read would otherwise sit invisibly in this buffer
// forever: readStdinByte's Atomics.wait blocks the whole worker thread, so
// nothing here ever gets another turn to flush it on a later newline. So
// readStdinByte flushes whatever's pending right before it blocks.
let stdoutBuf = '';
let stderrBuf = '';
function flushPendingOutput() {
  if (stdoutBuf) {
    post({ type: 'stdout', text: stdoutBuf });
    stdoutBuf = '';
  }
  if (stderrBuf) {
    post({ type: 'stderr', text: stderrBuf });
    stderrBuf = '';
  }
}

/** Blocks the whole worker thread until the main thread delivers a line typed in the terminal. */
function readStdinByte() {
  if (stdinLinePos >= stdinLineBytes.length) {
    flushPendingOutput();
    Atomics.store(stdinState, 1, 0);
    Atomics.store(stdinState, 0, STDIN_STATE_REQUESTED);
    post({ type: 'stdin-request' });
    Atomics.wait(stdinState, 0, STDIN_STATE_REQUESTED);
    const length = Atomics.load(stdinState, 1);
    const line = new TextDecoder().decode(stdinPayload.slice(0, length));
    Atomics.store(stdinState, 0, STDIN_STATE_IDLE);
    stdinLineBytes = new TextEncoder().encode(line + '\n');
    stdinLinePos = 0;
  }
  return stdinLineBytes[stdinLinePos++];
}

const post = (m) => self.postMessage(m);

function startCompilerWorker() {
  const bootstrap = [
    `import { load } from '${base}compiler.wasm-runtime.js';`,
    '(async () => {',
    `  const teavm = await load('${base}compiler.wasm', { stackDeobfuscator: { enabled: false } });`,
    '  teavm.exports.installWorker();',
    '})();',
  ].join('\n');
  const url = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }));
  return new Worker(url, { type: 'module' });
}

/** Send a request to the compiler worker; stream diagnostics; resolve on terminal reply. */
function request(message, onDiagnostic) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    const handler = (event) => {
      const data = event.data;
      if (!data || data.id !== id) return;
      switch (data.command) {
        case 'phase':
          break; // compilation phase progress — too noisy for the terminal
        case 'compiler-diagnostic':
        case 'diagnostic':
          if (onDiagnostic) onDiagnostic(data);
          break;
        case 'error':
          compilerWorker.removeEventListener('message', handler);
          reject(new Error(data.text || 'compiler error'));
          break;
        case 'ok':
        case 'compilation-complete':
          compilerWorker.removeEventListener('message', handler);
          resolve(data);
          break;
      }
    };
    compilerWorker.addEventListener('message', handler);
    compilerWorker.postMessage({ ...message, id });
  });
}

function ensureCompiler() {
  compilerReady ??= (async () => {
    post({ type: 'system', text: 'loading Java 25 toolchain (first run only, ~7 MB)…' });
    compilerWorker = startCompilerWorker();
    // The compiler installs its message listener only after compiler.wasm boots —
    // anything sent before its 'initialized' broadcast would be lost.
    await new Promise((resolve, reject) => {
      const onReady = (event) => {
        if (event.data && event.data.command === 'initialized') {
          compilerWorker.removeEventListener('message', onReady);
          resolve();
        }
      };
      compilerWorker.addEventListener('message', onReady);
      compilerWorker.onerror = (event) =>
        reject(new Error(event.message || 'Java compiler worker failed to start'));
    });
    await request({
      command: 'load-classlib',
      url: `${base}compile-classlib-teavm.bin`,
      runtimeUrl: `${base}runtime-classlib-teavm.bin`,
    });
  })();
  return compilerReady;
}

function formatDiagnostic(d) {
  const sev = (d.severity || 'error').toLowerCase();
  const file = d.fileName || 'Main.java';
  const line = d.lineNumber >= 0 ? `:${d.lineNumber}` : '';
  return `${file}${line}: ${sev}: ${d.message}\n`;
}

self.onmessage = async (event) => {
  const { files, indexURL, stdinSab } = event.data;
  base = indexURL;
  if (stdinSab) {
    stdinState = new Int32Array(stdinSab, 0, 2);
    stdinPayload = new Uint8Array(stdinSab, 8);
  }
  const started = Date.now();

  try {
    await ensureCompiler();

    const javaFiles = files.filter((f) => f.path.endsWith('.java'));

    let hadErrors = false;
    const result = await request({ command: 'compile', files: javaFiles }, (d) => {
      const text = formatDiagnostic(d);
      if ((d.severity || '').toLowerCase() === 'error') {
        hadErrors = true;
        post({ type: 'stderr', text });
      } else {
        post({ type: 'stdout', text });
      }
    });

    if (result.status !== 'successful' || !result.script) {
      if (!hadErrors) post({ type: 'stderr', text: 'compilation failed\n' });
      post({ type: 'done', ok: false, ms: Date.now() - started });
      return;
    }

    // Execute the compiled WASM-GC module right here, streaming console output.
    runtimeLoad ??= (await import(/* @vite-ignore */ `${base}compiler.wasm-runtime.js`)).load;
    stdoutBuf = '';
    stderrBuf = '';
    const module = await runtimeLoad(result.script, {
      stackDeobfuscator: { enabled: false },
      installImports(o) {
        o.teavmConsole.putcharStdout = (ch) => {
          if (ch === 0x0a) {
            post({ type: 'stdout', text: stdoutBuf + '\n' });
            stdoutBuf = '';
          } else {
            stdoutBuf += String.fromCharCode(ch);
          }
        };
        o.teavmConsole.putcharStderr = (ch) => {
          if (ch === 0x0a) {
            post({ type: 'stderr', text: stderrBuf + '\n' });
            stderrBuf = '';
          } else {
            stderrBuf += String.fromCharCode(ch);
          }
        };
        o.teavmConsole.readStdinByte = readStdinByte;
      },
    });
    module.exports.main([]);
    // Unlike readStdinByte's mid-program flush (which must NOT add a
    // newline — the point there is keeping a prompt and the input the user
    // types on the same line), a leftover unterminated print at the very
    // end should still get one, so the '✓ finished' status line below starts
    // on its own line instead of being glued to the program's last output.
    if (stdoutBuf) post({ type: 'stdout', text: stdoutBuf + '\n' });
    if (stderrBuf) post({ type: 'stderr', text: stderrBuf + '\n' });
    stdoutBuf = '';
    stderrBuf = '';
    post({ type: 'done', ok: true, ms: Date.now() - started });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    post({ type: 'stderr', text: message + '\n' });
    post({ type: 'done', ok: false, ms: Date.now() - started });
  }
};
