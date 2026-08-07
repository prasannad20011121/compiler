import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  afterNextRender,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type * as Monaco from 'monaco-editor';
import { EditorStateService } from '../../core/editor-state.service';
import { MonacoLoaderService } from '../../core/monaco-loader.service';
import { WorkspaceService } from '../../fs/workspace.service';

const LANGUAGE_BY_EXT: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  py: 'python',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  json: 'json',
  md: 'markdown',
  html: 'html',
  css: 'css',
  scss: 'scss',
};

export function languageOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext';
}

@Component({
  selector: 'ide-editor',
  template: `
    @if (!state.active()) {
      <div class="empty">
        <div class="empty-logo">{{ '{ }' }}</div>
        <p>Open a file from the explorer to start editing.</p>
        <p class="hint">Everything runs locally in your browser.</p>
      </div>
    }
    <div class="editor-host" #host [class.hidden]="!state.active()"></div>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      position: relative;
      background: var(--ide-editor-bg);
    }
    .editor-host {
      height: 100%;
    }
    .editor-host.hidden {
      visibility: hidden;
    }
    .empty {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--ide-fg-dim);
      gap: 8px;
      user-select: none;
    }
    .empty-logo {
      font-size: 48px;
      opacity: 0.25;
      font-weight: 700;
    }
    .hint {
      font-size: 11px;
      opacity: 0.6;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Editor implements OnDestroy {
  protected readonly state = inject(EditorStateService);
  private readonly workspace = inject(WorkspaceService);
  private readonly loader = inject(MonacoLoaderService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly ready = signal(false);

  private monaco?: typeof Monaco;
  private editor?: Monaco.editor.IStandaloneCodeEditor;
  private readonly models = new Map<string, Monaco.editor.ITextModel>();

  constructor() {
    afterNextRender(() => void this.initMonaco());

    effect(() => {
      const path = this.state.active();
      if (this.ready()) void this.showFile(path);
    });

    this.state.saveRequest$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.saveAll());
  }

  private async initMonaco(): Promise<void> {
    this.monaco = await this.loader.load();
    this.editor = this.monaco.editor.create(this.host().nativeElement, {
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 14,
      fontFamily: "Consolas, 'Cascadia Code', 'Courier New', monospace",
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      tabSize: 2,
      model: null,
    });
    this.editor.addCommand(this.monaco.KeyMod.CtrlCmd | this.monaco.KeyCode.KeyS, () =>
      void this.saveAll(),
    );
    this.ready.set(true);
  }

  private async showFile(path: string | null): Promise<void> {
    if (!this.editor || !this.monaco) return;
    if (!path) {
      this.editor.setModel(null);
      return;
    }
    let model = this.models.get(path);
    if (!model) {
      const content = await this.workspace.readFile(path).catch(() => null);
      if (content === null) return;
      model = this.models.get(path); // re-check after await
      if (!model) {
        model = this.monaco.editor.createModel(
          content,
          languageOf(path),
          this.monaco.Uri.file(path),
        );
        model.onDidChangeContent(() => this.state.markDirty(path));
        this.models.set(path, model);
      }
    }
    if (this.state.active() === path) {
      this.editor.setModel(model);
      this.editor.focus();
    }
  }

  async saveActive(): Promise<void> {
    const path = this.state.active();
    if (!path) return;
    const model = this.models.get(path);
    if (!model) return;
    await this.workspace.writeFile(path, model.getValue());
    this.state.markClean(path);
  }

  /**
   * Persist every dirty tab, not just the active one. Ctrl+S and Run both use
   * this — saveActive() alone let you edit file A, switch to file B without
   * saving, and Run would silently execute A's stale on-disk content with no
   * warning beyond an easy-to-miss dirty dot in the tab bar.
   */
  async saveAll(): Promise<void> {
    const dirtyPaths = [...this.state.dirty()];
    await Promise.all(
      dirtyPaths.map(async (path) => {
        const model = this.models.get(path);
        if (!model) return;
        await this.workspace.writeFile(path, model.getValue());
        this.state.markClean(path);
      }),
    );
  }

  /** Drop cached models for a removed path (file or whole folder). */
  dropModels(path: string): void {
    for (const [key, model] of this.models) {
      if (key === path || key.startsWith(path + '/')) {
        model.dispose();
        this.models.delete(key);
      }
    }
  }

  ngOnDestroy(): void {
    this.editor?.dispose();
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
  }
}
