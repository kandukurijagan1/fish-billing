// Aaryan Aqua Needs - Cache-Busting Purge Service Worker
const CACHE_NAME = 'aaryan-aqua-v5.30.0-excel-suite-and-auto-backup';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(name => {
          console.log('[PWA SW] Purging obsolete cache:', name);
          return caches.delete(name);
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // Network direct passthrough to ensure instant updates
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
