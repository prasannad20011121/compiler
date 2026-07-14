import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { CloudProjectMeta, CloudService } from '../core/cloud.service';
import { WorkspaceService } from '../fs/workspace.service';

@Component({
  selector: 'ide-dashboard',
  imports: [RouterLink, DatePipe],
  template: `
    <div class="page">
      <header>
        <h1>☁ Cloud projects</h1>
        <span class="spacer"></span>
        <span class="who">{{ auth.email() }}</span>
        <a routerLink="/" class="btn">← IDE</a>
        <button class="btn" (click)="saveCurrent()">Save current workspace…</button>
        <button class="btn danger" (click)="logout()">Sign out</button>
      </header>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <div class="grid">
        @for (project of projects(); track project.id) {
          <div class="card">
            <h2>{{ project.name }}</h2>
            <p>{{ project.fileCount }} files · {{ project.updatedAt | date: 'medium' }}</p>
            <div class="actions">
              <button class="btn" (click)="open(project)">Open in IDE</button>
              <button class="btn danger" (click)="remove(project)">Delete</button>
            </div>
          </div>
        } @empty {
          <p class="empty">
            No cloud projects yet. Use “Save current workspace…” to upload what's in the IDE.
          </p>
        }
      </div>
    </div>
  `,
  styles: `
    .page {
      min-height: 100vh;
      background: var(--ide-editor-bg);
      padding: 24px;
    }
    header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 20px;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      color: var(--ide-fg);
    }
    .spacer {
      flex: 1;
    }
    .who {
      color: var(--ide-fg-dim);
      font-size: 12px;
    }
    .btn {
      background: var(--ide-panel-bg);
      border: 1px solid var(--ide-border);
      color: var(--ide-fg);
      border-radius: 4px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      text-decoration: none;
    }
    .btn:hover {
      background: var(--ide-hover);
    }
    .btn.danger {
      color: #f14c4c;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 14px;
    }
    .card {
      background: var(--ide-sidebar-bg);
      border: 1px solid var(--ide-border);
      border-radius: 8px;
      padding: 16px;
    }
    .card h2 {
      margin: 0 0 6px;
      font-size: 15px;
      color: var(--ide-accent);
    }
    .card p {
      margin: 0 0 12px;
      font-size: 12px;
      color: var(--ide-fg-dim);
    }
    .actions {
      display: flex;
      gap: 8px;
    }
    .empty,
    .error {
      color: var(--ide-fg-dim);
      font-size: 13px;
    }
    .error {
      color: #f14c4c;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly cloud = inject(CloudService);
  private readonly workspace = inject(WorkspaceService);
  private readonly router = inject(Router);

  protected readonly projects = signal<CloudProjectMeta[]>([]);
  protected readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  protected async saveCurrent(): Promise<void> {
    const name = prompt('Save workspace as:', 'my-project');
    if (!name) return;
    try {
      await this.workspace.init();
      await this.cloud.save(name, await this.workspace.snapshot());
      await this.refresh();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'save failed');
    }
  }

  protected async open(project: CloudProjectMeta): Promise<void> {
    if (!confirm(`Replace your local workspace with “${project.name}”?`)) return;
    try {
      const full = await this.cloud.load(project.id);
      await this.workspace.init();
      await this.workspace.replaceAll(full.files);
      // Full reload so editor models and tabs start clean from the new workspace.
      location.href = '/';
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'load failed');
    }
  }

  protected async remove(project: CloudProjectMeta): Promise<void> {
    if (!confirm(`Delete “${project.name}” from the cloud? Local files are unaffected.`)) return;
    try {
      await this.cloud.delete(project.id);
      await this.refresh();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'delete failed');
    }
  }

  protected logout(): void {
    this.auth.logout();
    void this.router.navigateByUrl('/');
  }

  private async refresh(): Promise<void> {
    try {
      this.projects.set(await this.cloud.list());
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'could not load projects');
    }
  }
}
