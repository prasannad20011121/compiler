import { Injectable, computed, signal } from '@angular/core';
import { apiBase } from './api';

interface StoredAuth {
  token: string;
  email: string;
}

const STORAGE_KEY = 'browser-ide.auth';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly auth = signal<StoredAuth | null>(this.restore());

  readonly email = computed(() => this.auth()?.email ?? null);
  readonly loggedIn = computed(() => this.auth() !== null);

  get token(): string | null {
    return this.auth()?.token ?? null;
  }

  async login(email: string, password: string): Promise<void> {
    await this.request('login', email, password);
  }

  async register(email: string, password: string): Promise<void> {
    await this.request('register', email, password);
  }

  logout(): void {
    this.auth.set(null);
    localStorage.removeItem(STORAGE_KEY);
  }

  private async request(kind: 'login' | 'register', email: string, password: string): Promise<void> {
    const response = await fetch(`${apiBase()}/auth/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `${kind} failed`);
    const stored: StoredAuth = { token: body.token, email: body.email };
    this.auth.set(stored);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  }

  private restore(): StoredAuth | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as StoredAuth) : null;
    } catch {
      return null;
    }
  }
}
