/**
 * オフライン用に保存した範囲を地図に塗る。端末に保存した道データ（ズーム16、1枚 約500m 四方）の位置から塗るので、
 * 範囲の記録がない以前の版で保存した地図も含め、実際に圏外で使える範囲が分かる
 */
import type { Feature, Polygon } from 'geojson';
import { TILE_CACHE } from '../offline/download';
import { emptyFC, map, src } from './mapView';
import { layerOn } from './places';

const LAYER = 'saved-area';
/** 保存した道データのタイル（オフライン保存では、どの範囲でも必ず保存する） */
const ROAD_TILE = /\/optimal_bvmap-v1\/16\/(\d+)\/(\d+)\.pbf$/;

const tileToLngLat = (x: number, y: number, z: number): [number, number] => {
  const n = 2 ** z;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat];
};

/** 地図の読み込み後に一度だけ。before の層より下に置く */
export function addSavedLayer(before?: string) {
  map.addSource(LAYER, { type: 'geojson', data: emptyFC });
  map.addLayer(
    {
      id: LAYER,
      type: 'fill',
      source: LAYER,
      layout: { visibility: 'none' },
      paint: { 'fill-color': '#16805c', 'fill-opacity': 0.22, 'fill-antialias': false },
    },
    before,
  );
  if (layerOn('saved')) void showSaved(true);
}

/**
 * 塗る範囲を作ってあるか。作るには保存した地図のキーを全部読む（数範囲で数万件）ので、出すたびには作らず、
 * 保存・削除したとき（refreshSaved）だけ作り直す
 */
let built = false;

/** 保存した範囲を塗る・消す */
export async function showSaved(on: boolean) {
  if (!map.getLayer(LAYER)) return;
  map.setLayoutProperty(LAYER, 'visibility', on ? 'visible' : 'none');
  if (on && !built) await refreshSaved();
}

/** 保存した範囲を読み直す（保存・削除したあと）。出していなければ、次に出すときに作る */
export async function refreshSaved() {
  built = false;
  if (!map.getLayer(LAYER) || !layerOn('saved')) return;
  const keys = await (await caches.open(TILE_CACHE)).keys().catch(() => [] as readonly Request[]);
  const features: Feature<Polygon>[] = [];
  for (const req of keys) {
    const m = ROAD_TILE.exec(req.url);
    if (!m) continue;
    const x = Number(m[1]);
    const y = Number(m[2]);
    const [w, n] = tileToLngLat(x, y, 16);
    const [e, s] = tileToLngLat(x + 1, y + 1, 16);
    features.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [w, n],
            [e, n],
            [e, s],
            [w, s],
            [w, n],
          ],
        ],
      },
    });
  }
  src(LAYER)?.setData({ type: 'FeatureCollection', features });
  built = true;
}
