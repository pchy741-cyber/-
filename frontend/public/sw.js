const CACHE_NAME = 'quantops-v3';
const STATIC_ASSETS = [
  '/manifest.json',
  '/icon-192.svg',
  '/icon-512.svg',
];

// Install: cache only truly static assets (not the page itself)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean up ALL old caches immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Push: 서버에서 푸시 메시지 수신 시 알림 표시
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'QUANTOPS';
  const body = data.body || '';

  // 매매 알림인지 파악해서 강조 표시
  const isTrade = data.tag && (data.tag.startsWith('buy-') || data.tag.startsWith('sell-') || data.tag.startsWith('overseas-'));

  const options = {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'quantops-' + Date.now(),
    renotify: true,           // 같은 tag라도 새 알림으로 표시
    requireInteraction: isTrade, // 매매 알림은 클릭 전까지 유지
    silent: false,
    data: { url: data.url || '/' },
    vibrate: isTrade ? [300, 100, 300, 100, 300] : [200, 100, 200],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// 알림 클릭 시 앱 열기
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// Fetch: network-first for everything except icons/manifest
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Only cache-first for truly static assets (icons, manifest)
  if (STATIC_ASSETS.some((asset) => url.pathname === asset)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Network-first for everything else (pages, JS, API)
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Don't cache API responses or non-ok responses
        if (url.pathname.startsWith('/api') || !response.ok) {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || new Response('Offline', { status: 503 })))
  );
});
