/** 地図本体と地図のボタン、ルートや記録を描く層 */
import {
  GeolocateControl,
  Map as MlMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type IControl,
} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { FeatureCollection } from 'geojson';
import type { LngLat } from '../geo';
import { applyDaylight, toneStyle } from '../map/daylight';
import { swapTouchGestures } from '../map/gestures';
import { DemSampler, registerGsiDemProtocol } from '../map/gsiDem';
import { createStyle, set3D } from '../map/style';
import { sunPosition } from '../nav/sun';
import { OSM_ATTRIBUTION } from '../route/roadTiles';
import { daylightTime, saveSettings, settings } from '../settings';
import { $, h } from '../ui/dom';
import { state } from './state';

// 地図を作る前に、ワーカーと標高タイルの読み込み方を登録しておく
setWorkerUrl(workerUrl);
registerGsiDemProtocol();

export const dem = new DemSampler(96);
export const elevation = (lng: number, lat: number) => dem.elevation(lng, lat);
const initialCenter: LngLat = settings.view?.center ?? [139.4165, 36.8705]; // 初期表示：奥鬼怒
const initialSun = sunPosition(daylightTime(), initialCenter[1], initialCenter[0]);
const initialStyle = toneStyle(createStyle(settings.base, settings.hillshade), settings.dayTone ? initialSun.altitude : 90);
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
    set3D(map, on);
    updateDaylight();
  }
  terrainControl.update();
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

/** 今の時刻（リプレイ中は再生中の時刻）・地図の中心での太陽と雲に、空・地図の色と陰影を合わせる */
export function updateDaylight() {
  // 地図の読み込み前は空を変えられない（読み込んだら main.ts の load で合わせる）。雨などはそのまま合わせる
  if (styleReady) {
    const c = map.getCenter();
    const when = state.daylightAt != null ? new Date(state.daylightAt) : daylightTime();
    applyDaylight(map, sunPosition(when, c.lat, c.lng), { terrain: settings.terrain, tone: settings.dayTone, cloud: daylightHooks.cloud() });
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
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  const panel = $('sheet').getBoundingClientRect().height;
  map.fitBounds(
    [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ],
    { padding: { top: 70, bottom: Math.min(panel + 30, window.innerHeight * 0.6), left: 40, right: 70 }, maxZoom: 15.5, duration: 600 },
  );
}


/** ルート・記録・グラフのカーソルを描く層（地図の読み込み後に一度だけ） */
export function addOverlayLayers() {
  for (const id of ['route', 'route-done', 'track', 'replay-done', 'cursor', 'replay']) map.addSource(id, { type: 'geojson', data: emptyFC });
  // OpenStreetMap 由来のルートを表示しているときだけ出典を出すためのソース
  map.addSource('osm-credit', { type: 'geojson', data: emptyFC, attribution: OSM_ATTRIBUTION });
  const casing = { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 };
  const round = { 'line-join': 'round' as const, 'line-cap': 'round' as const };
  map.addLayer({ id: 'osm-credit', type: 'circle', source: 'osm-credit', layout: { visibility: 'none' } });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: round, paint: casing });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#2563eb', 'line-width': 5 } });
  map.addLayer({ id: 'route-done', type: 'line', source: 'route-done', layout: round, paint: { 'line-color': '#93a3b8', 'line-width': 5 } });
  map.addLayer({ id: 'track-casing', type: 'line', source: 'track', layout: round, paint: { ...casing, 'line-width': 6 } });
  map.addLayer({ id: 'track-line', type: 'line', source: 'track', layout: round, paint: { 'line-color': '#d6334a', 'line-width': 3.5 } });
  map.addLayer({ id: 'replay-done', type: 'line', source: 'replay-done', layout: round, paint: { 'line-color': '#7a1424', 'line-width': 4.5 } });
  map.addLayer({
    id: 'replay',
    type: 'circle',
    source: 'replay',
    paint: { 'circle-radius': 9, 'circle-color': '#d6334a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3, 'circle-pitch-alignment': 'map' },
  });
  map.addLayer({
    id: 'cursor',
    type: 'circle',
    source: 'cursor',
    paint: { 'circle-radius': 8, 'circle-color': '#1f2933', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
}
