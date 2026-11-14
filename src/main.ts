import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import {
  GeolocateControl,
  Map as MlMap,
  Marker,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type IControl,
  type LngLatBoundsLike,
} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { FeatureCollection } from 'geojson';
import {
  cumulativeDistances,
  densify,
  distance,
  elevationGain,
  formatDistance,
  formatDuration,
  viewBounds,
  type LngLat,
} from './geo';
import { DemSampler, registerGsiDemProtocol } from './map/gsiDem';
import { BASE_LAYERS, createStyle, set3D, setBaseLayer, setHillshade, type BaseLayerId } from './map/style';
import {
  MAX_TILES,
  clearTileCache,
  downloadLayers,
  downloadTiles,
  estimateTiles,
  planTiles,
  storageUsage,
} from './offline/download';
import { deleteTrack, getPoints, listTracks, putTrack, type Track, type TrackPoint } from './track/db';
import { parseGpx, toGpx, type GpxPoint } from './track/gpx';
import { TrackRecorder, type RecorderState } from './track/recorder';
import { ElevationProfile } from './ui/profile';

setWorkerUrl(workerUrl);
registerGsiDemProtocol();

// ---------- 設定（端末に保存） ----------
interface Settings {
  base: BaseLayerId;
  hillshade: boolean;
  terrain: boolean;
  wakeLock: boolean;
  view?: { center: LngLat; zoom: number; pitch: number; bearing: number };
}
const SETTINGS_KEY = 'yama-map:settings';
const settings: Settings = { base: 'std', hillshade: true, terrain: false, wakeLock: true };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'));
} catch {
  /* 保存領域が使えない環境でも動かす */
}
if (!(settings.base in BASE_LAYERS)) settings.base = 'std';
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* noop */
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmtEle = (m: number | null | undefined) => (m == null ? '–' : `${Math.round(m).toLocaleString('ja-JP')} m`);

// ---------- 地図 ----------
const dem = new DemSampler(64);
const map = new MlMap({
  container: 'map',
  style: createStyle(settings.base, settings.hillshade),
  // 初期表示は槍ヶ岳周辺
  center: settings.view?.center ?? [137.6479, 36.342],
  zoom: settings.view?.zoom ?? 12.5,
  pitch: settings.view?.pitch ?? 0,
  bearing: settings.view?.bearing ?? 0,
  maxPitch: 80,
  attributionControl: { compact: true },
});

class Terrain3DControl implements IControl {
  private container?: HTMLDivElement;
  private button?: HTMLButtonElement;
  onAdd(): HTMLElement {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'ctrl-3d';
    this.button.title = '2D / 3D 切り替え';
    this.button.addEventListener('click', () => {
      settings.terrain = !settings.terrain;
      saveSettings();
      set3D(map, settings.terrain);
      this.update();
    });
    this.container.append(this.button);
    this.update();
    return this.container;
  }
  update() {
    if (!this.button) return;
    this.button.textContent = '3D';
    this.button.setAttribute('aria-pressed', String(settings.terrain));
    this.button.setAttribute('aria-label', settings.terrain ? '2D表示に切り替え' : '3D表示に切り替え');
  }
  onRemove() {
    this.container?.remove();
  }
}

const geolocate = new GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  showAccuracyCircle: true,
  fitBoundsOptions: { maxZoom: 15 },
});
map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(geolocate, 'top-right');
map.addControl(new Terrain3DControl(), 'top-right');
map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

const emptyFC: FeatureCollection = { type: 'FeatureCollection', features: [] };
const lineFeature = (coords: LngLat[]): FeatureCollection =>
  coords.length < 2
    ? emptyFC
    : {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }],
      };
const pointFeature = (c: LngLat | null): FeatureCollection =>
  c ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }] } : emptyFC;
const src = (id: string) => map.getSource(id) as GeoJSONSource | undefined;

