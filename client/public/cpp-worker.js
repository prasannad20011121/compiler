/**
 * browser-ide C/C++ execution worker (classic worker, served from public/).
 * Wraps the vendored binji/wasm-clang toolchain (Apache-2.0): real clang 8 +
 * lld compiled to WASM, running entirely in the browser. Compiles every
 * C/C++ source in the workspace, links, and executes the result via the
 * toolchain's WASI-ish shim. No server, no CDN — all assets same-origin.
 */
'use strict';

let api = null;
let base = null;
let stdinState = null;
let stdinPayload = null;

const STDIN_REQUESTED = 1;
const STDIN_IDLE = 0;

/** Block until the main thread delivers a line typed in the terminal. */
function refillStdin() {
  Atomics.store(stdinState, 1, 0);
  Atomics.store(stdinState, 0, STDIN_REQUESTED);
  postMessage({ type: 'stdin-request' });
  Atomics.wait(stdinState, 0, STDIN_REQUESTED);
  const length = Atomics.load(stdinState, 1);
  const text = new TextDecoder().decode(stdinPayload.slice(0, length));
  Atomics.store(stdinState, 0, STDIN_IDLE);
  return text;
}
self.__refillStdin = refillStdin;

async function loadApi() {
  if (api) return api;
  postMessage({ type: 'system', text: 'loading C/C++ toolchain (first run only, ~57 MB)…' });

  let src = await (await fetch(base + 'shared.js')).text();

  // Patch 1: interactive stdin — when the buffered stdin string is exhausted,
  // block on the SAB bridge for another line instead of returning EOF.
  const HOST_READ = 'host_read(fd, iovs, iovs_len, nread) {';
  if (!src.includes(HOST_READ)) throw new Error('shared.js patch point 1 missing');
  src = src.replace(
    HOST_READ,
    HOST_READ +
      '\n    if (this.stdinStrPos >= this.stdinStr.length && self.__refillStdin) {' +
      '\n      this.setStdinStr(self.__refillStdin() + "\\n");' +
      '\n    }',
  );

  // Patch 2: implement clock_time_get (time(), <chrono>, srand seeds).
  const CLOCK =
    "clock_time_get(clock_id, precision, time_out) {\n" +
    "    throw new NotImplemented('wasi_unstable', 'clock_time_get');\n" +
    '  }';
  if (!src.includes(CLOCK)) throw new Error('shared.js patch point 2 missing');
  src = src.replace(
    CLOCK,
    'clock_time_get(clock_id, precision, time_out) {\n' +
      '    this.mem.check();\n' +
      '    const ns = BigInt(Date.now()) * 1000000n;\n' +
      '    this.mem.write64(time_out, Number(ns & 0xffffffffn), Number(ns >> 32n));\n' +
      '    return 0;\n' +
      '  }',
  );

  importScripts(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));

  api = new API({
    readBuffer: async (name) => (await fetch(base + name)).arrayBuffer(),
    // Not compileStreaming: the extensionless toolchain files aren't served
    // with application/wasm, which streaming compilation requires.
    compileStreaming: async (name) => {
      const response = await fetch(base + name);
      if (!response.ok) throw new Error(`fetch ${name}: HTTP ${response.status}`);
      return WebAssembly.compile(await response.arrayBuffer());
    },
    hostWrite: (text) => postMessage({ type: 'stdout', text }),
    showTiming: false,
  });
  await api.ready;
  return api;
}

self.onmessage = async (event) => {
  const { files, stdinSab, indexURL } = event.data;
  base = indexURL;
  stdinState = new Int32Array(stdinSab, 0, 2);
  stdinPayload = new Uint8Array(stdinSab, 8);
  const started = Date.now();

  try {
    const api = await loadApi();

    // Mount the workspace (creating parent directories first).
    const addedDirs = new Set();
    for (const file of files) {
      const parts = file.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (!addedDirs.has(dir)) {
          addedDirs.add(dir);
          api.memfs.addDirectory(dir);
        }
      }
      api.memfs.addFile(file.path, file.content);
    }

    // Compile every C/C++ source file, then link them together.
    const sources = files.map((f) => f.path).filter((p) => /\.(c|cc|cpp|cxx)$/i.test(p));
    if (sources.length === 0) throw new Error('no C/C++ source files in workspace');

    const clang = await api.getModule('clang');
    const objects = [];
    for (const source of sources) {
      const obj = source.replace(/\.[^.]+$/, '.o');
      const isC = /\.c$/i.test(source);
      await api.run(
        clang, 'clang', '-cc1', '-emit-obj', ...api.clangCommonArgs,
        isC ? '-std=c11' : '-std=c++17', '-O2', '-o', obj, '-x', isC ? 'c' : 'c++', source,
      );
      objects.push(obj);
    }

    const lld = await api.getModule('lld');
    const libdir = 'lib/wasm32-wasi';
    await api.run(
      lld, 'wasm-ld', '--no-threads', '--export-dynamic', '-z', 'stack-size=1048576',
      `-L${libdir}`, `${libdir}/crt1.o`, ...objects,
      '-lc', '-lc++', '-lc++abi', '-lcanvas', '-o', 'program.wasm',
    );

    const wasmBytes = api.memfs.getFileContents('program.wasm').slice();
    const program = await WebAssembly.compile(wasmBytes);
    await api.run(program, 'program.wasm');
    postMessage({ type: 'done', ok: true, ms: Date.now() - started });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    // App.run already wrote "process exited with code N" style messages to the terminal.
    if (!message.startsWith('process exited')) {
      postMessage({ type: 'stderr', text: message + '\n' });
    }
    postMessage({ type: 'done', ok: false, ms: Date.now() - started });
  }
};
