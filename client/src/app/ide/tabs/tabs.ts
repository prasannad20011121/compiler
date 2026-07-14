import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { EditorStateService } from '../../core/editor-state.service';

@Component({
  selector: 'ide-tabs',
  template: `
    @for (tab of state.tabs(); track tab) {
      <div
        class="tab"
        [class.active]="state.active() === tab"
        [title]="tab"
        (click)="state.active.set(tab)"
      >
        <span class="name">{{ tab.split('/').pop() }}</span>
        <span class="marker">{{ state.isDirty(tab) ? '●' : '' }}</span>
        <button class="close" (click)="close(tab, $event)">✕</button>
      </div>
    }
  `,
  styles: `
    :host {
      display: flex;
      align-items: stretch;
      background: var(--ide-panel-bg);
      overflow-x: auto;
      height: 100%;
    }
    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 10px;
      font-size: 13px;
      color: var(--ide-fg-dim);
      background: var(--ide-tab-bg);
      border-right: 1px solid var(--ide-border);
      cursor: pointer;
      white-space: nowrap;
      user-select: none;
    }
    .tab.active {
      background: var(--ide-editor-bg);
      color: var(--ide-fg);
      border-top: 1px solid var(--ide-accent);
    }
    .marker {
      color: var(--ide-accent);
      font-size: 9px;
      width: 8px;
    }
    .close {
      background: none;
      border: none;
      color: var(--ide-fg-dim);
      cursor: pointer;
      font-size: 11px;
      padding: 2px;
      border-radius: 3px;
    }
    .close:hover {
      background: var(--ide-hover);
      color: var(--ide-fg);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Tabs {
  protected readonly state = inject(EditorStateService);

  protected close(tab: string, event: Event): void {
    event.stopPropagation();
    if (this.state.isDirty(tab) && !confirm(`${tab} has unsaved changes. Close anyway?`)) {
      return;
    }
    this.state.close(tab);
  }
}
