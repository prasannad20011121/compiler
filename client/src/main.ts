import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));

// Cache-first service worker for the WASM runtimes and Monaco assets —
// after the first visit, every language works offline.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js');
}
