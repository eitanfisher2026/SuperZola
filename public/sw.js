// Versioned so `activate` below actually has something to clean up when this
// changes — bump it whenever the caching strategy itself changes (not on
// every app release; app.compiled.js is already cache-busted by its own
// ?v= query string in index.html).
const CACHE = 'superzola-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => clients.claim())
  );
});

// Network-first, same-origin only — cross-origin CDN scripts (React,
// Firebase, Tailwind) are left untouched so the browser's own fetch/cache/
// retry behavior applies there, same as if this SW didn't exist.
//
// Every successful same-origin response gets stashed in CACHE as it goes by,
// so a later fetch failure (flaky connection, long time since last opened)
// has a real last-known-good response to fall back to.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
