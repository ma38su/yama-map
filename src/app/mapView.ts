/** 地図本体と地図のボタン、ルートや記録を描く層 */
import {
  GeolocateControl,
  Map as MlMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type ExpressionSpecification,
  type GeoJSONSource,
  type IControl,
} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { FeatureCollection } from 'geojson';
import { bbox, type LngLat } from '../geo';
import { applyDaylight, toneStyle } from '../map/daylight';
import { swapTouchGestures } from '../map/gestures';
import { DemSampler, registerGsiDemProtocol } from '../map/gsiDem';
import { createStyle, set3D } from '../map/style';
import { sunPosition } from '../nav/sun';
import { OSM_ATTRIBUTION } from '../route/roadTiles';
import { daylightTime, saveSettings, settings, timePreview } from '../settings';
import { $, h } from '../ui/dom';
import { state } from './state';

// 地図を作る前に、ワーカーと標高タイルの読み込み方を登録しておく
setWorkerUrl(workerUrl);
registerGsiDemProtocol();

// 標高タイルは1枚 256KB（Float32 の 256×256）。48枚で約12MB。10km ほどのルートの標高を求めるのに足りる数
export const dem = new DemSampler(48);
export const elevation = (lng: number, lat: number) => dem.elevation(lng, lat);
const initialCenter: LngLat = settings.view?.center ?? [139.4165, 36.8705]; // 初期表示：奥鬼怒
/**
 * 空と地図の色を時刻に合わせるか。リプレイのときだけで、ふだんの地図は昼の色のまま（夕方や夜に色が変わると読みにくいので）。
 * URL の ?time= で時刻を決めたときは、その時刻の見え方を確かめられるように合わせる
 */
const toneOn = () => settings.dayTone && (state.daylightAt != null || timePreview);
const initialSun = sunPosition(daylightTime(), initialCenter[1], initialCenter[0]);
const initialStyle = toneStyle(createStyle(settings.base, settings.hillshade), toneOn() ? initialSun.altitude : 90);
export const map = new MlMap({
  container: 'map',
  style: initialStyle,
  center: initialCenter,
  zoom: settings.view?.zoom ?? 13.3,
  pitch: settings.view?.pitch ?? 0,
  bearing: settings.view?.bearing ?? 0,
  maxPitch: 80,
  attributionControl: { compact: true },
});

// 3D のときは 1本指で回転、2本指で移動
swapTouchGestures(map, () => settings.terrain);

class Terrain3DControl implements IControl {
  private container?: HTMLDivElement;
  private button?: HTMLButtonElement;
  onAdd(): HTMLElement {
    this.container = h('div', 'maplibregl-ctrl maplibregl-ctrl-group');
    this.button = h('button', 'ctrl-3d', '3D');
    this.button.type = 'button';
    this.button.title = '2D / 3D 切り替え';
    this.button.addEventListener('click', () => setTerrain(!settings.terrain));
    this.container.append(this.button);
    this.update();
    return this.container;
  }
  update() {
    this.button?.setAttribute('aria-pressed', String(settings.terrain));
    this.button?.setAttribute('aria-label', settings.terrain ? '2D表示に切り替え' : '3D表示に切り替え');
  }
  onRemove() {
    this.container?.remove();
  }
}

export const geolocate = new GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  showAccuracyCircle: true,
  fitBoundsOptions: { maxZoom: 15 },
});
// スマホではピンチで拡大縮小するので +/- ボタンは出さない（方位だけ）
map.addControl(new NavigationControl({ showZoom: false, visualizePitch: true }), 'top-right');
map.addControl(geolocate, 'top-right');
const terrainControl = new Terrain3DControl();
map.addControl(terrainControl, 'top-right');

