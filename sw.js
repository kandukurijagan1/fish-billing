// Aaryan Aqua Needs - Professional PWA Offline Shell Service Worker
const CACHE_NAME = 'aaryan-aqua-pwa-v5.4.7';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './index.css',
  './index_v5.js',
  './invoice_utils_v5.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './lord_ganesha.jpg',
  './lord_hanuman.jpg',
  './signature.png',
  './rallis_logo.png',
  './mqtt.min.js',
  './jsqr.min.js'
];

// URLs that must NEVER be cached (real-time cloud mesh & external APIs)
const BYPASS_CACHE_DOMAINS = [
  'script.google.com',
  'script.googleusercontent.com',
  'broker.emqx.io',
  'broker.hivemq.com',
  'test.mosquitto.org',
  'api.qrserver.com'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Pre-cache individual assets safely so one missing file does not abort installation
      return Promise.allSettled(
        PRECACHE_ASSETS.map(url => 
          fetch(url, { cache: 'no-cache' })
            .then(res => {
              if (res && res.status === 200) {
                return cache.put(url, res);
              }
            })
            .catch(err => {
              console.warn('[PWA SW] Pre-cache skip for:', url, err.message);
            })
        )
      );
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(name => {
          if (name !== CACHE_NAME) {
            console.log('[PWA SW] Purging obsolete cache:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;

  const url = new URL(req.url);

  // Bypass cloud sync and external WebSocket/MQTT streams
  if (BYPASS_CACHE_DOMAINS.some(domain => url.hostname.includes(domain))) {
    return; // Standard network fetch
  }

  // Network-First with Cache Fallback for maximum freshness and 100% offline support
  event.respondWith(
    fetch(req)
      .then(networkResponse => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(req, resClone).catch(() => {});
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        // Network unavailable or offline: return cached response
        const cached = await caches.match(req);
        if (cached) return cached;
        // If navigating to a page offline, return index.html shell
        if (req.mode === 'navigate') {
          const fallbackShell = await caches.match('./index.html') || await caches.match('./');
          if (fallbackShell) return fallbackShell;
        }
        return new Response('Network offline. Please check your internet connection.', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain' }
        });
      })
  );
});
