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
} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { FeatureCollection } from 'geojson';
import {
  cumulativeDistances,
  distance,
  formatDistance,
  formatDuration,
  viewBounds,
  type LngLat,
} from './geo';
import { DemSampler, registerGsiDemProtocol } from './map/gsiDem';
import { BASE_LAYERS, TERRAIN_EXAGGERATION, createStyle, set3D, setBaseLayer, setHillshade, type BaseLayerId } from './map/style';
import {
  PACE_PRESETS,
  RouteTimeline,
  analyzePace,
  defaultFactors,
  estimate,
  projectOnRoute,
  type LegEstimate,
  type PacePreset,
  type PaceStats,
  type RoutePosition,
} from './nav/eta';
import {
  buildAutoRoute,
  buildGpxRoute,
  insertVia,
  loadSavedRoute,
  makePoint,
  normalizePoints,
  placeOnRoute,
  routeSpan,
  saveRoute,
  type ActiveRoute,
  type Mark,
  type MarkKind,
  type PlanPoint,
} from './nav/plan';
import { sunTimes } from './nav/sun';
import {
  MAX_TILES,
  clearTileCache,
  downloadLayers,
  downloadTiles,
  estimateTiles,
  planTiles,
  storageUsage,
} from './offline/download';
import { nearestPlaceName } from './route/roadTiles';
import { deleteTrack, getPoints, listTracks, putTrack, type Track, type TrackPoint } from './track/db';
import { parseGpx, toGpx } from './track/gpx';
import { TrackRecorder } from './track/recorder';
import { ElevationProfile } from './ui/profile';
import { BottomSheet } from './ui/sheet';

setWorkerUrl(workerUrl);
registerGsiDemProtocol();

