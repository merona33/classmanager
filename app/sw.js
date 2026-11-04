// 담임의 노트 — Service Worker
// 오프라인 사용을 위해 모든 리소스를 캐시합니다.

const CACHE = 'classmanager-v29';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './config.js',
  './sync.js',
  './notify.js',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 캐시 우선, 없으면 네트워크, 응답 받으면 캐시에 저장
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // 동기화 서버(Firebase 등) 요청은 서비스 워커가 건드리지 않는다
  if (new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          // Only cache successful same-origin responses
          if (response.ok && new URL(event.request.url).origin === location.origin) {
            const clone = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});

// 일정 알림을 누르면 열려 있는 앱 창으로 이동(없으면 새로 연다)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow ? self.clients.openWindow('./') : undefined;
    })
  );
});
