/**
 * 場所の情報をネットから取る（マス目ごと）。どの出どころも1つずつ順に聞き、相手のサーバーに負担をかけない：
 *  - Overpass（OpenStreetMap）は混んでいると答えに数十秒かかる。足りないマス目をまとめて1回で聞く。
 *    混んでいる（429・502〜504・時間切れ）と断られたら別のサーバーに聞き直す。
 *  - どの出どころも、取れなかったらしばらく聞かない（続けて取れないと30秒・1分・2分…最大10分と延ばす。電波が戻ったらすぐ聞く）。
 *    取れなかったときは、端末に残っている OpenFreeMap の地図データ（ルート検索・オフライン保存で読んだもの）から
 *    名前と種類だけを出す（partial。あとで Overpass から取り直す）
 *  - iNaturalist は 1秒に1回まで
 */
import { OSM_ZOOM, decodeOsmPois, osmTileUrls } from '../route/roadTiles';
import {
  OVERPASS_ENDPOINTS,
  cellsBounds,
  fromTilePois,
  commonsInfoUrl,
  commonsSearchUrl,
  inatUrl,
  overpassQuery,
  parseCommonsInfo,
  parseCommonsSearch,
  parseInat,
  parseOverpass,
  splitByCell,
  type PlaceItem,
  type RemoteSource,
} from './sources';

/**
 * 取れなかったあと、聞かないでおく時間。続けて取れないと倍々に延ばす。
 * 電波が弱いと onLine のまま通信だけ失敗するので、混んでいると断られたときに限らず待つ（地図を動かすたびに電波をつかみに行かないように）
 */
const COOLDOWN_MIN_MS = 30_000;
const COOLDOWN_MAX_MS = 10 * 60_000;
/** 混んでいると断られたときは、少なくともこれだけ待つ */
const BUSY_COOLDOWN_MS = 2 * 60_000;
const cooldownUntil: Record<RemoteSource, number> = { osm: 0, commons: 0, inat: 0 };
const failStreak: Record<RemoteSource, number> = { osm: 0, commons: 0, inat: 0 };
let overpassIndex = 0;

/** 今は聞かないでおくか（取れなかったあと） */
export const coolingDown = (source: RemoteSource) => Date.now() < cooldownUntil[source];

function cooldown(source: RemoteSource, e: unknown) {
  failStreak[source]++;
  const wait = Math.min(COOLDOWN_MAX_MS, COOLDOWN_MIN_MS * 2 ** (failStreak[source] - 1));
  cooldownUntil[source] = Date.now() + Math.max(wait, isBusy(e) ? BUSY_COOLDOWN_MS : 0);
}
function succeeded(source: RemoteSource) {
  failStreak[source] = 0;
  cooldownUntil[source] = 0;
}
// 電波が戻ったら、すぐ聞けるようにする
window.addEventListener('online', () => {
  for (const s of Object.keys(cooldownUntil) as RemoteSource[]) cooldownUntil[s] = 0;
});

class BusyError extends Error {}