/** 2D / 3D を切り替える */
export function setTerrain(on: boolean) {
  if (settings.terrain === on) return;
  settings.terrain = on;
  saveSettings();
  // 読み込み前は地図の load で反映する（読み込み前に地形を切り替えるとエラーになる）。
  // isStyleLoaded() はタイルの読み込み中も false になり、切り替えが反映されないことがあるので使わない
  if (styleReady) {
    set3D(map, on, settings.terrainExaggeration);
    updateDaylight();
  }
  terrainControl.update();
}
/** 3D の起伏の強調を変える（3D のときはすぐ反映） */
export function setTerrainExaggeration(v: number) {
  settings.terrainExaggeration = v;
  saveSettings();
  if (styleReady && settings.terrain) map.setTerrain({ source: 'dem-terrain', exaggeration: v });
}
map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

export const emptyFC: FeatureCollection = { type: 'FeatureCollection', features: [] };
export const lineFC = (coords: LngLat[]): FeatureCollection =>
  coords.length < 2
    ? emptyFC
    : { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] };
export const pointFC = (c: LngLat | null): FeatureCollection =>
  c ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }] } : emptyFC;
export const src = (id: string) => map.getSource(id) as GeoJSONSource | undefined;

/**
 * 空の色を変えるときに一緒に呼ぶもの（天気：雲量と、雲・雨の表示）。weather.ts が登録する
 * （ここから weather.ts を読み込むと、地図ができる前に weather.ts が動いてしまうため）
 */
const daylightHooks = { cloud: () => 0, after: () => {} };
let styleReady = false;
map.once('load', () => {
  styleReady = true;
});
export function hookDaylight(hooks: Partial<typeof daylightHooks>) {
  Object.assign(daylightHooks, hooks);
}

/** 今の時刻（リプレイ中は再生中の時刻）・地図の中心での太陽と雲に、空・地図の色（リプレイ中だけ）と陰影を合わせる */
export function updateDaylight() {
  // 地図の読み込み前は空を変えられない（読み込んだら main.ts の load で合わせる）。雨などはそのまま合わせる
  if (styleReady) {
    const c = map.getCenter();
    const when = state.daylightAt != null ? new Date(state.daylightAt) : daylightTime();
    applyDaylight(map, sunPosition(when, c.lat, c.lng), { terrain: settings.terrain, tone: toneOn(), cloud: daylightHooks.cloud() });
  }
  daylightHooks.after();
}

map.on('moveend', () => {
  const c = map.getCenter();
  settings.view = {
    center: [+c.lng.toFixed(6), +c.lat.toFixed(6)],
    zoom: +map.getZoom().toFixed(2),
    pitch: Math.round(map.getPitch()),
    bearing: Math.round(map.getBearing()),
  };
  saveSettings();
});

export function fitTo(coords: LngLat[]) {
  if (!coords.length) return;
  const [w, s, e, n] = bbox(coords);
  const panel = $('sheet').getBoundingClientRect().height;
  map.fitBounds(
    [
      [w, s],
      [e, n],
    ],
    { padding: { top: 70, bottom: Math.min(panel + 30, window.innerHeight * 0.6), left: 40, right: 70 }, maxZoom: 15.5, duration: 600 },
  );
}


/** リプレイの歩き終えた線：線の長さの割合 progress（0〜1）までを塗る */
export const replayDoneGradient = (progress: number): ExpressionSpecification => [
  'step',
  ['line-progress'],
  '#7a1424',
  Math.max(0, Math.min(1, progress)),
  'rgba(122, 20, 36, 0)',
];

/** 線の太さ：寄るほど太く（広く見ているときは細く、山道を見分けられるくらいに寄ったら太く） */
const lineWidth = (z12: number, z17: number): ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], 12, z12, 17, z17];

/** ルートの進む向きの印（白い「>」）。線の向きに合わせて回るよう、右向きに描く */
function arrowImage(): ImageData {
  const r = 2;
  const w = 12 * r;
  const ht = 12 * r;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = ht;
  const ctx = c.getContext('2d')!;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(3.5 * r, 2.5 * r);
  ctx.lineTo(8 * r, 6 * r);
  ctx.lineTo(3.5 * r, 9.5 * r);
  ctx.strokeStyle = 'rgba(17, 51, 140, 0.55)';
  ctx.lineWidth = 4 * r;
  ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.2 * r;
  ctx.stroke();
  return ctx.getImageData(0, 0, w, ht);
}

