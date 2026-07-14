import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'ide-login',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="page">
      <form class="card" (ngSubmit)="submit()">
        <h1>browser-ide</h1>
        <p class="sub">
          {{ mode() === 'login' ? 'Sign in to sync projects' : 'Create an account' }} — code always
          runs locally, the cloud only stores files.
        </p>
        <label>
          Email
          <input name="email" type="email" [(ngModel)]="email" required autocomplete="email" />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            [(ngModel)]="password"
            required
            minlength="8"
            autocomplete="current-password"
          />
        </label>
        @if (error()) {
          <p class="error">{{ error() }}</p>
        }
        <button type="submit" [disabled]="busy()">
          {{ busy() ? '…' : mode() === 'login' ? 'Sign in' : 'Register' }}
        </button>
        <button type="button" class="link" (click)="toggleMode()">
          {{ mode() === 'login' ? 'No account? Register' : 'Have an account? Sign in' }}
        </button>
        <a routerLink="/" class="link back">← back to the IDE (works without an account)</a>
      </form>
    </div>
  `,
  styles: `
    .page {
      height: 100vh;
      display: grid;
      place-items: center;
      background: var(--ide-editor-bg);
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: 12px;
      width: min(360px, 90vw);
      padding: 28px;
      background: var(--ide-sidebar-bg);
      border: 1px solid var(--ide-border);
      border-radius: 8px;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      color: var(--ide-accent);
    }
    .sub {
      margin: 0;
      font-size: 12px;
      color: var(--ide-fg-dim);
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: var(--ide-fg-dim);
    }
    input {
      background: var(--ide-editor-bg);
      border: 1px solid var(--ide-border);
      border-radius: 4px;
      color: var(--ide-fg);
      padding: 8px;
      font-size: 13px;
    }
    button[type='submit'] {
      background: var(--ide-statusbar-bg);
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 9px;
      font-size: 13px;
      cursor: pointer;
    }
    button[type='submit']:disabled {
      opacity: 0.5;
    }
    .link {
      background: none;
      border: none;
      color: var(--ide-accent);
      font-size: 12px;
      cursor: pointer;
      text-decoration: none;
      text-align: center;
    }
    .error {
      margin: 0;
      color: #f14c4c;
      font-size: 12px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly mode = signal<'login' | 'register'>('login');
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected email = '';
  protected password = '';

  protected toggleMode(): void {
    this.mode.update((m) => (m === 'login' ? 'register' : 'login'));
    this.error.set(null);
  }

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      if (this.mode() === 'login') {
        await this.auth.login(this.email, this.password);
      } else {
        await this.auth.register(this.email, this.password);
      }
      await this.router.navigateByUrl('/dashboard');
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'something went wrong');
    } finally {
      this.busy.set(false);
    }
  }
}
