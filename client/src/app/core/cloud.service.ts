import { Injectable, inject } from '@angular/core';
import { apiBase } from './api';
import { AuthService } from './auth.service';

export interface CloudProjectMeta {
  id: string;
  name: string;
  updatedAt: string;
  fileCount: number;
}

export interface CloudProject {
  id: string;
  name: string;
  files: { path: string; content: string }[];
}

/** Cloud persistence for projects. Local-first: OPFS stays the working copy. */
@Injectable({ providedIn: 'root' })
export class CloudService {
  private readonly auth = inject(AuthService);

  list(): Promise<CloudProjectMeta[]> {
    return this.request('GET', '/projects');
  }

  save(name: string, files: { path: string; content: string }[]): Promise<CloudProjectMeta> {
    return this.request('POST', '/projects', { name, files });
  }

  load(id: string): Promise<CloudProject> {
    return this.request('GET', `/projects/${id}`);
  }

  delete(id: string): Promise<void> {
    return this.request('DELETE', `/projects/${id}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(apiBase() + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.auth.token ?? ''}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error ?? `request failed (${response.status})`);
    return json as T;
  }
}
