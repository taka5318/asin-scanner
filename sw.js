// アプリの見た目部分だけを端末に持たせる。
// 店舗の電波が弱くても画面はすぐ開き、通信はKeepa/GASの問い合わせだけで済む。
// APP_VERSION を上げると下のキャッシュ名も変わり、古い版が自動で捨てられる。
const CACHE = 'asin-scanner-v1.2.0';

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
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Keepa/GASへの問い合わせは毎回ネットに行く。キャッシュすると古い相場を見てしまう
  if (url.origin !== self.location.origin) return;

  ev.respondWith(
    caches.match(req).then((hit) => {
      // 画面のファイルは「まずキャッシュ、裏で更新」。起動が速く、次回から新しくなる
      const fresh = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || fresh;
    })
  );
});