// ---------- 設定（端末に保存） ----------
interface Settings {
  base: BaseLayerId;
  hillshade: boolean;
  terrain: boolean;
  wakeLock: boolean;
  pace: PacePreset;
  view?: { center: LngLat; zoom: number; pitch: number; bearing: number };
}
const SETTINGS_KEY = 'yama-map:settings';
const settings: Settings = { base: 'std', hillshade: true, terrain: false, wakeLock: true, pace: 'normal' };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'));
} catch {
  /* 保存領域が使えない環境でも動かす */
}
if (!(settings.base in BASE_LAYERS)) settings.base = 'std';
if (!(settings.pace in PACE_PRESETS)) settings.pace = 'normal';
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* noop */
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};
const fmtM = (m: number | null | undefined) => (m == null ? '–' : `${Math.round(m).toLocaleString('ja-JP')} m`);
const fmtClock = (ms: number) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};
/** 分 → 「1時間05分」「38分」 */
const fmtMin = (min: number) => {
  const m = Math.max(0, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)}時間${String(m % 60).padStart(2, '0')}分` : `${m}分`;
};
const fmtHM = (min: number) => {
  const m = Math.max(0, Math.round(min));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

// ---------- 地図 ----------
const dem = new DemSampler(96);
const elevation = (lng: number, lat: number) => dem.elevation(lng, lat);
const map = new MlMap({
  container: 'map',
  style: createStyle(settings.base, settings.hillshade),
  center: settings.view?.center ?? [139.4165, 36.8705], // 初期表示：奥鬼怒
  zoom: settings.view?.zoom ?? 13.3,
  pitch: settings.view?.pitch ?? 0,
  bearing: settings.view?.bearing ?? 0,
  maxPitch: 80,
  attributionControl: { compact: true },
});

class Terrain3DControl implements IControl {
  private container?: HTMLDivElement;
  private button?: HTMLButtonElement;
  onAdd(): HTMLElement {
    this.container = h('div', 'maplibregl-ctrl maplibregl-ctrl-group');
    this.button = h('button', 'ctrl-3d', '3D');
    this.button.type = 'button';
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
    this.button?.setAttribute('aria-pressed', String(settings.terrain));
    this.button?.setAttribute('aria-label', settings.terrain ? '2D表示に切り替え' : '3D表示に切り替え');
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
// スマホではピンチで拡大縮小するので +/- ボタンは出さない（方位だけ）
map.addControl(new NavigationControl({ showZoom: false, visualizePitch: true }), 'top-right');
map.addControl(geolocate, 'top-right');
map.addControl(new Terrain3DControl(), 'top-right');
map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

const emptyFC: FeatureCollection = { type: 'FeatureCollection', features: [] };
const lineFC = (coords: LngLat[]): FeatureCollection =>
  coords.length < 2
    ? emptyFC
    : { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] };
const pointFC = (c: LngLat | null): FeatureCollection =>
  c ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }] } : emptyFC;
const src = (id: string) => map.getSource(id) as GeoJSONSource | undefined;

map.on('load', () => {
  for (const id of ['route', 'route-done', 'track', 'cursor']) map.addSource(id, { type: 'geojson', data: emptyFC });
  const casing = { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 };
  const round = { 'line-join': 'round' as const, 'line-cap': 'round' as const };
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: round, paint: casing });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#2563eb', 'line-width': 5 } });
  map.addLayer({ id: 'route-done', type: 'line', source: 'route-done', layout: round, paint: { 'line-color': '#93a3b8', 'line-width': 5 } });
  map.addLayer({ id: 'track-casing', type: 'line', source: 'track', layout: round, paint: { ...casing, 'line-width': 6 } });
  map.addLayer({ id: 'track-line', type: 'line', source: 'track', layout: round, paint: { 'line-color': '#d6334a', 'line-width': 3.5 } });
  map.addLayer({
    id: 'cursor',
    type: 'circle',
    source: 'cursor',
    paint: { 'circle-radius': 8, 'circle-color': '#1f2933', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
  if (settings.terrain) map.setTerrain({ source: 'dem-terrain', exaggeration: TERRAIN_EXAGGERATION });
  renderRoute();
  renderTrack();
  updateNav();
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

function fitTo(coords: LngLat[]) {
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

// ---------- 地図タップ：標高と「出発地・経由地・目的地」 ----------
const popup = new Popup({ closeButton: false, maxWidth: '300px', offset: 8 });
let popupSeq = 0;
map.on('click', async (e) => {
  const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat];
  const seq = ++popupSeq;
  const box = h('div', 'pp');
  const name = h('div', 'pp-name', ' ');
  const ele = h('div', 'pp-ele', '標高 …');
  const coord = h('div', 'pp-coord', `${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`);
  const eta = h('div', 'pp-eta');
  const actions = h('div', 'pp-actions');
  let placeName: string | null = null;
  for (const [kind, label] of [
    ['start', '出発地'],
    ['via', '経由地'],
    ['dest', '目的地'],
  ] as [MarkKind, string][]) {
    const b = h('button', kind, label);
    b.type = 'button';
    b.addEventListener('click', () => void choosePoint(kind, lngLat, placeName ?? undefined));
    actions.append(b);
  }
  box.append(name, ele, coord, eta, actions);
  popup.setLngLat(e.lngLat).setDOMContent(box).addTo(map);
  // ルート上ならここまでの到着予想も出す
  const nav = lastNav;
  if (route && timeline && nav) {
    const pos = projectOnRoute(route.coords, route.dists, lngLat);
    if (pos && pos.offset < 150) {
      if (pos.along > nav.fromAlong) {
        const est = estimate(timeline, nav.fromAlong, pos.along, nav.factors);
        eta.textContent = `ここまで ${formatDistance(pos.along - nav.fromAlong)}・${fmtClock(Date.now() + est.totalMin * 60_000)}着（${fmtMin(est.totalMin)}）`;
      } else eta.textContent = '通過済み';
    }
  }
  const [el, nm] = await Promise.all([dem.elevation(lngLat[0], lngLat[1]), nearestPlaceName(lngLat, 200)]);
  if (seq !== popupSeq) return;
  ele.textContent = `標高 ${fmtM(el)}`;
  placeName = nm;
  name.textContent = nm ? `${nm} 付近` : '';
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
  updateNav();
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
/** 直近10分以内に分かっている現在地 */
function hereLngLat(): LngLat | null {
  const recLast = recorder.state.points.at(-1);
  const cands = [
    lastFix ? { c: lastFix.coords, t: lastFix.t } : null,
    recLast ? { c: [recLast.lng, recLast.lat] as LngLat, t: recLast.t } : null,
  ]
    .filter((x): x is { c: LngLat; t: number } => !!x)
    .sort((a, b) => b.t - a.t);
  return cands[0] && Date.now() - cands[0].t < 10 * 60_000 ? cands[0].c : null;
}

// ---------- 記録 ----------
let shown: { track: Track; points: TrackPoint[] } | null = null;
const recorder = new TrackRecorder(dem, (s) => {
  if (s.track) shown = { track: s.track, points: s.points };
  else if (shown && !recorder.recording) shown = null;
  renderTrack();
  updateRecButton();
  updateNav();
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
    if (!lastFix || Date.now() - lastFix.t > 30_000) geolocate.trigger();
    status('記録を開始しました。歩いた実績から到着予想を調整します');
  } else {
    if (!confirm('記録を終了しますか？')) return;
    const t = await recorder.stop();
    if (t) status(`記録を保存しました：${formatDistance(t.distance)}・登り ${fmtM(t.ascent)}`);
  }
  void refreshTrackList();
});

function updateRecButton() {
  const rec = recorder.recording;
  recBtn.classList.toggle('recording', rec);
  recBtn.querySelector('.text')!.textContent = rec ? '記録終了' : '記録開始';
}

function renderTrack() {
  src('track')?.setData(lineFC((shown?.points ?? []).map((p): LngLat => [p.lng, p.lat])));
}

// ---------- 状態表示 ----------
let flash: { text: string; until: number; warn: boolean } | null = null;
let progressMsg = '';
function status(text: string, warn = false) {
  flash = { text, until: Date.now() + 6000, warn };
  renderStatus();
  setTimeout(renderStatus, 6100);
}
function renderStatus() {
  const el = $('status');
  let text = '';
  let warn = false;
  const rs = recorder.state;
  const nav = lastNav;
  if (progressMsg) text = progressMsg;
  else if (flash && flash.until > Date.now()) {
    text = flash.text;
    warn = flash.warn;
  } else if (rs.error && recorder.recording) {
    text = rs.error;
    warn = true;
  } else if (recorder.recording && rs.lastFix && rs.lastFix.coords.accuracy > 40) {
    text = `GPSの精度待ち（誤差 ${Math.round(rs.lastFix.coords.accuracy)} m）`;
    warn = true;
  } else if (nav?.offRoute && nav.pos) {
    text = `ルートから約 ${formatDistance(nav.pos.offset)} 離れています`;
    warn = true;
  } else if (recorder.recording && !rs.wakeLock && settings.wakeLock && 'wakeLock' in navigator) {
    text = '画面を消すと記録が止まります';
    warn = true;
  } else if (!navigator.onLine) {
    text = 'オフライン（保存済みの地図を表示中）';
  }
  el.hidden = !text;
  el.textContent = text;
  el.classList.toggle('warn', warn);
}
window.addEventListener('online', renderStatus);
window.addEventListener('offline', renderStatus);

// ---------- 行程（ルート・出発地・経由地・目的地） ----------
let route: ActiveRoute | null = loadSavedRoute();
let timeline: RouteTimeline | null = route ? new RouteTimeline(route.dists, route.eles) : null;
/** ルートができる前に選ばれた地点（出発地待ちなど） */
let pending: PlanPoint[] = [];
let markers: Marker[] = [];
let building = false;

function setRoute(r: ActiveRoute | null, fit = false) {
  route = r;
  timeline = r ? new RouteTimeline(r.dists, r.eles) : null;
  lastNav = null;
  pending = [];
  saveRoute(r);
  renderRoute();
  if (fit && r) fitTo(r.coords);
  updateNav();
}

function renderRoute() {
  src('route')?.setData(lineFC(route?.coords ?? []));
  for (const m of markers) m.remove();
  const list: (PlanPoint | Mark)[] = route ? route.marks : pending;
  let viaNo = 0;
  markers = list.map((m) => {
    const el = h('div', `mk ${m.kind}`);
    el.append(h('div', 'pin', m.kind === 'start' ? 'S' : m.kind === 'dest' ? 'G' : String(++viaNo)), h('div', 'tag', m.name));
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openSheet();
    });
    return new Marker({ element: el, anchor: 'top', offset: [0, -14] }).setLngLat(m.lngLat).addTo(map);
  });
  $<HTMLButtonElement>('btn-fit').disabled = !route;
}

async function choosePoint(kind: MarkKind, lngLat: LngLat, name?: string) {
  popup.remove();
  if (building) return;
  const pt = makePoint(kind, lngLat, name);
  if (route?.source === 'gpx') {
    const placed = placeOnRoute(route, pt);
    if (placed) {
      setRoute(placed);
      status(`${pt.name}を${kind === 'dest' ? '目的地' : kind === 'start' ? '出発地' : '経由地'}にしました`);
      return;
    }
    if (!confirm('読み込んだルートから離れています。\n道に沿った新しいルートを作りますか？')) return;
    const start = route.marks.find((m) => m.kind === 'start');
    pending = start ? [{ id: start.id, kind: start.kind, name: start.name, lngLat: start.lngLat }] : [];
    route = null;
  }
  let pts = route?.points ? [...route.points] : [...pending];
  if (kind === 'via') pts = pts.length >= 2 ? insertVia(normalizePoints(pts), pt) : [...pts, pt];
  else pts = [...pts.filter((p) => p.kind !== kind), pt];
  // 出発地がなければ現在地から
  if (!pts.some((p) => p.kind === 'start') && pts.some((p) => p.kind === 'dest')) {
    const here = hereLngLat();
    if (here) pts = [makePoint('start', here, '現在地'), ...pts];
  }
  pts = normalizePoints(pts);
  if (pts.some((p) => p.kind === 'start') && pts.some((p) => p.kind === 'dest')) {
    await rebuild(pts);
  } else {
    if (route) setRoute(null);
    pending = pts;
    renderRoute();
    updateNav();
    status(
      pts.some((p) => p.kind === 'dest')
        ? '出発地を選んでください（地図をタップ →「出発地」）'
        : '目的地を選んでください（地図をタップ →「目的地」）',
    );
  }
}

async function rebuild(pts: PlanPoint[]) {
  building = true;
  try {
    const r = await buildAutoRoute(pts, elevation, (msg) => {
      progressMsg = msg;
      renderStatus();
    });
    progressMsg = '';
    setRoute(r, true);
    const span = routeSpan(r);
    if (r.straightLegs) status('道が見つからない区間は直線で結んでいます（到着予想は不正確です）', true);
    else status(`ルートを作成しました：${formatDistance(span.to - span.from)}`);
    openSheet();
  } catch (err) {
    pending = pts;
    renderRoute();
    status(err instanceof Error ? err.message : 'ルートを作成できませんでした', true);
  } finally {
    building = false;
    progressMsg = '';
    renderStatus();
  }
}

async function removeMark(id: string) {
  if (!route) return;
  if (route.source === 'auto' && route.points) await rebuild(route.points.filter((p) => p.id !== id));
  else setRoute({ ...route, marks: route.marks.filter((m) => m.id !== id) });
}

function clearRoute() {
  if (!confirm('ルートと目的地を消しますか？')) return;
  setRoute(null);
}

function exportRoute() {
  const r = route;
  if (!r) return;
  const gpx = toGpx(
    r.name,
    r.coords.map((c, i) => ({ lng: c[0], lat: c[1], ele: r.eles[i] ?? undefined })),
    r.marks.map((m) => ({ lng: m.lngLat[0], lat: m.lngLat[1], name: m.name })),
  );
  download(`${r.name.replace(/[\\/:*?"<>|\s→]+/g, '_')}.gpx`, gpx);
}

async function loadGpxText(text: string) {
  const r = await buildGpxRoute(parseGpx(text), elevation);
  setRoute(r, true);
  const span = routeSpan(r);
  status(`${r.name}：${formatDistance(span.to - span.from)}`);
}

// ---------- 到着予想 ----------
interface Row {
  mark: Mark;
  passed: boolean;
  /** 到着予想、または実際に到着した時刻 (ms) */
  time: number | null;
  /** 現在地からの残り距離 */
  remainM: number;
  remain: LegEstimate | null;
  /** 前の地点からの区間 */
  leg: { dist: number; up: number; down: number; est: LegEstimate } | null;
}
interface Nav {
  pos: RoutePosition | null;
  onRoute: boolean;
  offRoute: boolean;
  fromAlong: number;
  factors: ReturnType<typeof defaultFactors>;
  pace: PaceStats | null;
  rows: Row[];
  next: Row | null;
  dest: Row | null;
  sunset: number | null;
}
let lastNav: Nav | null = null;

function gainBetween(tl: RouteTimeline, a: number, b: number) {
  return tl.gain(a, b);
}

/** 記録の中で地点の近く（80m以内）を最初に通った時刻 */
function arrivalTime(m: Mark): number | null {
  for (const p of recorder.state.points) if (distance([p.lng, p.lat], m.lngLat) < 80) return p.t;
  return null;
}

function computeNav(): Nav | null {
  const r = route;
  const tl = timeline;
  if (!r || !tl) return null;
  const span = routeSpan(r);
  const here = hereLngLat();
  const pos = here ? projectOnRoute(r.coords, r.dists, here, lastNav?.pos?.along) : null;
  const onRoute = !!pos && pos.offset < 300 && pos.along >= span.from - 100 && pos.along <= span.to + 100;
  const pace = recorder.recording ? analyzePace(recorder.state.points, settings.pace) : null;
  const factors = pace?.factors ?? defaultFactors(settings.pace);
  const fromAlong = onRoute && pos ? Math.min(span.to, Math.max(span.from, pos.along)) : span.from;
  const now = Date.now();
  const marks = r.marks.filter((m) => m.along >= span.from - 1 && m.along <= span.to + 1);
  const rows: Row[] = marks.map((m, i) => {
    const prev = i > 0 ? marks[i - 1].along : m.along;
    const g = gainBetween(tl, prev, m.along);
    const passed = onRoute && m.along <= fromAlong + 30;
    const remain = passed ? null : estimate(tl, fromAlong, m.along, factors);
    return {
      mark: m,
      passed,
      time: remain ? now + remain.totalMin * 60_000 : arrivalTime(m),
      remainM: Math.max(0, m.along - fromAlong),
      remain,
      leg: i > 0 ? { dist: m.along - prev, up: g.ascent, down: g.descent, est: estimate(tl, prev, m.along, factors) } : null,
    };
  });
  const sun = sunTimes(new Date(), r.coords[0][1], r.coords[0][0]);
  return {
    pos,
    onRoute,
    offRoute: !!pos && pos.offset >= 150 && pos.offset < 5000 && recorder.recording,
    fromAlong,
    factors,
    pace,
    rows,
    next: rows.find((x) => !x.passed && x.mark.kind !== 'start') ?? null,
    dest: rows.at(-1) ?? null,
    sunset: sun.sunset?.getTime() ?? null,
  };
}

let arrivedNotified = false;
function updateNav() {
  const nav = computeNav();
  lastNav = nav;
  if (nav?.dest?.passed && !arrivedNotified) {
    arrivedNotified = true;
    status(`${nav.dest.mark.name}に到着しました。おつかれさまでした！`);
  }
  if (!nav?.dest?.passed) arrivedNotified = false;
  // 歩き終えた部分のルートを灰色に
  if (route && nav?.onRoute) {
    const done: LngLat[] = [];
    for (let i = 0; i < route.coords.length && route.dists[i] <= nav.fromAlong; i++) done.push(route.coords[i]);
    src('route-done')?.setData(lineFC(done));
  } else src('route-done')?.setData(emptyFC);
  renderCard(nav);
  if (sheet.isOpen) renderBody(nav);
  renderStatus();
}
setInterval(() => {
  if (document.visibilityState === 'visible') updateNav();
}, 15_000);
setInterval(() => {
  // ルートなしで記録中は経過時間を毎秒更新
  if (recorder.recording && !route && document.visibilityState === 'visible') renderCard(lastNav);
}, 1000);

const isLate = (row: Row, sunset: number | null) => !row.passed && !!sunset && !!row.time && row.time > sunset - 30 * 60_000;

function navRow(label: string, row: Row, primary: boolean, sunset: number | null): HTMLElement {
  const el = h('div', `nav-row${primary ? ' primary' : ''}${isLate(row, sunset) ? ' late' : ''}`);
  const lab = h('div', 'nav-label');
  lab.append(`${label} · `, h('b', '', row.mark.name));
  const remain = h('div', 'nav-remain');
  const clock = h('div', 'nav-clock');
  if (row.passed) {
    clock.textContent = row.time ? fmtClock(row.time) : '✓';
    remain.textContent = '到着済み';
  } else if (row.remain && row.time) {
    clock.append(fmtClock(row.time), h('small', '', '着'));
    remain.textContent = `あと ${fmtMin(row.remain.totalMin)} · ${formatDistance(row.remainM)}`;
  }
  el.append(lab, remain, clock);
  return el;
}

function renderCard(nav: Nav | null) {
  const card = $('card');
  card.replaceChildren();
  if (nav && route) {
    const { next, dest } = nav;
    if (next && dest && next !== dest) card.append(navRow('次', next, false, nav.sunset));
    if (dest) card.append(navRow('目的地', dest, true, nav.sunset));
    const sub = h('div', 'nav-sub');
    if (!nav.onRoute && dest && !dest.passed) sub.append(h('span', '', '今出発した場合'));
    if (nav.pace && nav.pace.evidenceMin > 10) sub.append(h('span', '', `実績ペース 標準の${nav.pace.overall.toFixed(2)}倍`));
    else sub.append(h('span', '', `ペース「${PACE_PRESETS[settings.pace].label}」`));
    sub.append(h('span', '', `休憩込み`));
    if (nav.sunset) {
      const late = dest ? isLate(dest, nav.sunset) : false;
      sub.append(h('span', late ? 'warn' : '', `日没 ${fmtClock(nav.sunset)}${late ? '（要注意）' : ''}`));
    }
    card.append(sub);
    return;
  }
  if (shown) {
    const t = shown.track;
    const end = t.status === 'recording' ? Date.now() : (t.endedAt ?? Date.now());
    const tiles = h('div', 'tiles');
    for (const [label, value] of [
      ['時間', formatDuration(end - t.startedAt)],
      ['距離', formatDistance(t.distance)],
      ['登り', fmtM(t.ascent)],
      ['標高', fmtM(currentEle ?? shown.points.at(-1)?.ele)],
    ]) {
      const tile = h('div', 'tile');
      tile.append(h('span', 'label', label), h('span', 'value', value));
      tiles.append(tile);
    }
    card.append(tiles);
    return;
  }
  const empty = h('div', 'nav-empty');
  if (pending.some((p) => p.kind === 'dest')) {
    empty.append(h('b', '', '出発地を選んでください'), h('br'), h('span', 'hint', '地図をタップ →「出発地」。右上の ◎ で現在地を出してから目的地を選ぶと、現在地から出発します'));
  } else {
    empty.append(h('b', '', '目的地を設定しましょう'), h('br'), h('span', 'hint', '地図をタップ →「目的地」で、道沿いのルートと到着予想を表示します'));
  }
  card.append(empty);
}

function renderBody(nav: Nav | null) {
  const tl = $('timeline');
  tl.replaceChildren();
  const actions = $('plan-actions');
  actions.replaceChildren();
  $('sec-plan').hidden = !route;
  $('sec-profile').hidden = !(route || (shown && shown.points.length > 1));
  if (nav && route && timeline) {
    const items: { time: number | null; passed: boolean; el: HTMLElement }[] = [];
    for (const row of nav.rows) {
      const li = h('li', `${row.mark.kind}${row.passed ? ' passed' : ''}${isLate(row, nav.sunset) ? ' late' : ''}`);
      const time = h('div', 'time', row.time ? fmtClock(row.time) : row.passed ? '✓' : '–');
      time.append(h('small', '', row.mark.kind === 'start' ? '出発' : row.passed ? (row.time ? '到着' : '通過') : '予想'));
      const body = h('div');
      body.append(h('div', 'name', row.mark.name));
      if (row.leg) {
        const l = row.leg;
        body.append(
          h('div', 'leg', `${formatDistance(l.dist)} · ↑${Math.round(l.up)}m ↓${Math.round(l.down)}m · 標準 ${fmtHM(l.est.stdMin)} → 歩行 ${fmtHM(l.est.movingMin)}`),
        );
      } else body.append(h('div', 'leg', ''));
      const del = h('div');
      if (row.mark.kind === 'via' && !row.passed) {
        const b = h('button', 'del', '✕');
        b.type = 'button';
        b.setAttribute('aria-label', `${row.mark.name}を削除`);
        b.addEventListener('click', () => void removeMark(row.mark.id));
        del.append(b);
      }
      li.append(time, h('div', 'dot'), body, del);
      items.push({ time: row.time, passed: row.passed, el: li });
    }
    // 到着予想が日没の前後1時間にかかるなら、日没を時系列に差し込む
    const destTime = nav.dest?.time;
    if (nav.sunset && destTime && !nav.dest?.passed && destTime + 60 * 60_000 > nav.sunset) {
      const li = h('li', 'sun');
      const time = h('div', 'time', fmtClock(nav.sunset));
      time.append(h('small', '', '日没'));
      const body = h('div');
      body.append(h('div', 'name', '日没'), h('div', 'leg', '谷では日没前に暗くなります。ヘッドランプを忘れずに'));
      li.append(time, h('div', 'dot'), body, h('div'));
      let idx = items.findIndex((it) => !it.passed && it.time != null && it.time > nav.sunset!);
      if (idx < 0) idx = items.length;
      items.splice(idx, 0, { time: nav.sunset, passed: false, el: li });
    }
    tl.append(...items.map((i) => i.el));
    const span = routeSpan(route);
    const total = estimate(timeline, span.from, span.to, nav.factors);
    const sum = h('p', 'note');
    sum.textContent = `全行程 ${formatDistance(span.to - span.from)}・標準 ${fmtHM(total.stdMin)}・このペースで 歩行 ${fmtHM(total.movingMin)} ＋ 休憩 ${fmtHM(total.restMin)}${route.straightLegs ? '・一部直線区間あり' : ''}`;
    tl.append(sum);
    const btn = (label: string, fn: () => void, cls = '') => {
      const b = h('button', `btn ${cls}`, label);
      b.type = 'button';
      b.addEventListener('click', fn);
      actions.append(b);
    };
    btn('GPXで保存', exportRoute);
    btn('ルートを消す', clearRoute, 'danger');
  }

  updateProfile(nav);

  // これまでのペース
  const grid = $('pace-grid');
  grid.replaceChildren();
  const p = nav?.pace ?? (recorder.recording ? analyzePace(recorder.state.points, settings.pace) : null);
  const tiles: [string, string][] = p
    ? [
        ['経過', formatDuration(p.elapsedMs)],
        ['歩行', formatDuration(p.movingMs)],
        ['休憩', formatDuration(p.restMs)],
        ['距離', formatDistance(p.distance)],
        ['平均(歩行中)', p.movingKmh ? `${p.movingKmh.toFixed(1)}km/h` : '–'],
        ['登りの速さ', p.climbRate ? `${Math.round(p.climbRate)}m/h` : '–'],
        ['標準比', p.evidenceMin > 10 ? `${p.overall.toFixed(2)}倍` : '–'],
        ['登/平/下', p.evidenceMin > 10 ? `${p.factors.up.toFixed(1)}/${p.factors.flat.toFixed(1)}/${p.factors.down.toFixed(1)}` : '–'],
        ['標高', fmtM(currentEle ?? recorder.state.points.at(-1)?.ele)],
      ]
    : [
        ['標高', fmtM(currentEle)],
        ['休憩見込み', `${Math.round((nav?.factors.rest ?? 1 / 6) * 60)}分/時`],
        ['ペース', PACE_PRESETS[settings.pace].label],
      ];
  for (const [label, value] of tiles) {
    const tile = h('div', 'tile');
    tile.append(h('span', 'label', label), h('span', 'value', value));
    grid.append(tile);
  }
  $('pace-note').textContent = p
    ? `「標準比」は地形（距離と勾配）から求めた標準タイムに対して何倍かかっているか。1より小さいほど速いペースです。登り・平坦・下りそれぞれの実績を使い、休憩は歩行1時間あたり約${Math.round(p.factors.rest * 60)}分の見込みで到着予想に含めています。`
    : '記録を開始すると、歩いた実績（登り・平坦・下りの速さ、休憩の取り方）から到着予想を自動で調整します。';
  for (const b of $('pace-preset').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.id === settings.pace));
}

// ---------- 標高グラフ ----------
const profileCanvas = $<HTMLCanvasElement>('profile');
let profileCoords: LngLat[] = [];
const profile = new ElevationProfile(profileCanvas, (i) => {
  src('cursor')?.setData(pointFC(i == null ? null : (profileCoords[i] ?? null)));
});
function updateProfile(nav: Nav | null) {
  if (route) {
    profileCoords = route.coords;
    profile.setData(route.dists, route.eles);
    profile.setTicks(route.marks.map((m) => ({ d: m.along, kind: m.kind, label: m.name })));
    if (nav?.onRoute) {
      let i = 0;
      while (i < route.dists.length - 1 && route.dists[i] < nav.fromAlong) i++;
      profile.setMarker(i);
    } else profile.setMarker(null);
  } else if (shown && shown.points.length > 1) {
    profileCoords = shown.points.map((p) => [p.lng, p.lat]);
    profile.setData(cumulativeDistances(profileCoords), shown.points.map((p) => p.ele));
    profile.setTicks([]);
    profile.setMarker(null);
  }
}

// ---------- ボトムシート ----------
const sheet = new BottomSheet($('sheet-handle'), [$('card')], $('sheet-body'), (open) => {
  if (open) renderBody(lastNav);
  else src('cursor')?.setData(emptyFC);
});
function openSheet() {
  if (!sheet.isOpen) sheet.setOpen(true);
}
$('btn-fit').addEventListener('click', () => route && fitTo(route.coords));
const paceSeg = $('pace-preset');
for (const [id, def] of Object.entries(PACE_PRESETS) as [PacePreset, (typeof PACE_PRESETS)[PacePreset]][]) {
  const b = h('button', '', def.label);
  b.type = 'button';
  b.setAttribute('role', 'radio');
  b.dataset.id = id;
  b.addEventListener('click', () => {
    settings.pace = id;
    saveSettings();
    updateNav();
  });
  paceSeg.append(b);
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

const PRESETS = [
  {
    file: 'routes/okukinu-teshirosawa.gpx',
    title: '女夫渕 → 手白澤温泉',
    desc: '奥鬼怒歩道・八丁の湯・加仁湯経由 約6km',
  },
];
const presetWrap = $('preset-routes');
for (const p of PRESETS) {
  const b = h('button', 'btn block');
  b.type = 'button';
  b.append(h('span', '', p.title), h('small', '', p.desc));
  b.addEventListener('click', async () => {
    menu.close();
    try {
      progressMsg = 'ルートを読み込み中…';
      renderStatus();
      const res = await fetch(p.file);
      if (!res.ok) throw new Error('ルートを読み込めませんでした');
      await loadGpxText(await res.text());
      openSheet();
    } catch (err) {
      status(err instanceof Error ? err.message : String(err), true);
    } finally {
      progressMsg = '';
      renderStatus();
    }
  });
  presetWrap.append(b);
}

$<HTMLInputElement>('gpx-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  menu.close();
  try {
    progressMsg = 'GPXを読み込み中…';
    renderStatus();
    await loadGpxText(await file.text());
    openSheet();
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  } finally {
    progressMsg = '';
    renderStatus();
  }
});

const baseWrap = $('base-layers');
for (const [id, def] of Object.entries(BASE_LAYERS) as [BaseLayerId, (typeof BASE_LAYERS)[BaseLayerId]][]) {
  const b = h('button', '', def.label);
  b.type = 'button';
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
  for (const b of baseWrap.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.id === settings.base));
  hillshadeOpt.checked = settings.hillshade;
  wakeOpt.checked = settings.wakeLock;
}
syncMenu();

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function refreshTrackList() {
  const list = $('track-list');
  const tracks = await listTracks().catch(() => [] as Track[]);
  list.replaceChildren(
    ...tracks.map((t) => {
      const li = h('li');
      const date = new Date(t.startedAt);
      const dur = formatDuration((t.endedAt ?? Date.now()) - t.startedAt);
      li.append(
        h('div', 'title', t.name),
        h('div', 'meta', `${date.toLocaleDateString('ja-JP')}・${dur}・${formatDistance(t.distance)}・登り ${fmtM(t.ascent)}${t.status === 'recording' ? '・記録中' : ''}`),
      );
      const row = h('div', 'row');
      const btn = (label: string, fn: () => void, cls = '') => {
        const b = h('button', `btn ${cls}`, label);
        b.type = 'button';
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
            updateNav();
          }
          await refreshTrackList();
        },
        'danger',
      ).disabled = t.status === 'recording';
      li.append(row);
      return li;
    }),
  );
}

