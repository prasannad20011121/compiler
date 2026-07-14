import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnInit,
  inject,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { CloudService } from '../core/cloud.service';
import { EditorStateService } from '../core/editor-state.service';
import { TerminalService } from '../core/terminal.service';
import { WorkspaceService } from '../fs/workspace.service';
import { RunnerService } from '../runners/runner.service';
import { Editor } from './editor/editor';
import { FileTree } from './file-tree/file-tree';
import { Tabs } from './tabs/tabs';
import { Terminal } from './terminal/terminal';

@Component({
  selector: 'ide-shell',
  imports: [Editor, FileTree, Tabs, Terminal, RouterLink],
  templateUrl: './ide.html',
  styleUrl: './ide.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Ide implements OnInit {
  protected readonly workspace = inject(WorkspaceService);
  protected readonly state = inject(EditorStateService);
  protected readonly terminal = inject(TerminalService);
  protected readonly runner = inject(RunnerService);
  protected readonly auth = inject(AuthService);
  private readonly cloud = inject(CloudService);
  private readonly router = inject(Router);

  private readonly editor = viewChild.required(Editor);

  async ngOnInit(): Promise<void> {
    await this.workspace.init();
    // Open the first file so the editor isn't empty on first visit.
    const firstFile = this.workspace.tree().find((n) => n.kind === 'file');
    if (firstFile && this.state.tabs().length === 0) {
      this.state.open(firstFile.path);
    }
  }

  @HostListener('document:keydown.control.s', ['$event'])
  onSave(event: Event): void {
    event.preventDefault();
    this.state.requestSave();
  }

  protected async cloudSave(): Promise<void> {
    if (!this.auth.loggedIn()) {
      await this.router.navigateByUrl('/login');
      return;
    }
    const name = prompt('Save workspace to cloud as:', 'my-project');
    if (!name) return;
    try {
      await this.editor().saveActive();
      const saved = await this.cloud.save(name, await this.workspace.snapshot());
      this.terminal.system(`☁ saved “${saved.name}” (${new Date(saved.updatedAt).toLocaleTimeString()})`);
    } catch (e) {
      this.terminal.error(`☁ save failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  protected async run(): Promise<void> {
    if (this.runner.running()) {
      this.runner.stop();
      return;
    }
    const path = this.state.active();
    if (!path || !this.runner.canRun(path)) return;
    await this.editor().saveActive(); // run what you see
    await this.runner.run(path);
  }
}
