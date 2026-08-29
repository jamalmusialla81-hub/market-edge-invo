const CACHE = 'market-edge-v17';
const APP_SHELL = ['./', './index.html', './market-edge.html', './research-engine.js?v=14', './quant-engine.js?v=14', './tradingview-compat.js?v=14', './forward-engine.js?v=14', './manual-trade-engine.js?v=15', './ml-engine.js?v=15', './ai-config.js?v=14', './ai-engine.js?v=14', './ai-ui.js?v=14', './manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match('./market-edge.html'))));
});
