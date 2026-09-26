// オフライン用に画面を保存する。オンライン時は古い画面を返さず最新版を優先する。
const CACHE = 'asin-scanner-v1.5.2';

const SHELL = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/keepa.js',
  './js/profit.js',
  './js/chart.js',
  './js/scanner.js',
  './js/store.js',
  './vendor/zxing.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE)
      // Firefox の HTTP キャッシュから旧版を新しい CacheStorage に写さない。
      .then((c) => c.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('asin-scanner-v') && k !== CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Keepa/GASへの問い合わせは毎回ネットに行く。キャッシュすると古い相場を見てしまう
  if (url.origin !== self.location.origin) return;

  // ?gas= を含むURLを端末のキャッシュキーに保存しない。
  const cacheKey = req.mode === 'navigate' ? new Request(self.registration.scope) : req;
  const networkRequest = req.mode === 'navigate' ? cacheKey : req;
  ev.respondWith(
    fetch(networkRequest, { cache: 'no-store' }).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        ev.waitUntil(caches.open(CACHE).then((c) => c.put(cacheKey, copy)));
      }
      return res;
    }).catch(async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match(cacheKey)) || Response.error();
    })
  );
});
