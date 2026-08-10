import { Injectable, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import runtimesManifest from '../../../runtimes.json';
import { STDIN_SAB_BYTES, deliverStdinLine } from '../../workers/stdin-bridge';
import { TerminalService } from '../core/terminal.service';
import { WorkspaceService } from '../fs/workspace.service';

type Language = 'js' | 'python' | 'cpp' | 'java' | 'csharp';

const LANGUAGE_BY_EXT: Record<string, Language> = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'js',
  py: 'python',
  c: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  java: 'java',
  cs: 'csharp',
};

const LANGUAGE_LABEL: Record<Language, string> = {
  js: 'JavaScript/TypeScript',
  python: 'Python 3.14 (Pyodide)',
  cpp: 'C/C++ (self-hosted compiler → WASM)',
  java: 'Java 21 (javac + TeaVM)',
  csharp: 'C# (.NET 9 WASM)',
};

/** JS gets a hard timeout (infinite loops); Python may legitimately block on input(). */
const JS_RUN_TIMEOUT_MS = 60_000;

/**
 * Dispatches Run requests to per-language workers. Everything executes
 * locally in the browser — a Run must never produce a network request
 * beyond same-origin runtime assets.
 */
@Injectable({ providedIn: 'root' })
export class RunnerService {
  private readonly terminal = inject(TerminalService);
  private readonly workspace = inject(WorkspaceService);

  readonly running = signal(false);

  private activeWorker: Worker | null = null;
  private pythonWorker: Worker | null = null; // kept warm between runs
  private cppWorker: Worker | null = null; // kept warm — holds the compiled toolchain
  private javaWorker: Worker | null = null;   // kept warm — holds the loaded javac
  private csharpWorker: Worker | null = null; // kept warm — holds the loaded .NET runtime
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private stdinSubscription: Subscription | null = null;
  private readonly stdinSab = new SharedArrayBuffer(STDIN_SAB_BYTES);

  languageOf(path: string | null): Language | null {
    if (!path) return null;
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    return LANGUAGE_BY_EXT[ext] ?? null;
  }

  canRun(path: string | null): boolean {
    return this.languageOf(path) !== null;
  }

  async run(entry: string): Promise<void> {
    const language = this.languageOf(entry);
    if (this.running() || !language) return;
    this.running.set(true);

    const files = await this.workspace.snapshot();
    this.terminal.writeln('');
    this.terminal.info(`▶ ${entry}  (local ${LANGUAGE_LABEL[language]} runtime)`);

    const worker = this.getWorker(language);
    this.activeWorker = worker;

    worker.onmessage = ({ data }) => {
      switch (data.type) {
        case 'stdout':
          this.terminal.write(data.text.replace(/\n/g, '\r\n'));
          break;
        case 'stderr':
          this.terminal.write(`\x1b[31m${data.text.replace(/\n/g, '\r\n')}\x1b[0m`);
          break;
        case 'system':
          this.terminal.system(data.text);
          break;
        case 'stdin-request':
          void this.collectStdinLine();
          break;
        case 'done':
          this.terminal.system(
            data.ok
              ? `✓ finished in ${Math.round(data.ms)} ms`
              : `✗ failed after ${Math.round(data.ms)} ms`,
          );
          this.finishRun();
          break;
      }
    };
    worker.onerror = (event) => {
      this.terminal.error(event.message ?? 'Worker crashed');
      this.killActiveWorker();
    };

    if (language === 'js') {
      this.timeoutId = setTimeout(() => {
        this.terminal.error(`✂ timed out after ${JS_RUN_TIMEOUT_MS / 1000}s — worker terminated`);
        this.killActiveWorker();
      }, JS_RUN_TIMEOUT_MS);
    }

    if (language === 'python') {
      const version = runtimesManifest.runtimes.pyodide.version;
      worker.postMessage({
        type: 'run',
        entry,
        files,
        stdinSab: this.stdinSab,
        indexURL: `${location.origin}/runtimes/pyodide/${version}/`,
      });
    } else if (language === 'cpp') {
      // Our own compiler ships as part of the app bundle — no runtime download.
      worker.postMessage({ type: 'run', entry, files, stdinSab: this.stdinSab });
    } else if (language === 'java') {
      const version = runtimesManifest.runtimes['teavm-javac'].version;
      worker.postMessage({
        type: 'run',
        entry,
        files,
        indexURL: `${location.origin}/runtimes/teavm-javac/${version}/`,
      });
    } else if (language === 'csharp') {
      const version = runtimesManifest.runtimes['dotnet-wasm'].version;
      worker.postMessage({
        type: 'run',
        entry,
        files,
        stdinSab: this.stdinSab,
        indexURL: `${location.origin}/runtimes/dotnet-wasm/${version}/`,
      });
    } else {
      worker.postMessage({ type: 'run', entry, files });
    }
  }

  stop(): void {
    if (!this.running()) return;
    this.terminal.system('✂ stopped by user');
    this.killActiveWorker();
  }

  private getWorker(language: Language): Worker {
    if (language === 'python') {
      this.pythonWorker ??= new Worker(new URL('../../workers/py-runner.worker', import.meta.url), {
        type: 'module',
      });
      return this.pythonWorker;
    }
    if (language === 'cpp') {
      // Our own compiler, bundled with the app like any other TS module — no vendored toolchain.
      this.cppWorker ??= new Worker(new URL('../../workers/cpp-runner.worker', import.meta.url), {
        type: 'module',
      });
      return this.cppWorker;
    }
    if (language === 'java') {
      this.javaWorker ??= new Worker('/java-worker.js', { type: 'module' });
      return this.javaWorker;
    }
    if (language === 'csharp') {
      this.csharpWorker ??= new Worker('/csharp-worker.js', { type: 'module' });
      return this.csharpWorker;
    }
    return new Worker(new URL('../../workers/code-runner.worker', import.meta.url), {
      type: 'module',
    });
  }

  /** Echo keystrokes, handle backspace, deliver the line to the blocked worker on Enter. */
  private collectStdinLine(): Promise<void> {
    return new Promise((resolve) => {
      let buffer = '';
      this.stdinSubscription = this.terminal.input$.subscribe((data) => {
        for (const ch of data) {
          if (ch === '\r' || ch === '\n') {
            this.terminal.write('\r\n');
            this.stdinSubscription?.unsubscribe();
            this.stdinSubscription = null;
            deliverStdinLine(this.stdinSab, buffer);
            resolve();
            return;
          }
          if (ch === '\x7f') {
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
              this.terminal.write('\b \b');
            }
          } else if (ch >= ' ') {
            buffer += ch;
            this.terminal.write(ch);
          }
        }
      });
    });
  }

  /** Run ended normally — keep the warm Python worker alive. */
  private finishRun(): void {
    this.clearRunState();
    this.activeWorker = null;
    this.running.set(false);
  }

  /** Stop/crash/timeout — terminate the worker (warm runtimes restart cold next run). */
  private killActiveWorker(): void {
    this.clearRunState();
    this.activeWorker?.terminate();
    if (this.activeWorker === this.pythonWorker) this.pythonWorker = null;
    if (this.activeWorker === this.cppWorker) this.cppWorker = null;
    if (this.activeWorker === this.javaWorker) this.javaWorker = null;
    if (this.activeWorker === this.csharpWorker) this.csharpWorker = null;
    this.activeWorker = null;
    this.running.set(false);
  }

  private clearRunState(): void {
    if (this.timeoutId !== null) clearTimeout(this.timeoutId);
    this.timeoutId = null;
    this.stdinSubscription?.unsubscribe();
    this.stdinSubscription = null;
  }
}
