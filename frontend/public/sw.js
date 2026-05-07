const CACHE_NAME = 'quantops-v6';
const STATIC_ASSETS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// Install: cache only truly static assets (not the page itself)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
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

// ══════════════════════════════════════
//  Push 알림 수신 핸들러
// ══════════════════════════════════════
self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) data = event.data.json();
  } catch {
    try {
      const text = event.data ? event.data.text() : '';
      data = { title: 'QUANTOPS', body: text || '새 알림이 도착했습니다.' };
    } catch {
      data = { title: 'QUANTOPS', body: '새 알림이 도착했습니다.' };
    }
  }

  const title = data.title || 'QUANTOPS';
  const body = data.body || '새 알림이 도착했습니다.';
  const tag = data.tag || ('quantops-' + Date.now());
  const url = data.url || '/';

  const isBuy = tag.startsWith('buy-') || tag.startsWith('overseas-buy-');
  const isSell = tag.startsWith('sell-') || tag.startsWith('overseas-sell-');
  const isAlert = tag.startsWith('alert');
  const isTrade = isBuy || isSell;

  // 손익 색상 기반 긴급도
  const isLoss = isSell && (body.includes('-') || title.includes('-'));
  const isProfit = isSell && title.includes('+');

  let actions = [];
  if (isBuy) {
    actions = [
      { action: 'open-dashboard', title: '📊 대시보드' },
      { action: 'open-trades', title: '📋 매매내역' },
    ];
  } else if (isSell) {
    actions = [
      { action: 'open-trades', title: '📋 매매내역 확인' },
      { action: 'open-dashboard', title: '📊 대시보드' },
    ];
  } else {
    actions = [
      { action: 'open-dashboard', title: '🔍 확인하기' },
    ];
  }

  // 진동 패턴: 매수(짧고 경쾌), 매도-이익(길게), 매도-손실(긴급), 알림(표준)
  let vibrate;
  if (isBuy) {
    vibrate = [100, 50, 100]; // 경쾌
  } else if (isSell && isLoss) {
    vibrate = [500, 100, 500, 100, 500]; // 긴급
  } else if (isSell && isProfit) {
    vibrate = [200, 50, 200, 50, 400]; // 축하
  } else if (isAlert) {
    vibrate = [300, 100, 300, 100, 300, 100, 300]; // 경보
  } else {
    vibrate = [200, 100, 200];
  }

  const options = {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag,
    renotify: true,
    // 매매/긴급 알림은 사용자가 직접 닫을 때까지 유지
    requireInteraction: isTrade || isAlert,
    silent: false,
    timestamp: data.timestamp || Date.now(),
    data: {
      url,
      stockCode: data.data?.stockCode,
      action: data.data?.action,
      price: data.data?.price,
      qty: data.data?.qty,
      pnlPct: data.data?.pnlPct,
      pnlKrw: data.data?.pnlKrw,
    },
    vibrate,
    actions,
  };

  event.waitUntil(
    self.registration.showNotification(title, options).catch(() =>
      self.registration.showNotification(title, { body, icon: '/icon-192.png', tag, data: { url } })
    )
  );
});

// ══════════════════════════════════════
//  알림 클릭 핸들러
// ══════════════════════════════════════
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  let url = event.notification.data?.url || '/';
  if (event.action === 'open-trades') url = '/?tab=trades';
  if (event.action === 'open-dashboard') url = '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // 이미 열린 탭이 있으면 포커스 후 해당 URL로 이동
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(url);
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// 알림 닫기 이벤트 (analytics용, 선택적)
self.addEventListener('notificationclose', (_event) => {
  // 닫힌 알림 추적 가능
});

// ══════════════════════════════════════
//  Fetch: network-first
// ══════════════════════════════════════
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // 정적 에셋만 캐시 우선
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

  // 나머지는 network-first
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (url.pathname.startsWith('/api') || !response.ok) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || new Response('Offline', { status: 503 })))
  );
});