/** ルート・記録・グラフのカーソルを描く層（地図の読み込み後に一度だけ） */
export function addOverlayLayers() {
  for (const id of ['route', 'route-done', 'route-ahead', 'track', 'track-out', 'cursor', 'replay', 'replay-dir']) map.addSource(id, { type: 'geojson', data: emptyFC });
  // リプレイの歩き終えた線は、記録の線全体を置いておき、line-progress で途中まで塗る（進むたびに線を作り直さない）
  map.addSource('replay-done', { type: 'geojson', data: emptyFC, lineMetrics: true });
  // OpenStreetMap 由来のルートを表示しているときだけ出典を出すためのソース
  map.addSource('osm-credit', { type: 'geojson', data: emptyFC, attribution: OSM_ATTRIBUTION });
  if (!map.hasImage('route-arrow')) map.addImage('route-arrow', arrowImage(), { pixelRatio: 2 });
  const round = { 'line-join': 'round' as const, 'line-cap': 'round' as const };
  map.addLayer({ id: 'osm-credit', type: 'circle', source: 'osm-credit', layout: { visibility: 'none' } });
  // これからのルート：白い縁取りの青い線と、進む向きの印。歩き終えた部分は灰色で上から塗る
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#ffffff', 'line-width': lineWidth(7, 12), 'line-opacity': 0.9 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#2563eb', 'line-width': lineWidth(4, 8) } });
  map.addLayer({ id: 'route-done', type: 'line', source: 'route-done', layout: round, paint: { 'line-color': '#a7b1bd', 'line-width': lineWidth(4, 8) } });
  map.addLayer({
    id: 'route-arrows',
    type: 'symbol',
    source: 'route-ahead',
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 12, 60, 17, 90],
      'icon-image': 'route-arrow',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.85, 17, 1.5],
      'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  // 記録の範囲の外（出発前・到着後に止まっていたところ）：灰色の点線
  map.addLayer({
    id: 'track-out',
    type: 'line',
    source: 'track-out',
    layout: { 'line-join': 'round' },
    paint: { 'line-color': '#7b8794', 'line-width': lineWidth(2.5, 4), 'line-dasharray': [1.2, 1.4], 'line-opacity': 0.85 },
  });
  // 歩いた記録：太めの赤い線（白い縁取りで、灰色の歩き終えたルートや地図の上でも見分けやすく）
  map.addLayer({ id: 'track-casing', type: 'line', source: 'track', layout: round, paint: { 'line-color': '#ffffff', 'line-width': lineWidth(6, 10), 'line-opacity': 0.95 } });
  map.addLayer({ id: 'track-line', type: 'line', source: 'track', layout: round, paint: { 'line-color': '#d6334a', 'line-width': lineWidth(3.5, 6) } });
  map.addLayer({ id: 'replay-done', type: 'line', source: 'replay-done', layout: round, paint: { 'line-gradient': replayDoneGradient(0), 'line-width': 4.5 } });
  // リプレイの今の位置：赤い丸に、歩いているあいだは進む向きの白い矢じり（地面に置く形。録画にも写るよう地図の層で描く）
  map.addLayer({
    id: 'replay',
    type: 'circle',
    source: 'replay',
    paint: { 'circle-radius': 12, 'circle-color': '#d6334a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3, 'circle-pitch-alignment': 'map' },
  });
  map.addLayer({ id: 'replay-dir', type: 'fill', source: 'replay-dir', paint: { 'fill-color': '#ffffff', 'fill-antialias': true } });
  map.addLayer({
    id: 'cursor',
    type: 'circle',
    source: 'cursor',
    paint: { 'circle-radius': 8, 'circle-color': '#1f2933', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
}