async function getJson(url: string, init: RequestInit & { timeoutMs: number }): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.any([AbortSignal.timeout(init.timeoutMs), ...(init.signal ? [init.signal] : [])]) });
  if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) throw new BusyError(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // 混んでいると、JSON ではなくエラーの HTML・XML が返ることがある
  if (!(res.headers.get('content-type') ?? '').includes('json')) throw new BusyError('JSON ではない答え');
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 出どころごとに、1つずつ順に聞く */
const queues: Record<RemoteSource, Promise<unknown>> = { osm: Promise.resolve(), commons: Promise.resolve(), inat: Promise.resolve() };
function inQueue<T>(source: RemoteSource, fn: () => Promise<T>): Promise<T> {
  const run = queues[source].then(fn, fn);
  queues[source] = run.catch(() => {});
  return run;
}

async function commonsCell(cell: string, signal?: AbortSignal): Promise<PlaceItem[]> {
  const geo = parseCommonsSearch(await getJson(commonsSearchUrl(cell), { signal, timeoutMs: 20_000 }));
  if (!geo.length) return [];
  return parseCommonsInfo(geo, await getJson(commonsInfoUrl(geo.map((g) => g.pageid)), { signal, timeoutMs: 20_000 }));
}

async function inatCell(cell: string, signal?: AbortSignal): Promise<PlaceItem[]> {
  const items = parseInat(await getJson(inatUrl(cell), { signal, timeoutMs: 20_000 }));
  await sleep(1000);
  return items;
}

const isBusy = (e: unknown) => e instanceof BusyError || (e instanceof DOMException && e.name === 'TimeoutError');

/** 混んでいる・答えないサーバーなら、別のサーバーに聞き直す（次からもそのサーバーに聞く） */
async function overpassCells(cells: string[], signal?: AbortSignal): Promise<Map<string, PlaceItem[]>> {
  const body = new URLSearchParams({ data: overpassQuery(cellsBounds(cells)) });
  for (let tries = 1; ; tries++) {
    const endpoint = OVERPASS_ENDPOINTS[overpassIndex % OVERPASS_ENDPOINTS.length];
    try {
      return splitByCell(parseOverpass(await getJson(endpoint, { method: 'POST', body, signal, timeoutMs: 60_000 })), cells);
    } catch (e) {
      if (signal?.aborted || !isBusy(e) || tries >= OVERPASS_ENDPOINTS.length) throw e;
      overpassIndex++;
    }
  }
}

/** 端末の地図データのタイルから読んだ場所（URL ごと。URL に版が入っているので中身は変わらない）。取れないたびに読み直さないように */
const tilePoiCache = new Map<string, PlaceItem[]>();
const TILE_POI_CACHE = 200;

/** 端末に残っている OpenFreeMap の地図データから、山小屋・トイレなどを出す（ネットには聞かない）。1枚もなければ null */
async function cachedTilePois(cells: string[]): Promise<Map<string, PlaceItem[]> | null> {
  if (typeof caches === 'undefined') return null;
  const tiles = await osmTileUrls(cellsBounds(cells)).catch(() => []);
  const items: PlaceItem[] = [];
  let found = 0;
  for (const t of tiles) {
    let pois = tilePoiCache.get(t.url);
    if (!pois) {
      const res = await caches.match(t.url, { ignoreVary: true }).catch(() => undefined);
      if (!res?.ok) continue;
      pois = fromTilePois(decodeOsmPois(await res.arrayBuffer(), t.x, t.y, OSM_ZOOM));
      if (tilePoiCache.size >= TILE_POI_CACHE) tilePoiCache.delete(tilePoiCache.keys().next().value!);
      tilePoiCache.set(t.url, pois);
    }
    found++;
    items.push(...pois);
  }
  return found ? splitByCell(items, cells) : null;
}

export interface FetchOptions {
  signal?: AbortSignal;
  /** まだ要るマス目か（聞く直前に確かめる。地図を動かして見えなくなったマス目は聞かない） */
  keep?: (cell: string) => boolean;
  /** 断られたあとでも聞く（オフライン保存） */
  force?: boolean;
}

/**
 * マス目の場所の情報を取る。onCell は1マス目取れるごとに呼ぶ（地図にすぐ出すため）。
 * 途中で失敗したら例外（それまでに取れたマス目は onCell 済み）
 */
export async function fetchCells(
  source: RemoteSource,
  cells: string[],
  onCell: (cell: string, items: PlaceItem[], partial?: boolean) => void | Promise<void>,
  { signal, keep = () => true, force = false }: FetchOptions = {},
): Promise<void> {
  if (!cells.length || (!force && coolingDown(source))) return;
  const failed = (e: unknown): never => {
    if (!signal?.aborted) cooldown(source, e);
    throw e;
  };
  if (source === 'osm') {
    /** この呼び出しの中で取れなかったときの例外。あとのマス目はネットに聞かず、端末の地図データだけで出す */
    let error: unknown = null;
    // まとめて聞く範囲は、広くなりすぎないよう9マス目ずつ（中心に近い順に並んでいるので、ほぼ 3×3）
    for (let i = 0; i < cells.length; i += 9) {
      const group = cells.slice(i, i + 9).filter(keep);
      if (signal?.aborted) return;
      if (!group.length) continue;
      let got: Map<string, PlaceItem[]> | null = null;
      if (error == null) {
        try {
          got = await inQueue('osm', () => overpassCells(group, signal));
          succeeded('osm');
        } catch (e) {
          if (signal?.aborted) return;
          error = e;
          cooldown('osm', e);
        }
      }
      const partial = !got;
      got ??= await cachedTilePois(group);
      if (!got) throw error;
      for (const [c, items] of got) await onCell(c, items, partial);
    }
    return;
  }
  for (const c of cells) {
    if (signal?.aborted) return;
    if (!keep(c)) continue;
    const items = await inQueue(source, () => (source === 'commons' ? commonsCell(c, signal) : inatCell(c, signal))).catch(failed);
    succeeded(source);
    await onCell(c, items);
  }
}
