/**
 * 国土地理院の標高タイル (PNG) を扱うモジュール。
 *
 * 地理院の標高PNGは独自形式なので、MapLibre の 3D 地形が読める
 * Terrarium 形式へその場で変換するカスタムプロトコル (gsidem://) を登録する。
 * また、任意地点の標高を取得するサンプラーも提供する。
 *
 * 地理院の形式: x = R*2^16 + G*2^8 + B
 *   x <  2^23 → h = x * 0.01 m
 *   x =  2^23 → 無効値 (海など)
 *   x >  2^23 → h = (x - 2^24) * 0.01 m
 * https://maps.gsi.go.jp/development/demtile.html
 */
import { addProtocol } from 'maplibre-gl';
import { lngLatToTile } from '../geo';

export const GSI_DEM_PROTOCOL = 'gsidem';
const TILE_HOST = 'https://cyberjapandata.gsi.go.jp/xyz';

/** MapLibre の raster-dem ソースに指定するタイルURL（DEM10B, z0-14） */
export const GSI_DEM_TILE_URL = `${GSI_DEM_PROTOCOL}://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png`;

const NA = 0x800000;

/** 地理院PNGの1画素を標高(m)へ。無効値は null */
export function gsiRgbToHeight(r: number, g: number, b: number): number | null {
  const x = r * 65536 + g * 256 + b;
  if (x === NA) return null;
  return (x < NA ? x : x - 0x1000000) * 0.01;
}

/** 標高(m)を Terrarium 形式の RGB へ */
export function heightToTerrarium(h: number): [number, number, number] {
  const v = Math.max(0, Math.min(65535.996, h + 32768));
  const r = Math.floor(v / 256);
  const g = Math.floor(v) % 256;
  const b = Math.floor((v - Math.floor(v)) * 256);
  return [r, g, b];
}

/** RGBA 配列を地理院形式から Terrarium 形式へその場で変換する（無効値は 0m 扱い） */
export function convertGsiToTerrarium(px: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    const h = gsiRgbToHeight(px[i], px[i + 1], px[i + 2]) ?? 0;
    const [r, g, b] = heightToTerrarium(h);
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
}

/** RGBA 配列を標高の Float32Array へ（無効値は NaN） */
export function decodeGsiHeights(px: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(px.length / 4);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    out[j] = gsiRgbToHeight(px[i], px[i + 1], px[i + 2]) ?? Number.NaN;
  }
  return out;
}

let scratch: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
function scratchContext(): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  if (scratch) return scratch;
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(256, 256)
      : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('2D canvas が使えません');
  scratch = ctx;
  return ctx;
}

async function decodeImage(blob: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const ctx = scratchContext();
  ctx.canvas.width = bmp.width;
  ctx.canvas.height = bmp.height;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
}

let flatTile: Promise<ImageBitmap> | null = null;
/** データのないタイル（海・範囲外）用の 0m 平面 */
function flatTerrariumTile(): Promise<ImageBitmap> {
  if (!flatTile) {
    const data = new ImageData(256, 256);
    for (let i = 0; i < data.data.length; i += 4) {
      data.data[i] = 128; // 0m = 32768 = 128*256
      data.data[i + 3] = 255;
    }
    flatTile = createImageBitmap(data);
  }
  return flatTile;
}

let registered = false;
export function registerGsiDemProtocol(): void {
  if (registered) return;
  registered = true;
  addProtocol(GSI_DEM_PROTOCOL, async (params, abortController) => {
    const url = params.url.replace(`${GSI_DEM_PROTOCOL}://`, 'https://');
    const res = await fetch(url, { signal: abortController.signal });
    if (res.status === 404) return { data: await flatTerrariumTile() };
    if (!res.ok) throw new Error(`DEM tile ${res.status}: ${url}`);
    const img = await decodeImage(await res.blob());
    convertGsiToTerrarium(img.data);
    return { data: await createImageBitmap(img) };
  });
}

type HeightTile = Float32Array | null;

/**
 * 任意地点の標高を求める。DEM5A（5mメッシュ, z15）を優先し、
 * 無い場所は DEM10B（10mメッシュ, z14）にフォールバックする。
 * 取得したタイルはメモリにキャッシュ（オフライン時は Service Worker のキャッシュが効く）。
 */
export class DemSampler {
  private cache = new Map<string, Promise<HeightTile>>();
  constructor(private readonly maxTiles = 32) {}

  async elevation(lng: number, lat: number): Promise<number | null> {
    const fine = await this.sample('dem5a_png', 15, lng, lat).catch(() => null);
    if (fine != null) return fine;
    return this.sample('dem_png', 14, lng, lat).catch(() => null);
  }

  private async sample(layer: string, z: number, lng: number, lat: number): Promise<number | null> {
    const t = lngLatToTile(lng, lat, z);
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);
    const tile = await this.tile(layer, z, tx, ty);
    if (!tile) return null;
    return bilinear(tile, (t.x - tx) * 256 - 0.5, (t.y - ty) * 256 - 0.5);
  }

  private tile(layer: string, z: number, x: number, y: number): Promise<HeightTile> {
    const key = `${layer}/${z}/${x}/${y}`;
    const hit = this.cache.get(key);
    if (hit) {
      // LRU: 末尾へ移動
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const p = (async (): Promise<HeightTile> => {
      // 電波が弱いと fetch が長く固まるので打ち切る
      const res = await fetch(`${TILE_HOST}/${key}.png`, { signal: AbortSignal.timeout(6000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`DEM ${res.status}`);
      return decodeGsiHeights((await decodeImage(await res.blob())).data);
    })();
    // 通信エラーは30秒だけ覚えておき、その後は再取得を試みる（電波が戻ることがある）
    p.catch(() => setTimeout(() => this.cache.get(key) === p && this.cache.delete(key), 30_000));
    this.cache.set(key, p);
    while (this.cache.size > this.maxTiles) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    return p;
  }
}

/** 256x256 の標高配列から双線形補間。周囲が無効値なら最寄りの有効値、全て無効なら null */
export function bilinear(tile: Float32Array, px: number, py: number): number | null {
  const size = 256;
  const cx = Math.max(0, Math.min(size - 1, px));
  const cy = Math.max(0, Math.min(size - 1, py));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const v00 = tile[y0 * size + x0];
  const v10 = tile[y0 * size + x1];
  const v01 = tile[y1 * size + x0];
  const v11 = tile[y1 * size + x1];
  if ([v00, v10, v01, v11].every((v) => !Number.isNaN(v))) {
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
  }
  const nearest = tile[Math.round(cy) * size + Math.round(cx)];
  return Number.isNaN(nearest) ? null : nearest;
}
