// BUILD_HASH is replaced at build time by vite plugin — changing this triggers SW update detection
const BUILD_HASH = '05baa1c7';
const CACHE_NAME = `openclaw-${BUILD_HASH}`;
const PRECACHE_URLS = [
  '/',
  '/index.html',
];

// Install event - cache essential resources, wait for user to confirm update
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  // Do NOT skipWaiting here — let the client show UpdateBanner first
  // skipWaiting is triggered by SKIP_WAITING message from the client
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  // Take control of all clients immediately
  self.clients.claim();
});

// Fetch event - network-first for navigation, cache-first for assets
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET, non-http(s), and WebSocket requests
  if (request.method !== 'GET' || request.url.includes('/ws')) return;
  if (!request.url.startsWith('http')) return;

  // Network-first for navigation
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for static assets
  if (request.url.match(/\.(js|css|png|svg|jpg|jpeg|woff2?)$/)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }
});

// Listen for messages from clients (user-controlled update)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

