/*
 * やまマップ Service Worker。vite.config.ts の serviceWorker() が、このビルドのファイル一覧と版の名前を
 * 下の VERSION・PRECACHE に埋め込んで dist/sw.js に出す。
 *  - アプリ本体: インストール時にこの版のファイルをすべてキャッシュする。ページはネットワーク優先（4秒でキャッシュへ切替）、
 *    ほかはキャッシュ優先。版ごとにキャッシュを分け、新しい版が有効になったら古い版は消す
 *  - 地図・標高・道データのタイル（地理院・OpenFreeMap）と、場所の情報の写真（Wikimedia Commons・iNaturalist）はキャッシュ優先で、2つに分ける
 *      保存した地図（yama-map-tiles-v1）: メニューの「ルート沿いを保存」などで入れたもの。消すまで残す
 *      表示しただけの地図（yama-map-browse-v1）: 最大 BROWSE_MAX 枚（古いものから消す）。30日経ったら、つながるときに取り直す
 *  - アプリ版（?native=1 で登録）: アプリ本体は APK に入っているので扱わず、地図タイルだけを扱う
 */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL_CACHE = `yama-map-shell-${VERSION}`;
const TILE_CACHE = 'yama-map-tiles-v1'; // src/offline/download.ts と同じ名前
const BROWSE_CACHE = 'yama-map-browse-v1'; // 同上
/** 表示しただけの地図を残す枚数（1枚 20〜30KB ほどで、60〜90MB） */
const BROWSE_MAX = 3000;
const BROWSE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** 表示しただけの地図に付ける、取ってきた時刻のヘッダー（地理院の Date ヘッダーはページから読めないため） */
const FETCHED_AT = 'x-yama-fetched';
const TILE_HOSTS = new Set([
  'cyberjapandata.gsi.go.jp',
  'tiles.openfreemap.org',
  // 場所の情報の写真（CORS で読んだものだけ残せる。app/places.ts は CORS で読む）
  'upload.wikimedia.org',
  'thumb.wikimedia.org',
  'inaturalist-open-data.s3.amazonaws.com',
  'static.inaturalist.org',
]);
const NATIVE = new URL(self.location.href).searchParams.has('native');

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (!NATIVE) {
        const cache = await caches.open(SHELL_CACHE);
        // ブラウザの HTTP キャッシュにある古いページを入れないよう、取り直す
        await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, TILE_CACHE, BROWSE_CACHE]);
      for (const key of await caches.keys()) {
        if (key.startsWith('yama-map-') && !keep.has(key)) await caches.delete(key);
      }
      await trimBrowse();
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
    event.respondWith(tile(req, event));
  } else if (!NATIVE && url.origin === self.location.origin) {
    event.respondWith(req.mode === 'navigate' ? page(req) : shell(req));
  }
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

async function tile(req, event) {
  const hit = await (await caches.open(TILE_CACHE)).match(req.url, { ignoreVary: true });
  if (hit) return hit;
  const browse = await caches.open(BROWSE_CACHE);
  const seen = await browse.match(req.url, { ignoreVary: true });
  if (seen && !(navigator.onLine && isOld(seen))) return seen;
  try {
    const res = await fetch(req);
    // 404 はデータなし（海など）なので、それも覚えておく
    if (res.ok || res.status === 404) event.waitUntil(putBrowse(browse, req.url, res.clone()));
    return res;
  } catch (e) {
    if (seen) return seen; // 取り直せなければ古いものを使う
    throw e;
  }
}

function isOld(res) {
  const at = Number(res.headers.get(FETCHED_AT));
  return at > 0 && Date.now() - at > BROWSE_MAX_AGE_MS;
}

async function putBrowse(cache, url, res) {
  const headers = new Headers({ [FETCHED_AT]: String(Date.now()) });
  const type = res.headers.get('content-type');
  if (type) headers.set('content-type', type);
  try {
    await cache.put(url, new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers }));
  } catch {
    return; // 容量が足りないなど
  }
  // 枚数の確認は、ときどきだけ（毎回すべてのキーを読むと重い）
  if (Math.random() < 1 / 50) await trimBrowse();
}

/** 表示しただけの地図を BROWSE_MAX 枚までにする（キャッシュは入れた順に並ぶので、先頭から消す） */
async function trimBrowse() {
  const cache = await caches.open(BROWSE_CACHE);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - BROWSE_MAX; i++) await cache.delete(keys[i]);
}

async function page(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await Promise.race([fetch(req), timeout(4000)]);
    if (res.ok) cache.put('./', res.clone()).catch(() => {});
    return res;
  } catch {
    return (await cache.match('./', { ignoreVary: true })) || Response.error();
  }
}

async function shell(req) {
  const cache = await caches.open(SHELL_CACHE);
  // サーバーが Vary: Origin を返すと、type=module の読み込み（Origin付き）と照合できないため ignoreVary
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([fetch(req), timeout(4000)]);
    if (res.ok) cache.put(req.url, res.clone()).catch(() => {});
    return res;
  } catch {
    return (await cache.match(req.url, { ignoreVary: true })) || Response.error();
  }
}
