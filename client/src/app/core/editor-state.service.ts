import { Injectable, computed, signal } from '@angular/core';
import { Subject } from 'rxjs';

/** Open tabs, active file, and dirty tracking for the editor area. */
@Injectable({ providedIn: 'root' })
export class EditorStateService {
  readonly tabs = signal<string[]>([]);
  readonly active = signal<string | null>(null);
  readonly dirty = signal<ReadonlySet<string>>(new Set());

  readonly activeName = computed(() => this.active()?.split('/').pop() ?? null);

  private readonly saveRequests = new Subject<void>();
  /** Emitted on Ctrl+S; the editor component persists the active model. */
  readonly saveRequest$ = this.saveRequests.asObservable();

  requestSave(): void {
    this.saveRequests.next();
  }

  open(path: string): void {
    if (!this.tabs().includes(path)) {
      this.tabs.update((tabs) => [...tabs, path]);
    }
    this.active.set(path);
  }

  close(path: string): void {
    this.tabs.update((tabs) => tabs.filter((t) => t !== path));
    this.markClean(path);
    if (this.active() === path) {
      const remaining = this.tabs();
      this.active.set(remaining.length ? remaining[remaining.length - 1] : null);
    }
  }

  /** Close tabs for a deleted/renamed path, including everything under a folder. */
  handlePathRemoved(path: string): void {
    const affected = this.tabs().filter((t) => t === path || t.startsWith(path + '/'));
    for (const tab of affected) this.close(tab);
  }

  isDirty(path: string): boolean {
    return this.dirty().has(path);
  }

  markDirty(path: string): void {
    this.dirty.update((set) => new Set(set).add(path));
  }

  markClean(path: string): void {
    this.dirty.update((set) => {
      const next = new Set(set);
      next.delete(path);
      return next;
    });
  }
}
