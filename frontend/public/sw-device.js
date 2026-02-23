const VERSION = 'xr-device-v1';

const STATIC_ASSETS = [
  '/device', // HTML shell
  '/public/css/common.css',
  '/public/css/device.css',
  '/public/css/styles.css',
  '/public/js/app.js',
  '/public/js/config.js',
  '/public/js/device.js',
  '/public/js/ui.js',
  '/public/js/signaling.js',
  '/public/js/voice.js',
  '/public/js/telemetry.js',
  '/public/js/webrtc-quality.js',
  '/public/js/messages.js',
  '/public/images/xr-logo-192.png',
  '/public/images/xr-logo-512.png'
];

// JS that must stay fresh to avoid SDP/ICE mismatches after an update
const CRITICAL_JS = new Set([
  '/public/js/app.js',
  '/public/js/config.js',
  '/public/js/device.js',
  '/public/js/signaling.js'
]);

// Dynamic/proxied endpoints that should never be cached by the SW
const DYNAMIC_PREFIXES = ['/api', '/notes', '/soap', '/scribe', '/openai', '/ai'];

self.addEventListener('install', (evt) => {
  evt.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Bypass the HTTP cache on install so we always prime with fresh assets
    await Promise.all(
      STATIC_ASSETS.map(p => cache.add(new Request(p, { cache: 'reload' })))
    );
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));

    // Enable Navigation Preload for faster document loads
    if (self.registration && self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }

    self.clients.claim();
  })());
});

self.addEventListener('fetch', (evt) => {
  const req = evt.request;
  const url = new URL(req.url);

  // NEVER touch Socket.IO / websockets
  if (url.pathname.startsWith('/socket.io')) return;

  // Only handle GET
  if (req.method !== 'GET') return;

  // Bypass dynamic/proxied endpoints completely (network only)
  if (DYNAMIC_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return;

  // Documents: network-first; if nav preload is available, use it
  if (req.destination === 'document') {
    evt.respondWith((async () => {
      try {
        const preload = await evt.preloadResponse;
        if (preload) return preload;
        return await fetch(req, { cache: 'no-store' });
      } catch {
        const cache = await caches.open(VERSION);
        const cached = await cache.match('/device');
        return cached || Response.error();
      }
    })());
    return;
  }

  // Critical scripts: network-first with cached fallback to avoid stale WebRTC/signaling
  if (req.destination === 'script' && CRITICAL_JS.has(url.pathname)) {
    evt.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        // update cache in background
        const cache = await caches.open(VERSION);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(VERSION);
        const cached = await cache.match(req);
        return cached || Response.error();
      }
    })());
    return;
  }

  // Everything else: stale-while-revalidate for static assets
  evt.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req);
    const fetcher = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fetcher;
  })());
});