map.on('load', () => {
  map.addSource('route', { type: 'geojson', data: emptyFC });
  map.addSource('track', { type: 'geojson', data: emptyFC });
  map.addSource('cursor', { type: 'geojson', data: emptyFC });
  const casing = { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 };
  const round = { 'line-join': 'round' as const, 'line-cap': 'round' as const };
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: round, paint: casing });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: round,
    paint: { 'line-color': '#2563eb', 'line-width': 4, 'line-dasharray': [2, 1.2] },
  });
  map.addLayer({ id: 'track-casing', type: 'line', source: 'track', layout: round, paint: casing });
  map.addLayer({
    id: 'track-line',
    type: 'line',
    source: 'track',
    layout: round,
    paint: { 'line-color': '#d6334a', 'line-width': 4 },
  });
  map.addLayer({
    id: 'cursor',
    type: 'circle',
    source: 'cursor',
    paint: { 'circle-radius': 7, 'circle-color': '#1f2933', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
  if (settings.terrain) map.setTerrain({ source: 'dem-terrain', exaggeration: 1.3 });
  renderTrack();
  renderRoute();
  void checkUnfinished();
});

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

// 地図をタップ → その地点の標高
const popup = new Popup({ closeButton: false, maxWidth: '240px' });
map.on('click', async (e) => {
  const { lng, lat } = e.lngLat;
  popup.setLngLat(e.lngLat).setHTML('<span class="popup-ele">…</span>').addTo(map);
  const ele = await dem.elevation(lng, lat);
  popup.setHTML(
    `<div class="popup-ele">標高 ${fmtEle(ele)}</div><div>${lat.toFixed(5)}, ${lng.toFixed(5)}</div>`,
  );
});

// ---------- 現在地 ----------
let lastFix: { coords: LngLat; acc: number; t: number } | null = null;
let currentEle: number | null = null;
let lastEleAt: { coords: LngLat; t: number } | null = null;
geolocate.on('geolocate', async (pos) => {
  const coords: LngLat = [pos.coords.longitude, pos.coords.latitude];
  lastFix = { coords, acc: pos.coords.accuracy, t: Date.now() };
  // 標高の再計算は 20m 以上動いたか 30秒経ったときだけ（無駄な処理を減らす）
  if (!lastEleAt || distance(lastEleAt.coords, coords) > 20 || Date.now() - lastEleAt.t > 30_000) {
    lastEleAt = { coords, t: Date.now() };
    currentEle = await dem.elevation(coords[0], coords[1]);
  }
  updateRouteProgress();
  updateStatus();
  updateStats();
});
geolocate.on('error', (e) => {
  if (e.code === 1) {
    status('位置情報の利用が許可されていません。端末の設定を確認してください', true);
    return;
  }
  // TIMEOUT(3) は止まっているだけでも起きる。一時的な失敗(2)も、直近に測位できていれば気にしない
  if (e.code === 2 && (!lastFix || Date.now() - lastFix.t > 20_000)) {
    status('現在地を取得できません（GPSの電波が弱い可能性があります）', true);
  }
});

// ---------- 記録 ----------
let shown: { track: Track; points: TrackPoint[] } | null = null;
const recorder = new TrackRecorder(dem, (s: RecorderState) => {
  if (s.track) shown = { track: s.track, points: s.points };
  else if (shown && !recorder.recording) shown = null;
  renderTrack();
  updateStats();
  updateStatus();
  updateRecButton();
});
recorder.keepScreenOn = settings.wakeLock;

const recBtn = $<HTMLButtonElement>('btn-rec');
recBtn.addEventListener('click', async () => {
  if (!recorder.recording) {
    if (!('geolocation' in navigator)) {
      alert('この端末・ブラウザでは位置情報が使えません');
      return;
    }
    await recorder.start();
    // 地図も現在地追従にする（すでに追従中なら何もしない）
    if (!lastFix || Date.now() - lastFix.t > 30_000) geolocate.trigger();
    await refreshTrackList();
  } else {
    if (!confirm('記録を終了しますか？')) return;
    const t = await recorder.stop();
    if (t) {
      status(`記録を保存しました：${formatDistance(t.distance)}・登り ${fmtEle(t.ascent)}`);
      await refreshTrackList();
    }
  }
});

function updateRecButton() {
  const rec = recorder.recording;
  recBtn.classList.toggle('recording', rec);
  recBtn.querySelector('.text')!.textContent = rec ? '記録終了' : '記録開始';
}

function renderTrack() {
  const coords = (shown?.points ?? []).map((p): LngLat => [p.lng, p.lat]);
  src('track')?.setData(lineFeature(coords));
  updateProfile();
}

function updateStats() {
  const statsEl = $('stats');
  const t = shown?.track;
  statsEl.hidden = !t && currentEle == null;
  if (t) {
    const end = t.status === 'recording' ? Date.now() : (t.endedAt ?? Date.now());
    $('s-time').textContent = formatDuration(end - t.startedAt);
    $('s-dist').textContent = formatDistance(t.distance);
    $('s-up').textContent = fmtEle(t.ascent);
    $('s-down').textContent = fmtEle(t.descent);
  } else {
    $('s-time').textContent = '–';
    $('s-dist').textContent = '–';
    $('s-up').textContent = '–';
    $('s-down').textContent = '–';
  }
  const lastPoint = shown?.points[shown.points.length - 1];
  const ele = recorder.recording ? (currentEle ?? lastPoint?.ele) : (currentEle ?? null);
  $('s-ele').textContent = fmtEle(ele);
}
setInterval(() => {
  if (recorder.recording && document.visibilityState === 'visible') updateStats();
}, 1000);

// ---------- 状態表示 ----------
let flash: { text: string; until: number; warn: boolean } | null = null;
function status(text: string, warn = false) {
  flash = { text, until: Date.now() + 5000, warn };
  updateStatus();
  setTimeout(updateStatus, 5100);
}
function updateStatus() {
  const el = $('status');
  let text = '';
  let warn = false;
  const rs = recorder.state;
  if (flash && flash.until > Date.now()) {
    text = flash.text;
    warn = flash.warn;
  } else if (rs.error && recorder.recording) {
    text = rs.error;
    warn = true;
  } else if (recorder.recording && rs.lastFix && rs.lastFix.coords.accuracy > 40) {
    text = `GPSの精度待ち（誤差 ${Math.round(rs.lastFix.coords.accuracy)} m）`;
    warn = true;
  } else if (recorder.recording && !rs.wakeLock && settings.wakeLock && 'wakeLock' in navigator) {
    text = '画面を消すと記録が止まります';
    warn = true;
  } else if (!navigator.onLine) {
    text = 'オフライン（保存済みの地図を表示中）';
  } else if (routeProgress) {
    text = routeProgress;
  }
  el.hidden = !text;
  el.textContent = text;
  el.classList.toggle('warn', warn);
}
window.addEventListener('online', updateStatus);
window.addEventListener('offline', updateStatus);

// ---------- ルート（GPX） ----------
interface Route {
  name: string;
  coords: LngLat[];
  dists: number[];
  eles: (number | null)[];
  markers: Marker[];
}
let route: Route | null = null;
let routeProgress = '';

async function loadRoute(text: string) {
  const gpx = parseGpx(text);
  clearRoute();
  const pts: GpxPoint[] = gpx.lines.flatMap((l) => l.points);
  const hasEle = pts.length > 0 && pts.every((p) => p.ele != null);
  // 標高がないGPX（計画ルートなど）は点を補って、標高タイルから細かく標高を取る
  const coords = hasEle ? pts.map((p): LngLat => [p.lng, p.lat]) : densify(pts.map((p): LngLat => [p.lng, p.lat]), 50);
  const markers = gpx.waypoints.map((w) => {
    const el = document.createElement('div');
    el.className = 'wpt-marker';
    el.title = w.name ?? '';
    return new Marker({ element: el })
      .setLngLat([w.lng, w.lat])
      .setPopup(new Popup({ offset: 10, closeButton: false }).setText(w.name ?? '地点'))
      .addTo(map);
  });
  route = { name: gpx.name ?? 'ルート', coords, dists: cumulativeDistances(coords), eles: [], markers };
  renderRoute();
  const all = coords.length ? coords : gpx.waypoints.map((w): LngLat => [w.lng, w.lat]);
  if (all.length) {
    const lngs = all.map((c) => c[0]);
    const lats = all.map((c) => c[1]);
    const bounds: LngLatBoundsLike = [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ];
    map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
  }
  // 標高: GPXに全点あればそれを、なければ標高タイルから求める
  const r = route;
  if (hasEle) {
    r.eles = pts.map((p) => p.ele!);
  } else {
    $('route-info').textContent = '標高を計算中…';
    // まとめて問い合わせる（同じタイルへの取得は DemSampler 内で1回にまとまる）
    r.eles = await Promise.all(coords.map((c) => dem.elevation(c[0], c[1])));
  }
  if (route !== r) return;
  const g = elevationGain(r.eles);
  const total = r.dists[r.dists.length - 1] ?? 0;
  $('route-info').textContent = `${r.name}：${formatDistance(total)}・登り ${fmtEle(g.ascent)}・下り ${fmtEle(g.descent)}`;
  status(`${r.name}：${formatDistance(total)}・登り ${fmtEle(g.ascent)}`);
  setProfileOpen(true);
  updateRouteProgress();
  updateProfile();
}

function clearRoute() {
  route?.markers.forEach((m) => m.remove());
  route = null;
  routeProgress = '';
  renderRoute();
  $('route-info').textContent = '';
}

function renderRoute() {
  src('route')?.setData(lineFeature(route?.coords ?? []));
  $<HTMLButtonElement>('btn-route-clear').disabled = !route;
  updateProfile();
}

/** 現在地がルート上のどこか（最寄りの点）を求め、残り距離・標高差を表示する */
function updateRouteProgress() {
  if (!route || !lastFix || route.coords.length < 2) {
    routeProgress = '';
    profile.setMarker(null);
    return;
  }
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < route.coords.length; i++) {
    const d = distance(route.coords[i], lastFix.coords);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (bestD > 300) {
    routeProgress = `ルートから約 ${formatDistance(bestD)} 離れています`;
    profile.setMarker(null);
    return;
  }
  const remain = route.dists[route.dists.length - 1] - route.dists[best];
  const up = elevationGain(route.eles.slice(best)).ascent;
  routeProgress = `ゴールまで ${formatDistance(remain)}・登り残り ${fmtEle(up)}`;
  profile.setMarker(best);
}

$<HTMLInputElement>('gpx-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    menu.close();
    await loadRoute(await file.text());
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  }
});
$('btn-route-clear').addEventListener('click', clearRoute);

