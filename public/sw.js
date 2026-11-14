/*
 * やまマップ Service Worker
 *  - アプリ本体: ページは「ネットワーク優先（4秒でキャッシュへ切替）」、その他は stale-while-revalidate
 *  - 地図・標高・道データのタイル（地理院・OpenFreeMap）: キャッシュ優先。一度表示した/保存した範囲は圏外でも使える
 */
const SHELL_CACHE = 'yama-map-shell-v1';
const TILE_CACHE = 'yama-map-tiles-v1'; // src/offline/download.ts と同じ名前
const TILE_HOSTS = new Set(['cyberjapandata.gsi.go.jp', 'tiles.openfreemap.org']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(['./', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, TILE_CACHE]);
      for (const key of await caches.keys()) {
        if (key.startsWith('yama-map-') && !keep.has(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'tiles.openfreemap.org' && url.pathname === '/planet') {
    // OpenFreeMap の TileJSON（版が変わる）はネットワーク優先、圏外ならキャッシュ
    event.respondWith(networkFirst(req, TILE_CACHE));
  } else if (TILE_HOSTS.has(url.hostname)) {
    event.respondWith(tileCacheFirst(req));
  } else if (url.origin === self.location.origin) {
    event.respondWith(req.mode === 'navigate' ? pageNetworkFirst(req) : staleWhileRevalidate(req));
  }
});

async function tileCacheFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req.url, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  // 404 はデータなし（海など）なので、それも覚えておく
  if (res.ok || res.status === 404) cache.put(req.url, res.clone()).catch(() => {});
  return res;
}

async function pageNetworkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    if (res.ok) cache.put('./', res.clone()).catch(() => {});
    return res;
  } catch {
    return (await cache.match('./', { ignoreVary: true })) || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL_CACHE);
  // サーバーが Vary: Origin を返すと、type=module の読み込み（Origin付き）と照合できないため ignoreVary
  const hit = await cache.match(req, { ignoreVary: true });
  const update = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => undefined);
  return hit || (await update) || Response.error();
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    if (res.ok) cache.put(req.url, res.clone()).catch(() => {});
    return res;
  } catch {
    return (await cache.match(req.url, { ignoreVary: true })) || Response.error();
  }
}
