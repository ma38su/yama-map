/** 経度・緯度の組 [lng, lat] */
export type LngLat = [number, number];

const EARTH_RADIUS_M = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

/** 2点間の大圏距離 (m) */
export function distance(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** a から b への方位（北から時計回りの度、-180〜180） */
export function bearing(a: LngLat, b: LngLat): number {
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
  const x = Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) - Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** 地図のズーム z・緯度 lat で、画面の1px が何 m か（MapLibre の 512px のタイル） */
export const metersPerPixel = (lat: number, z: number) => (2 * Math.PI * 6378137 * Math.cos(toRad(lat))) / (512 * 2 ** z);

/**
 * 進む向きの矢印の形（地面に置く多角形）。center を中心に、向き deg（北から時計回り）へ尖った矢じり。
 * size は先端から中心までの長さ (m)
 */
export function arrowPolygon(center: LngLat, deg: number, size: number): LngLat[] {
  const r = toRad(deg);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const mLng = 111_320 * Math.cos(toRad(center[1]));
  // 北向きの矢じり（x 東・y 北、m）を時計回りに回す
  const shape: [number, number][] = [
    [0, 1],
    [0.72, -0.62],
    [0, -0.3],
    [-0.72, -0.62],
    [0, 1],
  ];
  return shape.map(([x, y]): LngLat => {
    const e = (x * cos + y * sin) * size;
    const n = (-x * sin + y * cos) * size;
    return [center[0] + e / mLng, center[1] + n / 110_574];
  });
}

/** Webメルカトルのタイル座標（小数あり）。整数部がタイル番号、小数部がタイル内位置 */
export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const latRad = toRad(Math.max(-85.0511, Math.min(85.0511, lat)));
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

/**
 * 傾き・回転なしで見たときの表示範囲 (west, south, east, north)。
 * 3D表示で地平線まで見えていても、真上から見た範囲で計算する（オフライン保存用）。
 */
export function viewBounds(
  center: LngLat,
  zoom: number,
  widthPx: number,
  heightPx: number,
  tileSize = 512,
): [number, number, number, number] {
  const scale = tileSize * 2 ** zoom;
  const c = lngLatToTile(center[0], center[1], 0);
  const cx = c.x * scale;
  const cy = c.y * scale;
  const toLngLat = (x: number, y: number): LngLat => [
    (x / scale) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale))) * 180) / Math.PI,
  ];
  const [w, n] = toLngLat(cx - widthPx / 2, cy - heightPx / 2);
  const [e, s] = toLngLat(cx + widthPx / 2, cy + heightPx / 2);
  return [w, s, e, n];
}

export interface TileRange {
  z: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** 範囲 (west, south, east, north) を覆うタイル番号の範囲 */
export function tileRange(
  bounds: [number, number, number, number],
  z: number,
): TileRange {
  const [w, s, e, n] = bounds;
  const tl = lngLatToTile(w, n, z);
  const br = lngLatToTile(e, s, z);
  const max = 2 ** z - 1;
  const clamp = (v: number) => Math.max(0, Math.min(max, Math.floor(v)));
  return { z, minX: clamp(tl.x), maxX: clamp(br.x), minY: clamp(tl.y), maxY: clamp(br.y) };
}

export function tileCount(r: TileRange): number {
  return (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
}

/** タイルURLの {z}/{x}/{y} を埋める */
export const tileUrl = (template: string, z: number, x: number, y: number) =>
  template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

/**
 * 座標を囲む範囲 (west, south, east, north)。
 * Math.min(...配列) は点が多いと引数の数の上限を超えるので、1つずつ比べる
 */
export function bbox(coords: readonly LngLat[]): [number, number, number, number] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lng, lat] of coords) {
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

/** 経路の累積距離 (m) の配列。先頭は 0 */
export function cumulativeDistances(coords: LngLat[]): number[] {
  const out = new Array<number>(coords.length);
  let acc = 0;
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) acc += distance(coords[i - 1], coords[i]);
    out[i] = acc;
  }
  return out;
}

/**
 * 小さい順に並んだ n 個の値（i 番目は at(i)）のうち、x 以下で一番後ろの番号。すべて x より大きければ -1。
 * 時刻や累積距離で、点の並びのどこにいるかを探す（二分探索）
 */
export function bisect(n: number, at: (i: number) => number, x: number): number {
  let lo = -1;
  let hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at(mid) <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * 点と点の間が maxStep (m) を超える区間に中間点を補う。
 * 計画ルート（点がまばらなGPX）でも標高グラフ・累積標高を正しく出すため。
 */
export function densify(coords: LngLat[], maxStep = 50): LngLat[] {
  if (coords.length < 2) return coords.slice();
  const out: LngLat[] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const n = Math.ceil(distance(a, b) / maxStep);
    for (let k = 1; k < n; k++) {
      const f = k / n;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
    out.push(b);
  }
  return out;
}

/**
 * 累積標高差（登り・下り）を逐次計算する。
 * 細かな上下（GPSやDEMのノイズ）を拾わないよう、基準点から threshold 以上動いたときだけ加算する。
 */
export class GainCounter {
  ascent = 0;
  descent = 0;
  private anchor: number | null = null;
  constructor(private readonly threshold = 4) {}

  push(e: number | null | undefined): void {
    if (e == null || Number.isNaN(e)) return;
    if (this.anchor == null) {
      this.anchor = e;
      return;
    }
    const diff = e - this.anchor;
    if (diff >= this.threshold) {
      this.ascent += diff;
      this.anchor = e;
    } else if (diff <= -this.threshold) {
      this.descent -= diff;
      this.anchor = e;
    }
  }
}

export function elevationGain(
  elevations: (number | null | undefined)[],
  threshold = 4,
): { ascent: number; descent: number } {
  const c = new GainCounter(threshold);
  for (const e of elevations) c.push(e);
  return { ascent: c.ascent, descent: c.descent };
}

/**
 * 文章から位置が分かるものを伏せる（ログを送るとき）：地図タイルの番号（/z/x/y）、URL の緯度経度、小数4桁以上の数（緯度経度）。
 * 版の番号（133.0.6943.137 など、前後に「.」が続く数）は伏せない
 */
export function maskLocation(text: string): string {
  return text
    .replace(/\/\d{1,2}\/\d+\/\d+(\.(png|jpg|pbf|webp))/g, '/z/x/y$1')
    .replace(/(latitude|longitude|lat|lng|lon)=[-\d.,%C]+/gi, '$1=…')
    .replace(/(?<![\d.])-?\d{1,3}\.\d{4,}(?![\d.])/g, '…');
}

export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