async function showSavedTrack(t: Track) {
  if (recorder.recording) return;
  recorder.clear();
  const points = await getPoints(t.id);
  shown = { track: t, points };
  renderTrack();
  menu.close();
  fitTo(points.map((p) => [p.lng, p.lat]));
  updateNav();
}

async function exportTrack(t: Track) {
  const points = await getPoints(t.id);
  const gpx = toGpx(
    t.name,
    points.map((p) => ({ lng: p.lng, lat: p.lat, ele: p.ele ?? p.alt ?? undefined, time: p.t })),
  );
  const d = new Date(t.startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  download(`yama-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.gpx`, gpx);
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
  // ルートがあればルート全体、なければ表示中の範囲
  let bounds: [number, number, number, number];
  if (route) {
    const lngs = route.coords.map((c) => c[0]);
    const lats = route.coords.map((c) => c[1]);
    const pad = 0.005;
    bounds = [Math.min(...lngs) - pad, Math.min(...lats) - pad, Math.max(...lngs) + pad, Math.max(...lats) + pad];
  } else {
    const c = map.getCenter();
    const canvas = map.getCanvas();
    bounds = viewBounds([c.lng, c.lat], map.getZoom(), canvas.clientWidth, canvas.clientHeight);
  }
  const layers = downloadLayers(BASE_LAYERS[settings.base].url, 16);
  const n = estimateTiles(bounds, layers);
  if (n > MAX_TILES) {
    alert(`範囲が広すぎます（${n.toLocaleString()}枚）。地図を拡大してから保存してください。`);
    return;
  }
  const mb = Math.max(1, Math.round((n * 30) / 1024));
  if (!confirm(`${route ? 'ルート周辺' : '表示中の範囲'}の地図（ズーム16まで）を保存します。\n約${n.toLocaleString()}枚・目安 ${mb} MB\nWi-Fi環境での実行がおすすめです。`)) return;
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
  offlineBtn.textContent = '地図を保存';
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
  offlineBtn.textContent = route ? 'ルート周辺の地図を保存' : '表示中の範囲を保存';
}

// ---------- レイアウト ----------
function updatePanelHeight() {
  // 縮尺・出典の表示位置は、閉じたときのシートの高さに合わせる
  const ht = $('sheet').getBoundingClientRect().height - $('sheet-body').getBoundingClientRect().height;
  document.documentElement.style.setProperty('--panel-h', `${Math.round(ht)}px`);
}
new ResizeObserver(updatePanelHeight).observe($('sheet'));
renderRoute();
updateNav();
updateRecButton();

// ---------- Service Worker（オフライン対応） ----------
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('./sw.js');
      await navigator.serviceWorker.ready;
      // 初回表示で読み込んだアプリ本体（JS/CSS/ワーカー）とおすすめルートをすぐキャッシュし、次回から圏外でも起動できるようにする
      const own = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((u) => u.startsWith(location.origin));
      const extra = [new URL(workerUrl, location.href).href, ...PRESETS.map((p) => new URL(p.file, location.href).href)];
      const cache = await caches.open('yama-map-shell-v1');
      await Promise.all(
        [...new Set([...own, ...extra])].map((u) =>
          cache.match(u, { ignoreVary: true }).then((hit) => (hit ? undefined : cache.add(u))).catch(() => undefined),
        ),
      );
    } catch (e) {
      console.warn('Service Worker の登録に失敗しました', e);
    }
  });
}

// デバッグ・動作確認用
declare global {
  interface Window {
    yamaMap?: { map: MlMap; recorder: TrackRecorder; nav: () => Nav | null; route: () => ActiveRoute | null };
  }
}
window.yamaMap = { map, recorder, nav: () => lastNav, route: () => route };
