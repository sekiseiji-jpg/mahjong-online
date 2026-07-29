// 麻雀オンライン Service Worker — インストール可能化＋牌画像/アイコンのキャッシュ
// ※ HTML本体・/health・WebSocket はキャッシュせず常に最新を取得(更新反映のため)
const CACHE = 'mj-v1';
const ASSETS = ['./tiles.png', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon-32.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.map((k) => (k !== CACHE ? caches.delete(k) : null))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;                    // WebSocket等は対象外
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;            // 外部はそのまま
  const isAsset = ASSETS.some((a) => url.pathname.endsWith(a.slice(1)));
  if (!isAsset) return;                                       // HTML/healthはネット任せ
  // 画像・アイコンはキャッシュ優先(なければ取得してキャッシュ)
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request).then((resp) => {
      const cp = resp.clone();
      caches.open(CACHE).then((c) => c.put(e.request, cp));
      return resp;
    }))
  );
});
