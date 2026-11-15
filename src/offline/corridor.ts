/**
 * ルートの両側 bufferM の帯（ルート沿い）を覆うタイル。オフライン保存で、ルートを囲む長方形全体ではなく、
 * 歩くところの周りだけを保存するのに使う（ルートが斜めや L 字でも、枚数が増えすぎない）。
 * ルートを細かく区切った各点の「上下左右 bufferM の正方形」を覆うタイルを集める。
 */
import { densify, tileRange, type LngLat } from '../geo';

const M_PER_DEG = 111_320;

/** タイル1枚の一辺 (m)。緯度 lat・ズーム z */
export const tileSizeM = (lat: number, z: number) => (40_075_016 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

/** 点の上下左右 m の範囲 (west, south, east, north) */
export function aroundPoint([lng, lat]: LngLat, m: number): [number, number, number, number] {
  const dLat = m / M_PER_DEG;
  const dLng = m / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

/** ズーム z で、ルートの両側 bufferM を覆うタイル（"x/y"） */
export function corridorTiles(coords: LngLat[], bufferM: number, z: number): Set<string> {
  const out = new Set<string>();
  if (!coords.length) return out;
  // 点の間隔は、タイルの一辺の半分と bufferM の小さいほう（その間の帯も正方形で覆える）
  const step = Math.max(20, Math.min(tileSizeM(coords[0][1], z) / 2, bufferM));
  for (const p of densify(coords, step)) {
    const r = tileRange(aroundPoint(p, bufferM), z);
    for (let x = r.minX; x <= r.maxX; x++) for (let y = r.minY; y <= r.maxY; y++) out.add(`${x}/${y}`);
  }
  return out;
}

/** 点 p からルートまでの近さが bufferM 以内か（ざっくり：細かく区切ったルートの点との距離で見る） */
export function nearRoute(dense: LngLat[], p: LngLat, bufferM: number): boolean {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const lim = (bufferM / M_PER_DEG) ** 2;
  for (const q of dense) {
    const dx = (q[0] - p[0]) * k;
    const dy = q[1] - p[1];
    if (dx * dx + dy * dy <= lim) return true;
  }
  return false;
}