// ---------- 標高グラフ ----------
const profileCanvas = $<HTMLCanvasElement>('profile');
const profileBtn = $<HTMLButtonElement>('btn-profile');
let profileOpen = false;
let profileCoords: LngLat[] = [];
const profile = new ElevationProfile(profileCanvas, (i) => {
  src('cursor')?.setData(pointFeature(i == null ? null : (profileCoords[i] ?? null)));
});
function setProfileOpen(open: boolean) {
  profileOpen = open;
  profileBtn.setAttribute('aria-pressed', String(open));
  updateProfile();
}
profileBtn.addEventListener('click', () => setProfileOpen(!profileOpen));

function updateProfile() {
  // ルートがあればルート、なければ記録中/表示中の軌跡
  let coords: LngLat[] = [];
  let dists: number[] = [];
  let eles: (number | null)[] = [];
  if (route && route.eles.length === route.coords.length) {
    coords = route.coords;
    dists = route.dists;
    eles = route.eles;
  } else if (shown && shown.points.length > 1) {
    coords = shown.points.map((p) => [p.lng, p.lat]);
    dists = cumulativeDistances(coords);
    eles = shown.points.map((p) => p.ele);
  }
  const has = coords.length > 1;
  profileBtn.hidden = !has;
  profileCanvas.hidden = !(has && profileOpen);
  profileCoords = coords;
  if (has && profileOpen) profile.setData(dists, eles);
  updatePanelHeight();
}

