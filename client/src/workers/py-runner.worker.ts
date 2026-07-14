/// <reference lib="webworker" />
/**
 * Python execution worker. Loads the SELF-HOSTED Pyodide distribution
 * (public/runtimes/pyodide/<version>/ — same origin, no CDN) and runs the
 * entry script with the workspace mounted into Pyodide's file system.
 * The instance stays warm between runs; Stop terminates the worker.
 */
import { StdinBridge } from './stdin-bridge';

interface PyRunRequest {
  type: 'run';
  entry: string;
  files: { path: string; content: string }[];
  stdinSab: SharedArrayBuffer;
  /** Absolute same-origin URL of the pyodide distribution, with trailing slash. */
  indexURL: string;
}

type StreamOptions = { write: (buffer: Uint8Array) => number };

type PyodideInterface = {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string): void;
  };
  setStdout(options: StreamOptions): void;
  setStderr(options: StreamOptions): void;
  setStdin(options: { stdin: () => string | null }): void;
  runPythonAsync(code: string): Promise<unknown>;
};

const post = (message: unknown) => self.postMessage(message);

let pyodidePromise: Promise<PyodideInterface> | null = null;

function getPyodide(indexURL: string): Promise<PyodideInterface> {
  pyodidePromise ??= (async () => {
    post({ type: 'system', text: 'loading Python 3.14 runtime (first run only, ~13 MB)…' });
    const mod = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
    return mod.loadPyodide({ indexURL });
  })();
  return pyodidePromise;
}

self.onmessage = async (event: MessageEvent<PyRunRequest>) => {
  const { entry, files, stdinSab, indexURL } = event.data;
  const started = performance.now();
  try {
    const py = await getPyodide(indexURL);
    const bridge = new StdinBridge(stdinSab);

    // Raw write handlers so prompts without a trailing newline (e.g. input()) flush immediately.
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    py.setStdout({
      write: (buffer) => {
        post({ type: 'stdout', text: stdoutDecoder.decode(buffer, { stream: true }) });
        return buffer.length;
      },
    });
    py.setStderr({
      write: (buffer) => {
        post({ type: 'stderr', text: stderrDecoder.decode(buffer, { stream: true }) });
        return buffer.length;
      },
    });
    py.setStdin({ stdin: () => bridge.readLine() + '\n' });

    for (const file of files) {
      const dir = file.path.split('/').slice(0, -1).join('/');
      if (dir) py.FS.mkdirTree(`/home/pyodide/${dir}`);
      py.FS.writeFile(`/home/pyodide/${file.path}`, file.content);
    }

    // run_path gives real __main__ semantics; cwd/sys.path let sibling imports work.
    await py.runPythonAsync(
      [
        'import os, sys, runpy',
        "os.chdir('/home/pyodide')",
        "sys.path.insert(0, '/home/pyodide')",
        `runpy.run_path(${JSON.stringify('/home/pyodide/' + entry)}, run_name='__main__')`,
      ].join('\n'),
    );
    post({ type: 'done', ok: true, ms: performance.now() - started });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: 'stderr', text: message.endsWith('\n') ? message : message + '\n' });
    post({ type: 'done', ok: false, ms: performance.now() - started });
  }
};
