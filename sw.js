// Cable Concrete® Block Selection Tool — service worker
// Stale-while-revalidate: serve from cache instantly so the PWA opens fast,
// then refresh in the background so the next launch has the latest.
const CACHE = 'cc-tool-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './og-image.png',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './logo-mark.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // Only handle same-origin GET requests. Let everything else
  // (Google Sheets, OneSignal, Drive embeds, POSTs) pass straight through.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(cached => {
      const networkUpdate = fetch(req)
        .then(res => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached || caches.match('./index.html'));
      return cached || networkUpdate;
    })
  );
});
