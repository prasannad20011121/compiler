import { Injectable, isDevMode } from '@angular/core';
import { Subject } from 'rxjs';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

/** Shared output stream: language runners write here, the xterm panel renders it. */
@Injectable({ providedIn: 'root' })
export class TerminalService {
  private readonly out = new Subject<string>();
  private readonly clearSignal = new Subject<void>();
  private readonly input = new Subject<string>();

  readonly output$ = this.out.asObservable();
  readonly clear$ = this.clearSignal.asObservable();
  /** Raw keystrokes from xterm; consumed by RunnerService while a program awaits stdin. */
  readonly input$ = this.input.asObservable();

  sendInput(data: string): void {
    this.input.next(data);
  }

  constructor() {
    if (isDevMode()) {
      // Mirror output and expose stdin so automated tests can drive the terminal.
      const log: string[] = [];
      (globalThis as Record<string, unknown>)['__terminalLog'] = log;
      (globalThis as Record<string, unknown>)['__sendStdin'] = (data: string) =>
        this.sendInput(data);
      this.output$.subscribe((text) => log.push(text));
    }
  }

  write(text: string): void {
    this.out.next(text);
  }

  writeln(text = ''): void {
    this.out.next(text + '\r\n');
  }

  info(text: string): void {
    this.writeln(`${ANSI.cyan}${text}${ANSI.reset}`);
  }

  success(text: string): void {
    this.writeln(`${ANSI.green}${text}${ANSI.reset}`);
  }

  error(text: string): void {
    this.writeln(`${ANSI.red}${text}${ANSI.reset}`);
  }

  system(text: string): void {
    this.writeln(`${ANSI.dim}${text}${ANSI.reset}`);
  }

  clear(): void {
    this.clearSignal.next();
  }
}
