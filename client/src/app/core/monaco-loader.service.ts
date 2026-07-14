import { Injectable } from '@angular/core';
import type * as Monaco from 'monaco-editor';

declare global {
  interface Window {
    monaco: typeof Monaco;
    require: {
      (deps: string[], onLoad: () => void): void;
      config(options: { paths: Record<string, string> }): void;
    };
  }
}

/**
 * Loads Monaco from our own static assets (copied from node_modules by angular.json)
 * using its AMD loader. Same-origin only — no CDN. The loader also spawns Monaco's
 * language workers (TS/JS IntelliSense) from the same assets path.
 */
@Injectable({ providedIn: 'root' })
export class MonacoLoaderService {
  private loading: Promise<typeof Monaco> | null = null;

  load(): Promise<typeof Monaco> {
    this.loading ??= new Promise<typeof Monaco>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'monaco/vs/loader.js';
      script.onerror = () => reject(new Error('Failed to load Monaco loader from assets'));
      script.onload = () => {
        window.require.config({ paths: { vs: 'monaco/vs' } });
        window.require(['vs/editor/editor.main'], () => resolve(window.monaco));
      };
      document.head.appendChild(script);
    });
    return this.loading;
  }
}
