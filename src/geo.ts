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
