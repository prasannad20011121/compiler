/// <reference lib="webworker" />
/**
 * C/C++ execution worker. Compiles the workspace with OUR OWN from-scratch
 * C/C++ compiler (client/src/compiler/) straight to WebAssembly — no
 * clang, no LLVM, no vendored toolchain, no download. Runs entirely in the
 * browser, same as the other language workers.
 */
import { compileProgram, type SourceFile } from '../compiler/driver';
import { StdinBridge } from './stdin-bridge';

interface CppRunRequest {
  type: 'run';
  entry: string;
  files: SourceFile[];
  stdinSab: SharedArrayBuffer;
}

type RunnerMessage =
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | { type: 'system'; text: string }
  | { type: 'stdin-request' }
  | { type: 'done'; ok: boolean; ms: number };

const post = (message: RunnerMessage) => self.postMessage(message);

/** Thrown from the `exit` import to unwind out of the WASM call stack, mirroring process exit(). */
class ProcessExit extends Error {
  code: number;
  constructor(code: number) {
    super(`process exited with code ${code}`);
    this.code = code;
  }
}

self.onmessage = async (event: MessageEvent<CppRunRequest>) => {
  const { entry, files, stdinSab } = event.data;
  const started = performance.now();

  const result = compileProgram(files, entry);
  if (!result.ok) {
    for (const err of result.errors) post({ type: 'stderr', text: err + '\n' });
    post({ type: 'done', ok: false, ms: performance.now() - started });
    return;
  }

  const bridge = new StdinBridge(stdinSab);
  let stdinBuffer = '';
  let stdinPos = 0;
  const stdinBytes = () => new TextEncoder().encode(stdinBuffer);

  let memory: WebAssembly.Memory;
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();

  try {
    const module = await WebAssembly.compile(new Uint8Array(result.wasm));
    const instance = await WebAssembly.instantiate(module, {
      env: {
        write: (fd: number, ptr: number, len: number): number => {
          const bytes = new Uint8Array(memory.buffer, ptr, len);
          if (fd === 2) post({ type: 'stderr', text: stderrDecoder.decode(bytes, { stream: true }) });
          else post({ type: 'stdout', text: stdoutDecoder.decode(bytes, { stream: true }) });
          return len;
        },
        read: (_fd: number, ptr: number, maxlen: number): number => {
          let encoded = stdinBytes();
          if (stdinPos >= encoded.length) {
            stdinBuffer = bridge.readLine() + '\n';
            stdinPos = 0;
            encoded = stdinBytes();
          }
          const n = Math.min(maxlen, encoded.length - stdinPos);
          if (n <= 0) return 0;
          new Uint8Array(memory.buffer, ptr, n).set(encoded.subarray(stdinPos, stdinPos + n));
          stdinPos += n;
          return n;
        },
        exit: (code: number) => {
          throw new ProcessExit(code);
        },
      },
    });
    memory = instance.exports['memory'] as WebAssembly.Memory;

    let exitCode = 0;
    try {
      const rc = (instance.exports['main'] as () => number)();
      exitCode = typeof rc === 'number' ? rc : 0;
    } catch (e) {
      if (e instanceof ProcessExit) exitCode = e.code;
      else throw e;
    }

    if (exitCode !== 0) {
      post({ type: 'stderr', text: `process exited with code ${exitCode}\n` });
      post({ type: 'done', ok: false, ms: performance.now() - started });
      return;
    }
    post({ type: 'done', ok: true, ms: performance.now() - started });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: 'stderr', text: message + '\n' });
    post({ type: 'done', ok: false, ms: performance.now() - started });
  }
};
