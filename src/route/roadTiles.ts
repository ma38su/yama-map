/**
 * ルート検索に使う道のデータを読み込む。
 *  - 国土地理院ベクトルタイル（最適化ベクトルタイル）の道路中心線。徒歩道の区別あり
 *  - OpenStreetMap（OpenFreeMap が配信する OpenMapTiles 形式）の道。path=登山道/小道、track=林道など
 * 取得したタイルは Service Worker がキャッシュするので、一度読み込んだ範囲・
 * オフライン保存した範囲は圏外でもルート検索できる。
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { tileRange, tileUrl, type LngLat } from '../geo';
import type { RouteLine, WayKind } from './trailRouter';

export const ROAD_TILE_ZOOM = 16;
export const ROAD_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf';
/** これ以上のタイル数になる範囲はルート検索しない（約10km四方） */
export const MAX_ROAD_TILES = 500;

/**
 * 地理院の道路中心線の種類。vt_code の十の位が 2 は徒歩道、3 は石段（一の位は 1:通常部 2:雪覆い 3:橋 4:トンネル）。
 * 高速道路など歩けない道は null。
 */
export function gsiKind(props: Record<string, unknown>): WayKind | null {
  const code = Number(props.vt_code);
  if (props.vt_motorway === 1 || props.vt_rdctg === '高速自動車国道等') return null;
  if ((code >= 2721 && code <= 2724) || (code >= 2731 && code <= 2734)) return 'trail';
  if (props.vt_rdctg === '国道' || props.vt_rdctg === '都道府県道' || props.vt_rdctg === '主要道路') return 'major';
  if (props.vt_rnkwidth === '3m未満') return 'track';
  return 'road';
}

/** OpenMapTiles の transportation レイヤーの道の種類。歩けない道（高速道路・線路など）は null */
export function osmKind(props: Record<string, unknown>): WayKind | null {
  const cls = String(props.class ?? '');
  switch (cls) {
    case 'path':
      return props.subclass === 'cycleway' ? 'road' : 'trail';
    case 'track':
      return 'track';
    case 'minor':
    case 'service':
    case 'raceway':
      return 'road';
    case 'primary':
    case 'secondary':
    case 'tertiary':
    case 'trunk':
      return 'major';
    default:
      return null; // motorway, rail, ferry, busway など
  }
}

type Pt = { x: number; y: number };

/** 線分をタイル範囲 [0, extent] に切り取る（タイル外のバッファ部分を捨てる） */
export function clipLine(line: Pt[], extent: number): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  const inside = (p: Pt) => p.x >= 0 && p.x <= extent && p.y >= 0 && p.y <= extent;
  for (let i = 0; i < line.length - 1; i++) {
    const seg = clipSegment(line[i], line[i + 1], extent);
    if (!seg) {
      if (cur.length > 1) out.push(cur);
      cur = [];
      continue;
    }
    const [a, b] = seg;
    if (cur.length === 0) cur.push(a);
    else {
      const last = cur[cur.length - 1];
      if (last.x !== a.x || last.y !== a.y) {
        if (cur.length > 1) out.push(cur);
        cur = [a];
      }
    }
    cur.push(b);
    if (!inside(line[i + 1])) {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** Liang–Barsky */
function clipSegment(a: Pt, b: Pt, extent: number): [Pt, Pt] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const checks: [number, number][] = [
    [-dx, a.x],
    [dx, extent - a.x],
    [-dy, a.y],
    [dy, extent - a.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [
    { x: a.x + dx * t0, y: a.y + dy * t0 },
    { x: a.x + dx * t1, y: a.y + dy * t1 },
  ];
}

function toLngLat(p: Pt, x: number, y: number, z: number, extent: number): LngLat {
  const n = 2 ** z;
  const px = (x + p.x / extent) / n;
  const py = (y + p.y / extent) / n;
  const lng = px * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * py))) * 180) / Math.PI;
  return [lng, lat];
}

function decodeLines(
  buf: ArrayBuffer | Uint8Array,
  x: number,
  y: number,
  z: number,
  layerName: string,
  kindOf: (props: Record<string, unknown>) => WayKind | null,
): RouteLine[] {
  const tile = new VectorTile(new PbfReader(buf instanceof Uint8Array ? buf : new Uint8Array(buf)));
  const layer = tile.layers[layerName];
  if (!layer) return [];
  const lines: RouteLine[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 2) continue;
    const kind = kindOf(f.properties);
    if (!kind) continue;
    for (const geom of f.loadGeometry()) {
      for (const part of clipLine(geom, f.extent)) {
        lines.push({ coords: part.map((p) => toLngLat(p, x, y, z, f.extent)), kind });
      }
    }
  }
  return lines;
}

export const decodeRoadTile = (buf: ArrayBuffer | Uint8Array, x: number, y: number, z: number) =>
  decodeLines(buf, x, y, z, 'RdCL', gsiKind);
