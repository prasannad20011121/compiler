/**
 * browser-ide service worker: cache-first for the big immutable assets
 * (WASM language runtimes and Monaco), so after the first visit each
 * language works offline and never re-downloads. Versioned paths make
 * the cached entries immutable; bumping a version in runtimes.json
 * naturally produces new URLs.
 */
const CACHE = 'browser-ide-static-v1';
const CACHED_PREFIXES = ['/runtimes/', '/monaco/'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (!CACHED_PREFIXES.some((p) => url.pathname.startsWith(p))) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const response = await fetch(event.request);
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    }),
  );
});