// ---------- メニュー ----------
const menu = $<HTMLDialogElement>('menu');
$('btn-menu').addEventListener('click', () => {
  void refreshTrackList();
  void refreshStorage();
  menu.showModal();
});
menu.addEventListener('click', (e) => {
  if (e.target === menu) menu.close(); // 背景タップで閉じる
});

const baseWrap = $('base-layers');
for (const [id, def] of Object.entries(BASE_LAYERS) as [BaseLayerId, (typeof BASE_LAYERS)[BaseLayerId]][]) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = def.label;
  b.setAttribute('role', 'radio');
  b.dataset.id = id;
  b.addEventListener('click', () => {
    settings.base = id;
    saveSettings();
    setBaseLayer(map, id);
    syncMenu();
  });
  baseWrap.append(b);
}
const hillshadeOpt = $<HTMLInputElement>('opt-hillshade');
hillshadeOpt.addEventListener('change', () => {
  settings.hillshade = hillshadeOpt.checked;
  saveSettings();
  setHillshade(map, settings.hillshade);
});
const wakeOpt = $<HTMLInputElement>('opt-wakelock');
wakeOpt.addEventListener('change', () => {
  settings.wakeLock = wakeOpt.checked;
  saveSettings();
  void recorder.setKeepScreenOn(settings.wakeLock);
});
function syncMenu() {
  for (const b of baseWrap.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.id === settings.base));
  }
  hillshadeOpt.checked = settings.hillshade;
  wakeOpt.checked = settings.wakeLock;
}
syncMenu();