export const decodeOsmTile = (buf: ArrayBuffer | Uint8Array, x: number, y: number, z: number) =>
  decodeLines(buf, x, y, z, 'transportation', osmKind);

/** OpenFreeMap（OpenMapTiles）のタイルの poi 層の点（山小屋・トイレなど。場所の情報を Overpass から取れないときに使う） */
export interface TilePoi {
  cls: string;
  subclass: string;
  name?: string;
  lngLat: LngLat;
}

export function decodeOsmPois(buf: ArrayBuffer | Uint8Array, x: number, y: number, z: number): TilePoi[] {
  const tile = new VectorTile(new PbfReader(buf instanceof Uint8Array ? buf : new Uint8Array(buf)));
  const layer = tile.layers.poi;
  if (!layer) return [];
  const out: TilePoi[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const p = f.loadGeometry()[0]?.[0];
    // タイルの外（となりのタイルと重なる部分）の点は、となりのタイルで数える
    if (f.type !== 1 || !p || p.x < 0 || p.y < 0 || p.x >= f.extent || p.y >= f.extent) continue;
    const name = f.properties['name:ja'] ?? f.properties.name;
    out.push({
      cls: String(f.properties.class ?? ''),
      subclass: String(f.properties.subclass ?? ''),
      name: name ? String(name) : undefined,
      lngLat: toLngLat(p, x, y, z, f.extent),
    });
  }
  return out;
}

function tileUrls(template: string, z: number, bounds: [number, number, number, number]) {
  const r = tileRange(bounds, z);
  const out: { url: string; x: number; y: number }[] = [];
  for (let x = r.minX; x <= r.maxX; x++) {
    for (let y = r.minY; y <= r.maxY; y++) {
      out.push({ url: tileUrl(template, z, x, y), x, y });
    }
  }
  return out;
}

export function roadTileUrls(bounds: [number, number, number, number]) {
  return tileUrls(ROAD_TILE_URL, ROAD_TILE_ZOOM, bounds);
}

/**
 * 時間切れがこの回数たまったら、残りのタイルはネットに聞かず、端末に残っているものだけを使う。
 * つながっているのに電波が弱いと1枚に15秒ずつかかり、最大500枚では30分になるため（圏外ですぐ失敗するタイルは数えない）
 */
const GIVE_UP_AFTER_TIMEOUTS = 8;
const cachedTile = (url: string) => (typeof caches === 'undefined' ? Promise.resolve(undefined) : caches.match(url, { ignoreVary: true }));

