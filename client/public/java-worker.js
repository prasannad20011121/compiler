/**
 * browser-ide Java execution worker (module worker, served from public/).
 * Uses the self-built teavm-javac toolchain (Apache-2.0): real javac 25,
 * compiled from OpenJDK source by java-wasm-runtime/ in this repo, run
 * through TeaVM to WASM-GC, running entirely in the browser.
 *
 * Architecture: a nested "compiler worker" runs compiler.wasm and speaks the
 * teavm-javac protocol (load-classlib / compile). The resulting WASM-GC
 * module is then loaded and executed here, with System.out/err streamed to
 * the terminal. Single-file programs (class Main); System.in is not
 * supported by the TeaVM console runtime.
 */
'use strict';

let base = null;
let compilerWorker = null;
let compilerReady = null;
let runtimeLoad = null;
let nextId = 1;

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
  const { entry, files, indexURL } = event.data;
  base = indexURL;
  const started = Date.now();

  try {
    await ensureCompiler();

    const source = files.find((f) => f.path === entry)?.content ?? '';
    const javaFiles = files.filter((f) => f.path.endsWith('.java'));
    if (javaFiles.length > 1) {
      post({
        type: 'system',
        text: 'note: the in-browser javac compiles a single file — running only ' + entry,
      });
    }

    let hadErrors = false;
    const result = await request({ command: 'compile', text: source }, (d) => {
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
    let stdout = '';
    let stderr = '';
    const module = await runtimeLoad(result.script, {
      stackDeobfuscator: { enabled: false },
      installImports(o) {
        o.teavmConsole.putcharStdout = (ch) => {
          if (ch === 0x0a) {
            post({ type: 'stdout', text: stdout + '\n' });
            stdout = '';
          } else {
            stdout += String.fromCharCode(ch);
          }
        };
        o.teavmConsole.putcharStderr = (ch) => {
          if (ch === 0x0a) {
            post({ type: 'stderr', text: stderr + '\n' });
            stderr = '';
          } else {
            stderr += String.fromCharCode(ch);
          }
        };
      },
    });
    module.exports.main([]);
    if (stdout) post({ type: 'stdout', text: stdout + '\n' });
    if (stderr) post({ type: 'stderr', text: stderr + '\n' });
    post({ type: 'done', ok: true, ms: Date.now() - started });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    post({ type: 'stderr', text: message + '\n' });
    post({ type: 'done', ok: false, ms: Date.now() - started });
  }
};
