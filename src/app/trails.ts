/**
 * 登山道を目立たせて重ねる（「重ねる情報」で出し入れ）：
 *  - 国土地理院の徒歩道：最適化ベクトルタイルの道路中心線のうち徒歩道・石段（ズーム15から。名前はない）。オレンジの太い帯
 *  - OpenStreetMap の小道・登山道：OpenFreeMap の地図データ（ズーム13から）。紫の点線。名前があれば、線をタップしたときに出す（mapTap.ts）
 * どちらもルート探しに使っている道と同じデータ（route/roadTiles.ts）
 */
import type { PointLike } from 'maplibre-gl';
import { OSM_TILEJSON, ROAD_TILE_URL } from '../route/roadTiles';
import { map } from './mapView';
import { layerOn } from './places';

/** 「重ねる情報」の切り替えと、地図の層 */
export const TRAIL_LAYERS = {
  trails: ['trails-gsi'],
  osmTrails: ['trails-osm', 'trails-osm-name'],
} as const;
export type TrailLayerId = keyof typeof TRAIL_LAYERS;

/** 地理院の道路中心線の種類（vt_code）のうち、徒歩道と石段（一の位は 1:通常部 2:雪覆い 3:橋 4:トンネル） */
const GSI_TRAIL_CODES = [2721, 2722, 2723, 2724, 2731, 2732, 2733, 2734];

const visibility = (id: TrailLayerId) => (layerOn(id) ? 'visible' : 'none');

/** 地図の読み込み後に一度だけ。before の層（ルートの線）より下に置く */
export function addTrailLayers(before?: string) {
  map.addSource('trails-gsi', { type: 'vector', tiles: [ROAD_TILE_URL], minzoom: 15, maxzoom: 16 });
  map.addLayer(
    {
      id: 'trails-gsi',
      type: 'line',
      source: 'trails-gsi',
      'source-layer': 'RdCL',
      minzoom: 15,
      filter: ['in', ['to-number', ['get', 'vt_code']], ['literal', GSI_TRAIL_CODES]],
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: visibility('trails') },
      paint: { 'line-color': '#e8590c', 'line-opacity': 0.5, 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 4, 18, 9] },
    },
    before,
  );
  map.addSource('trails-osm', { type: 'vector', url: OSM_TILEJSON });
  map.addLayer(
    {
      id: 'trails-osm',
      type: 'line',
      source: 'trails-osm',
      'source-layer': 'transportation',
      minzoom: 13,
      filter: ['all', ['==', ['get', 'class'], 'path'], ['!=', ['get', 'subclass'], 'cycleway']],
      layout: { 'line-join': 'round', visibility: visibility('osmTrails') },
      paint: { 'line-color': '#7b1fa2', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.5, 18, 3.5], 'line-dasharray': [2, 1.2] },
    },
    before,
  );
  // 名前のある小道（タップしたときに名前を引くための、見えない太い線）
  map.addLayer(
    {
      id: 'trails-osm-name',
      type: 'line',
      source: 'trails-osm',
      'source-layer': 'transportation_name',
      minzoom: 13,
      filter: ['all', ['==', ['get', 'class'], 'path'], ['has', 'name']],
      layout: { visibility: visibility('osmTrails') },
      paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16 },
    },
    before,
  );
}

/** 「重ねる情報」で切り替えたら、層の表示を合わせる */
export function updateTrailLayers() {
  for (const [id, layers] of Object.entries(TRAIL_LAYERS) as [TrailLayerId, readonly string[]][]) {
    for (const l of layers) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', visibility(id));
  }
}

/** 画面の点の近くの登山道：OpenStreetMap の名前、なければ「地理院の徒歩道」「小道・登山道」（なければ null） */
export function trailAt(p: { x: number; y: number }): string | null {
  const box: [PointLike, PointLike] = [
    [p.x - 10, p.y - 10],
    [p.x + 10, p.y + 10],
  ];
  const layers = ['trails-osm-name', 'trails-osm', 'trails-gsi'].filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
  if (!layers.length) return null;
  const hits = map.queryRenderedFeatures(box, { layers });
  const named = hits.find((f) => f.layer.id === 'trails-osm-name');
  const name = named ? String(named.properties['name:ja'] ?? named.properties.name ?? '') : '';
  if (name) return name;
  if (hits.some((f) => f.layer.id === 'trails-osm')) return '小道・登山道（OpenStreetMap）';
  if (hits.some((f) => f.layer.id === 'trails-gsi')) return '徒歩道（国土地理院）';
  return null;
}