/** タイルを同時4本で取って handle に渡す。取れなかった枚数を返す。signal で止めたら AbortError */
async function fetchTiles(
  tiles: { url: string; x: number; y: number }[],
  handle: (buf: ArrayBuffer, x: number, y: number) => void,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  let next = 0;
  let done = 0;
  let failed = 0;
  let timeouts = 0;
  const worker = async () => {
    while (next < tiles.length && !signal?.aborted) {
      const t = tiles[next++];
      try {
        const timeout = AbortSignal.timeout(15_000);
        const res =
          timeouts >= GIVE_UP_AFTER_TIMEOUTS
            ? await cachedTile(t.url)
            : await fetch(t.url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
        if (res?.ok) handle(await res.arrayBuffer(), t.x, t.y);
        else if (res?.status !== 404) failed++;
      } catch (e) {
        if (signal?.aborted) break;
        failed++;
        if (e instanceof DOMException && e.name === 'TimeoutError') timeouts++;
      }
      onProgress?.(++done, tiles.length);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  signal?.throwIfAborted();
  return failed;
}

export interface PlaceLabel {
  text: string;
  lngLat: LngLat;
}

/** 範囲内の地理院の道・徒歩道と地名をすべて取得（同時4接続） */
export async function loadRoadLines(
  bounds: [number, number, number, number],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ lines: RouteLine[]; labels: PlaceLabel[]; failed: number }> {
  const tiles = roadTileUrls(bounds);
  if (tiles.length > MAX_ROAD_TILES) throw new Error('範囲が広すぎます（目的地が遠すぎます）');
  const lines: RouteLine[] = [];
  const labels: PlaceLabel[] = [];
  const failed = await fetchTiles(
    tiles,
    (buf, x, y) => {
      lines.push(...decodeRoadTile(buf, x, y, ROAD_TILE_ZOOM));
      labels.push(...rememberLabels(x, y, decodeLabels(buf, x, y, ROAD_TILE_ZOOM)));
    },
    onProgress,
    signal,
  );
  return { lines, labels, failed };
}

/** 読んだ地名（地理院のタイルごと）。地図をタップするたび・記録に名前を付けるたびに、同じタイルを取り直して読まないように */
const labelCache = new Map<string, PlaceLabel[]>();
/** 覚えておくタイルの数（ルートを作るときの範囲の上限 MAX_ROAD_TILES と同じくらい。地名は1枚に数十なので軽い） */
const LABEL_CACHE_TILES = 600;
function rememberLabels(x: number, y: number, labels: PlaceLabel[]): PlaceLabel[] {
  const key = `${x}/${y}`;
  labelCache.delete(key);
  labelCache.set(key, labels);
  if (labelCache.size > LABEL_CACHE_TILES) labelCache.delete(labelCache.keys().next().value!);
  return labels;
}

// ---------- OpenStreetMap（OpenFreeMap） ----------
export const OSM_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const OSM_ZOOM = 14;
export const OSM_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>';
const OSM_TEMPLATE_KEY = 'yama-map:osm-tiles';
let osmTemplate: Promise<string | null> | null = null;

/** OpenFreeMap のタイルURL（版ごとに変わるので TileJSON から取得。圏外では前回の値） */
export function osmTileTemplate(): Promise<string | null> {
  osmTemplate ??= (async () => {
    try {
      const res = await fetch(OSM_TILEJSON, { signal: AbortSignal.timeout(6000) });
      const url = (await res.json()).tiles?.[0];
      if (typeof url === 'string') {
        try {
          localStorage.setItem(OSM_TEMPLATE_KEY, url);
        } catch {
          /* noop */
        }
        return url;
      }
    } catch {
      /* 圏外など */
    }
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(OSM_TEMPLATE_KEY);
    } catch {
      /* noop */
    }
    if (!saved) osmTemplate = null; // 次回また取りに行く
    return saved;
  })();
  return osmTemplate;
}

export async function osmTileUrls(bounds: [number, number, number, number]) {
  const template = await osmTileTemplate();
  return template ? tileUrls(template, OSM_ZOOM, bounds) : [];
}

/** 範囲内の OpenStreetMap の道をすべて取得。使えなければ空 */
export async function loadOsmLines(bounds: [number, number, number, number], signal?: AbortSignal): Promise<RouteLine[]> {
  const tiles = await osmTileUrls(bounds);
  if (!tiles.length || tiles.length > 100) return [];
  const lines: RouteLine[] = [];
  await fetchTiles(tiles, (buf, x, y) => lines.push(...decodeOsmTile(buf, x, y, OSM_ZOOM)), undefined, signal);
  return lines;
}

/** 注記（山名・温泉・小屋などの地名）を取り出す */
export function decodeLabels(buf: ArrayBuffer | Uint8Array, x: number, y: number, z: number): PlaceLabel[] {
  const tile = new VectorTile(new PbfReader(buf instanceof Uint8Array ? buf : new Uint8Array(buf)));
  const layer = tile.layers.Anno;
  if (!layer) return [];
  const out: PlaceLabel[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const text = String(f.properties.vt_text ?? '').trim();
    // 数字だけ（標高値など）は地名ではない
    if (!text || /^[\d.\s-]+$/.test(text)) continue;
    const p = f.loadGeometry()[0]?.[0];
    if (!p || p.x < 0 || p.y < 0 || p.x > f.extent || p.y > f.extent) continue;
    out.push({ text, lngLat: toLngLat(p, x, y, z, f.extent) });
  }
  return out;
}

/** 地点の近く（radiusM 以内を含むタイル）の地名。前に読んだタイルは読み直さない。圏外などで読めなかったタイルは飛ばす */
export async function placeLabelsNear(points: LngLat[], radiusM: number, signal?: AbortSignal): Promise<PlaceLabel[]> {
  const tiles = new Map<string, { url: string; x: number; y: number }>();
  for (const [lng, lat] of points) {
    const dLat = radiusM / 110_574;
    const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
    for (const t of roadTileUrls([lng - dLng, lat - dLat, lng + dLng, lat + dLat])) tiles.set(t.url, t);
  }
  const labels: PlaceLabel[] = [];
  const need = [...tiles.values()].filter((t) => {
    const hit = labelCache.get(`${t.x}/${t.y}`);
    if (hit) labels.push(...hit);
    return !hit;
  });
  await fetchTiles(need, (buf, x, y) => labels.push(...rememberLabels(x, y, decodeLabels(buf, x, y, ROAD_TILE_ZOOM))), undefined, signal);
  return labels;
}

/** 地点の近く（maxM 以内）にある地名。見つからなければ null（圏外などでも null）。読むのは maxM の範囲にかかるタイルだけ */
export async function nearestPlaceName(p: LngLat, maxM = 250, signal?: AbortSignal): Promise<string | null> {
  const kx = 111_320 * Math.cos((p[1] * Math.PI) / 180);
  let best: { text: string; d: number } | null = null;
  for (const l of await placeLabelsNear([p], maxM, signal).catch(() => [] as PlaceLabel[])) {
    const d = Math.hypot((l.lngLat[0] - p[0]) * kx, (l.lngLat[1] - p[1]) * 110_574);
    if (d <= maxM && (!best || d < best.d)) best = { text: l.text, d };
  }
  return best?.text ?? null;
}
