import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  afterNextRender,
  inject,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as Xterm } from '@xterm/xterm';
import { TerminalService } from '../../core/terminal.service';

@Component({
  selector: 'ide-terminal',
  template: `<div class="term-host" #host></div>`,
  styles: `
    :host {
      display: block;
      height: 100%;
      background: var(--ide-editor-bg);
      padding: 4px 0 0 8px;
    }
    .term-host {
      height: 100%;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Terminal implements OnDestroy {
  private readonly terminalService = inject(TerminalService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');

  private xterm?: Xterm;
  private resizeObserver?: ResizeObserver;

  constructor() {
    afterNextRender(() => {
      const xterm = new Xterm({
        convertEol: true,
        disableStdin: false, // programs can read stdin via the SAB bridge
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "Consolas, 'Cascadia Code', 'Courier New', monospace",
        theme: {
          background: '#1e1e1e',
          foreground: '#cccccc',
          cursor: '#cccccc',
          selectionBackground: '#264f78',
        },
      });
      const fit = new FitAddon();
      xterm.loadAddon(fit);
      xterm.open(this.host().nativeElement);
      fit.fit();
      xterm.writeln('\x1b[2mbrowser-ide output — code runs locally in this browser\x1b[0m');
      xterm.onData((data) => this.terminalService.sendInput(data));

      this.resizeObserver = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          // host not measurable mid-layout; next resize will fit
        }
      });
      this.resizeObserver.observe(this.host().nativeElement);

      this.terminalService.output$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((text) => xterm.write(text));
      this.terminalService.clear$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => xterm.clear());

      this.xterm = xterm;
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.xterm?.dispose();
  }
}
