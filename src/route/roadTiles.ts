/**
 * 国土地理院ベクトルタイル（最適化ベクトルタイル）から道路中心線・徒歩道を取り出す。
 * 取得したタイルは Service Worker が地図タイルと同じくキャッシュするので、
 * 一度読み込んだ範囲・オフライン保存した範囲は圏外でもルート検索できる。
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { tileRange, type LngLat } from '../geo';
import type { RouteLine } from './trailRouter';

export const ROAD_TILE_ZOOM = 16;
export const ROAD_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf';
/** これ以上のタイル数になる範囲はルート検索しない（約10km四方） */
export const MAX_ROAD_TILES = 500;

/** 徒歩道の分類コード（道路中心線のうち幅3m未満の徒歩道） */
const TRAIL_CODES = new Set([2721, 2722, 2723, 2724]);

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

export function decodeRoadTile(buf: ArrayBuffer | Uint8Array, x: number, y: number, z: number): RouteLine[] {
  const tile = new VectorTile(new PbfReader(buf instanceof Uint8Array ? buf : new Uint8Array(buf)));
  const layer = tile.layers.RdCL;
  if (!layer) return [];
  const lines: RouteLine[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 2) continue;
    const trail = TRAIL_CODES.has(Number(f.properties.vt_code));
    for (const geom of f.loadGeometry()) {
      for (const part of clipLine(geom, f.extent)) {
        lines.push({ coords: part.map((p) => toLngLat(p, x, y, z, f.extent)), trail });
      }
    }
  }
  return lines;
}

export function roadTileUrls(bounds: [number, number, number, number]): { url: string; x: number; y: number }[] {
  const r = tileRange(bounds, ROAD_TILE_ZOOM);
  const out: { url: string; x: number; y: number }[] = [];
  for (let x = r.minX; x <= r.maxX; x++) {
    for (let y = r.minY; y <= r.maxY; y++) {
      out.push({
        url: ROAD_TILE_URL.replace('{z}', String(ROAD_TILE_ZOOM)).replace('{x}', String(x)).replace('{y}', String(y)),
        x,
        y,
      });
    }
  }
  return out;
}

/** 範囲内の道・徒歩道をすべて取得（同時4接続） */
export async function loadRoadLines(
  bounds: [number, number, number, number],
  onProgress?: (done: number, total: number) => void,
): Promise<{ lines: RouteLine[]; failed: number }> {
  const tiles = roadTileUrls(bounds);
  if (tiles.length > MAX_ROAD_TILES) throw new Error('範囲が広すぎます（目的地が遠すぎます）');
  const lines: RouteLine[] = [];
  let next = 0;
  let done = 0;
  let failed = 0;
  const worker = async () => {
    while (next < tiles.length) {
      const t = tiles[next++];
      try {
        const res = await fetch(t.url, { signal: AbortSignal.timeout(15_000) });
        if (res.ok) lines.push(...decodeRoadTile(await res.arrayBuffer(), t.x, t.y, ROAD_TILE_ZOOM));
        else if (res.status !== 404) failed++;
      } catch {
        failed++;
      }
      onProgress?.(++done, tiles.length);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { lines, failed };
}

/** 注記（山名・温泉・小屋などの地名）を取り出す */
export function decodeLabels(buf: ArrayBuffer | Uint8Array, x: number, y: number, z: number): { text: string; lngLat: LngLat }[] {
  const tile = new VectorTile(new PbfReader(buf instanceof Uint8Array ? buf : new Uint8Array(buf)));
  const layer = tile.layers.Anno;
  if (!layer) return [];
  const out: { text: string; lngLat: LngLat }[] = [];
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

/** 地点の近く（maxM 以内）にある地名。見つからなければ null（圏外などでも null） */
export async function nearestPlaceName(p: LngLat, maxM = 250): Promise<string | null> {
  const n = 2 ** ROAD_TILE_ZOOM;
  const x = Math.floor(((p[0] + 180) / 360) * n);
  const latRad = (p[1] * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  let best: { text: string; d: number } | null = null;
  const kx = 111_320 * Math.cos(latRad);
  await Promise.all(
    [-1, 0, 1].flatMap((dx) =>
      [-1, 0, 1].map(async (dy) => {
        try {
          const url = ROAD_TILE_URL.replace('{z}', String(ROAD_TILE_ZOOM))
            .replace('{x}', String(x + dx))
            .replace('{y}', String(y + dy));
          const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
          if (!res.ok) return;
          for (const l of decodeLabels(await res.arrayBuffer(), x + dx, y + dy, ROAD_TILE_ZOOM)) {
            const d = Math.hypot((l.lngLat[0] - p[0]) * kx, (l.lngLat[1] - p[1]) * 110_574);
            if (d <= maxM && (!best || d < best.d)) best = { text: l.text, d };
          }
        } catch {
          /* 圏外など */
        }
      }),
    ),
  );
  return (best as { text: string; d: number } | null)?.text ?? null;
}
