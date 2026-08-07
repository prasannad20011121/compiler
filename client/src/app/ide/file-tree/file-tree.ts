import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { EditorStateService } from '../../core/editor-state.service';
import { TreeNode, WorkspaceService } from '../../fs/workspace.service';

@Component({
  selector: 'ide-file-node',
  imports: [],
  template: `
    <div
      class="row"
      [class.active]="node().kind === 'file' && state.active() === node().path"
      [style.padding-left.px]="depth() * 12 + 8"
      (click)="onClick()"
    >
      <span class="twist">
        @if (node().kind === 'directory') {
          {{ expanded() ? '▾' : '▸' }}
        }
      </span>
      <span class="icon">{{ icon() }}</span>
      <span class="name" [class.dirty]="state.isDirty(node().path)">{{ node().name }}</span>
      <span class="actions" (click)="$event.stopPropagation()">
        @if (node().kind === 'directory') {
          <button title="New file" (click)="newFile()">+</button>
        }
        <button title="Rename" (click)="rename()">✎</button>
        <button title="Delete" (click)="remove()">✕</button>
      </span>
    </div>
    @if (node().kind === 'directory' && expanded()) {
      @for (child of node().children; track child.path) {
        <ide-file-node [node]="child" [depth]="depth() + 1" />
      }
    }
  `,
  styles: `
    .row {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 24px;
      cursor: pointer;
      font-size: 13px;
      color: var(--ide-fg);
      white-space: nowrap;
    }
    .row:hover {
      background: var(--ide-hover);
    }
    .row.active {
      background: var(--ide-selection);
    }
    .twist {
      width: 10px;
      font-size: 10px;
      color: var(--ide-fg-dim);
      flex: none;
    }
    .icon {
      flex: none;
      font-size: 12px;
    }
    .name {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .name.dirty::after {
      content: ' ●';
      color: var(--ide-accent);
      font-size: 9px;
    }
    .actions {
      display: none;
      margin-left: auto;
      padding-right: 6px;
      gap: 2px;
    }
    .row:hover .actions {
      display: flex;
    }
    .actions button {
      background: none;
      border: none;
      color: var(--ide-fg-dim);
      cursor: pointer;
      font-size: 11px;
      padding: 0 3px;
    }
    .actions button:hover {
      color: var(--ide-fg);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FileNode {
  protected readonly state = inject(EditorStateService);
  private readonly workspace = inject(WorkspaceService);

  readonly node = input.required<TreeNode>();
  readonly depth = input(0);
  protected readonly expanded = signal(true);

  protected icon(): string {
    if (this.node().kind === 'directory') return '📁';
    const ext = this.node().name.split('.').pop()?.toLowerCase();
    const icons: Record<string, string> = {
      js: '🟨',
      mjs: '🟨',
      ts: '🟦',
      py: '🐍',
      c: '🌊',
      h: '🌊',
      cpp: '🌊',
      cc: '🌊',
      hpp: '🌊',
      json: '⚙️',
      md: '📘',
      html: '🌐',
      css: '🎨',
    };
    return icons[ext ?? ''] ?? '📄';
  }

  protected onClick(): void {
    if (this.node().kind === 'directory') {
      this.expanded.update((v) => !v);
    } else {
      this.state.open(this.node().path);
    }
  }

  protected async newFile(): Promise<void> {
    const name = prompt('New file name:');
    if (!name) return;
    await this.workspace.writeFile(`${this.node().path}/${name}`, '');
    this.state.open(`${this.node().path}/${name}`);
  }

  protected async rename(): Promise<void> {
    const name = prompt('Rename to:', this.node().name);
    if (!name || name === this.node().name) return;
    const oldPath = this.node().path;
    await this.workspace.rename(oldPath, name);
    this.state.handlePathRemoved(oldPath);
  }

  protected async remove(): Promise<void> {
    if (!confirm(`Delete ${this.node().path}?`)) return;
    await this.workspace.delete(this.node().path);
    this.state.handlePathRemoved(this.node().path);
  }
}

@Component({
  selector: 'ide-file-tree',
  imports: [FileNode],
  template: `
    <div class="header">
      <span class="title">EXPLORER</span>
      <span class="actions">
        <button title="New file" (click)="newFile()">＋</button>
        <button title="New folder" (click)="newFolder()">🗀</button>
        <button title="Refresh" (click)="workspace.refresh()">⟳</button>
      </span>
    </div>
    <div class="tree">
      @for (node of workspace.tree(); track node.path) {
        <ide-file-node [node]="node" />
      } @empty {
        <p class="empty">No files yet. Create one with ＋</p>
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--ide-sidebar-bg);
      overflow: hidden;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px 6px;
      flex: none;
    }
    .title {
      font-size: 11px;
      letter-spacing: 0.08em;
      color: var(--ide-fg-dim);
    }
    .actions {
      display: flex;
      gap: 4px;
    }
    .actions button {
      background: none;
      border: none;
      color: var(--ide-fg-dim);
      cursor: pointer;
      font-size: 13px;
      padding: 0 2px;
    }
    .actions button:hover {
      color: var(--ide-fg);
    }
    .tree {
      overflow: auto;
      flex: 1;
    }
    .empty {
      color: var(--ide-fg-dim);
      font-size: 12px;
      padding: 8px 12px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FileTree {
  protected readonly workspace = inject(WorkspaceService);
  private readonly state = inject(EditorStateService);

  protected async newFile(): Promise<void> {
    const name = prompt('New file name (e.g. main.py):');
    if (!name) return;
    await this.workspace.writeFile(name, '');
    this.state.open(name);
  }

  protected async newFolder(): Promise<void> {
    const name = prompt('New folder name:');
    if (!name) return;
    await this.workspace.createFolder(name);
  }
}
