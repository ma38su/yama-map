/**
 * 表示中の範囲の地図タイルを端末に保存する（山の中の圏外対策）。
 * 保存先は Service Worker と共有の Cache Storage。
 * 地理院タイルのサーバーに負担をかけないよう、同時接続数と枚数に上限を設けている。
 */
import { tileCount, tileRange, type TileRange } from '../geo';

export const TILE_CACHE = 'yama-map-tiles-v1';
export const MAX_TILES = 4000;
const CONCURRENCY = 4;

interface LayerPlan {
  template: string;
  minZoom: number;
  maxZoom: number;
}

const GSI = 'https://cyberjapandata.gsi.go.jp/xyz';

export function downloadLayers(baseTemplate: string, maxZoom = 16): LayerPlan[] {
  return [
    { template: baseTemplate, minZoom: 8, maxZoom },
    // 3D地形・陰影用 (DEM10B)
    { template: `${GSI}/dem_png/{z}/{x}/{y}.png`, minZoom: 8, maxZoom: 14 },
    // 記録時の標高計算用 (DEM5A)
    { template: `${GSI}/dem5a_png/{z}/{x}/{y}.png`, minZoom: 15, maxZoom: 15 },
    // ルート検索・地名用の道路・注記データ（ベクトルタイル）
    { template: `${GSI}/optimal_bvmap-v1/{z}/{x}/{y}.pbf`, minZoom: 16, maxZoom: 16 },
  ];
}

export function planTiles(bounds: [number, number, number, number], layers: LayerPlan[]): string[] {
  const urls: string[] = [];
  for (const layer of layers) {
    for (let z = layer.minZoom; z <= layer.maxZoom; z++) {
      const r: TileRange = tileRange(bounds, z);
      for (let x = r.minX; x <= r.maxX; x++) {
        for (let y = r.minY; y <= r.maxY; y++) {
          urls.push(layer.template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
        }
      }
    }
  }
  return urls;
}

export function estimateTiles(bounds: [number, number, number, number], layers: LayerPlan[]): number {
  let n = 0;
  for (const layer of layers) {
    for (let z = layer.minZoom; z <= layer.maxZoom; z++) n += tileCount(tileRange(bounds, z));
  }
  return n;
}

export interface DownloadProgress {
  done: number;
  total: number;
  failed: number;
}

export async function downloadTiles(
  urls: string[],
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<DownloadProgress> {
  // ブラウザが容量不足時に勝手に消さないよう永続化を要求（拒否されても続行）
  await navigator.storage?.persist?.().catch(() => false);
  const cache = await caches.open(TILE_CACHE);
  const progress: DownloadProgress = { done: 0, total: urls.length, failed: 0 };
  let next = 0;
  const worker = async () => {
    while (next < urls.length && !signal?.aborted) {
      const url = urls[next++];
      try {
        if (!(await cache.match(url, { ignoreVary: true }))) {
          const res = await fetch(url, { mode: 'cors', signal });
          // 404 = データなし（海など）。それも覚えておけばオフライン時に問い合わせずに済む
          if (res.ok || res.status === 404) await cache.put(url, res);
          else progress.failed++;
        }
      } catch {
        if (signal?.aborted) break;
        progress.failed++;
      }
      progress.done++;
      onProgress(progress);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return progress;
}

export async function clearTileCache(): Promise<void> {
  await caches.delete(TILE_CACHE);
}

export async function storageUsage(): Promise<string | null> {
  const est = await navigator.storage?.estimate?.();
  if (!est?.usage) return null;
  return `${(est.usage / 1024 / 1024).toFixed(0)} MB 使用中`;
}