async function refreshTrackList() {
  const list = $('track-list');
  const tracks = await listTracks().catch(() => [] as Track[]);
  list.replaceChildren(
    ...tracks.map((t) => {
      const li = document.createElement('li');
      const date = new Date(t.startedAt);
      const dur = formatDuration((t.endedAt ?? Date.now()) - t.startedAt);
      li.innerHTML = `<div class="title"></div>
        <div class="meta">${date.toLocaleDateString('ja-JP')}・${dur}・${formatDistance(t.distance)}・登り ${fmtEle(t.ascent)}${t.status === 'recording' ? '・記録中' : ''}</div>
        <div class="row"></div>`;
      li.querySelector('.title')!.textContent = t.name;
      const row = li.querySelector('.row')!;
      const btn = (label: string, fn: () => void, cls = '') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn ${cls}`;
        b.textContent = label;
        b.addEventListener('click', fn);
        row.append(b);
        return b;
      };
      btn('地図に表示', () => void showSavedTrack(t)).disabled = recorder.recording;
      btn('GPX書き出し', () => void exportTrack(t));
      btn(
        '削除',
        async () => {
          if (!confirm(`「${t.name}」を削除しますか？`)) return;
          await deleteTrack(t.id);
          if (shown?.track.id === t.id) {
            recorder.clear();
            shown = null;
            renderTrack();
            updateStats();
          }
          await refreshTrackList();
        },
        'danger',
      ).disabled = t.status === 'recording';
      return li;
    }),
  );
}

async function showSavedTrack(t: Track) {
  if (recorder.recording) return;
  recorder.clear(); // 直前に記録した軌跡の表示を外す
  const points = await getPoints(t.id);
  shown = { track: t, points };
  renderTrack();
  updateStats();
  menu.close();
  if (points.length) {
    const lngs = points.map((p) => p.lng);
    const lats = points.map((p) => p.lat);
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 60, maxZoom: 15 },
    );
  }
  setProfileOpen(true);
}

async function exportTrack(t: Track) {
  const points = await getPoints(t.id);
  const gpx = toGpx(
    t.name,
    points.map((p) => ({ lng: p.lng, lat: p.lat, ele: p.ele ?? p.alt ?? undefined, time: p.t })),
  );
  const d = new Date(t.startedAt);
  const fname = `yama-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.gpx`;
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** 前回、記録中のままアプリが閉じられていたら再開を確認する */
async function checkUnfinished() {
  const tracks = await listTracks().catch(() => [] as Track[]);
  const open = tracks.find((t) => t.status === 'recording');
  if (!open) return;
  if (confirm(`「${open.name}」の記録が途中です。続きを記録しますか？\n（キャンセルするとここまでで保存します）`)) {
    await recorder.resume(open);
    geolocate.trigger();
  } else {
    const points = await getPoints(open.id);
    await putTrack({ ...open, status: 'done', endedAt: points[points.length - 1]?.t ?? open.startedAt });
  }
}

// ---------- オフライン保存 ----------
const offlineBtn = $<HTMLButtonElement>('btn-offline');
const offlineInfo = $('offline-info');
const offlineProgress = $<HTMLProgressElement>('offline-progress');
let downloading: AbortController | null = null;

offlineBtn.addEventListener('click', async () => {
  if (downloading) {
    downloading.abort();
    return;
  }
  const c = map.getCenter();
  const canvas = map.getCanvas();
  const bounds = viewBounds([c.lng, c.lat], map.getZoom(), canvas.clientWidth, canvas.clientHeight);
  const layers = downloadLayers(BASE_LAYERS[settings.base].url, 16);
  const n = estimateTiles(bounds, layers);
  if (n > MAX_TILES) {
    alert(`範囲が広すぎます（${n.toLocaleString()}枚）。地図を拡大してから保存してください。`);
    return;
  }
  const mb = Math.max(1, Math.round((n * 30) / 1024));
  if (!confirm(`表示中の範囲（ズーム16まで）を保存します。\n約${n.toLocaleString()}枚・目安 ${mb} MB\nWi-Fi環境での実行がおすすめです。`)) return;
  downloading = new AbortController();
  offlineBtn.textContent = '中止';
  offlineProgress.hidden = false;
  offlineProgress.max = n;
  offlineProgress.value = 0;
  const result = await downloadTiles(
    planTiles(bounds, layers),
    (p) => {
      offlineProgress.value = p.done;
      offlineInfo.textContent = `保存中… ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`;
    },
    downloading.signal,
  );
  const aborted = downloading.signal.aborted;
  downloading = null;
  offlineBtn.textContent = '表示中の範囲を保存';
  offlineProgress.hidden = true;
  offlineInfo.textContent = aborted
    ? '中止しました'
    : `保存しました（${result.done - result.failed}枚${result.failed ? `、失敗 ${result.failed}枚` : ''}）`;
  void refreshStorage();
});

$('btn-cache-clear').addEventListener('click', async () => {
  if (!confirm('保存した地図をすべて削除しますか？（記録した軌跡は消えません）')) return;
  await clearTileCache();
  offlineInfo.textContent = '削除しました';
  void refreshStorage();
});

async function refreshStorage() {
  $('storage-info').textContent = (await storageUsage().catch(() => null)) ?? '';
}

// ---------- レイアウト ----------
function updatePanelHeight() {
  const h = $('panel').getBoundingClientRect().height;
  document.documentElement.style.setProperty('--panel-h', `${Math.round(h)}px`);
}
new ResizeObserver(updatePanelHeight).observe($('panel'));
updateStats();
updateStatus();

// ---------- Service Worker（オフライン対応） ----------
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('./sw.js');
      await navigator.serviceWorker.ready;
      // 初回表示で読み込んだアプリ本体（JS/CSS/ワーカー）をすぐキャッシュし、次回から圏外でも起動できるようにする
      const own = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((u) => u.startsWith(location.origin));
      const cache = await caches.open('yama-map-shell-v1');
      await Promise.all(
        [...new Set([...own, new URL(workerUrl, location.href).href])].map((u) =>
          cache.match(u, { ignoreVary: true }).then((hit) => (hit ? undefined : cache.add(u))).catch(() => undefined),
        ),
      );
    } catch (e) {
      console.warn('Service Worker の登録に失敗しました', e);
    }
  });
}

// デバッグ用
declare global {
  interface Window {
    yamaMap?: { map: MlMap; recorder: TrackRecorder };
  }
}
window.yamaMap = { map, recorder };
