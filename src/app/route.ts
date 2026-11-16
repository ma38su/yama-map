/** 行程：ルートと 出発地・経由地・目的地（作る・選び直す・消す・GPXの読み書き） */
import { Marker } from 'maplibre-gl';
import { formatDistance, type LngLat } from '../geo';
import { RouteTimeline } from '../nav/eta';
import {
  buildGpxRoute,
  buildRouteOptions,
  chooseOption,
  insertVia,
  makePoint,
  normalizePoints,
  placeOnRoute,
  preferredOption,
  reverseRoute,
  routeSnapshot,
  routeSpan,
  saveRoute,
  type ActiveRoute,
  type Mark,
  type PlanPoint,
  type PointKind,
} from '../nav/plan';
import { getTrackRoute, putTrackRoute, type Track } from '../track/db';
import { parseGpx, toGpx } from '../track/gpx';
import { settings } from '../settings';
import { $, download, h } from '../ui/dom';
import { elevation, fitTo, map, src, lineFC } from './mapView';
import { popup } from './mapTap';
import { updateNav, type Nav } from './nav';
import { hereLngLat, recorder } from './recording';
import { openSheet } from './sheetView';
import { state } from './state';
import { setProgress, status } from './status';

// ---------- 行程（ルート・出発地・経由地・目的地） ----------
let markers: Marker[] = [];
/** 記録を開いて、その記録のルートを出しているあいだ、隠している計画（ルートと、ルートになる前の地点）。記録を閉じたら戻す */
let planBehind: { route: ActiveRoute | null; pending: PlanPoint[] } | null = null;

/** ルートを表示中のルートにして、地図・到着予想を描き直す（端末への保存はしない） */
function applyRoute(r: ActiveRoute | null, fit: boolean) {
  state.route = r;
  state.timeline = r ? new RouteTimeline(r.dists, r.eles) : null;
  state.lastNav = null;
  state.pending = [];
  renderRoute();
  if (fit && r) fitTo(r.coords);
  updateNav();
}

/** ルートを設定する（計画のルートとして端末に保存する） */
export function setRoute(r: ActiveRoute | null, fit = false) {
  // 記録のルートを出しているあいだに変えたら、それが新しい計画になる（記録を閉じても、隠していた計画には戻さない）
  planBehind = null;
  saveRoute(r);
  applyRoute(r, fit);
  // 記録中に変えたら、記録と一緒に保存するルートも新しくする（消したときは、それまでのルートを残す）
  const track = recorder.recording ? recorder.state.track : null;
  if (track && r) void keepRouteWithTrack(track.id);
}

// ---------- 記録と一緒に保存するルート ----------
/** おすすめルート（女夫渕 ⇄ 手白澤温泉）の GPX。ルートを保存していない記録にも、このルートを付ける */
export const TESHIROSAWA_GPX = 'routes/okukinu-teshirosawa.gpx';

/**
 * 今のルートを、記録と一緒に保存する（記録を始めた・記録中にルートを変えたとき。ルートがなければ「ルートなし」と保存する。
 * 途中の記録を続けたときは resumeTrackRoute）
 */
export async function keepRouteWithTrack(trackId: string) {
  try {
    await putTrackRoute({ trackId, route: state.route ? routeSnapshot(state.route) : null });
  } catch (e) {
    console.warn('記録のルートを保存できませんでした', e);
  }
}

/**
 * 記録のルート。保存していなければ（この版より前の記録・読み込んだ記録）、いつも歩くルート（奥鬼怒の女夫渕 → 手白澤温泉）を付けて保存する
 */
async function routeOfTrack(t: Track): Promise<ActiveRoute | null> {
  const saved = await getTrackRoute(t.id).catch(() => null);
  if (saved) return saved.route;
  const res = await fetch(TESHIROSAWA_GPX);
  if (!res.ok) return null;
  const route = routeSnapshot({ ...(await buildGpxRoute(parseGpx(await res.text()), elevation)), name: '女夫渕 → 手白澤温泉' });
  await putTrackRoute({ trackId: t.id, route }).catch((e) => console.warn('記録のルートを保存できませんでした', e));
  return route;
}

/**
 * 開いた記録のルート（記録したときのルート）を、地図・行程・グラフの目盛り・リプレイに出す。今の計画は隠しておき、
 * 記録を閉じたら restorePlanRoute で戻す（端末に保存してある計画は変えない）。あとで別のルートを設定していても、ちぐはぐにならないように
 */
export async function showTrackRoute(t: Track) {
  const route = await routeOfTrack(t).catch((e) => {
    console.warn('記録のルートを読めませんでした', e);
    return null;
  });
  // 読んでいるあいだに閉じた・別の記録を開いた・記録を始めた
  if (state.shown?.track.id !== t.id || recorder.recording) return;
  // 記録の行程の地点名・グラフの目盛りは、あとで計画を変えても、このルートで出す
  state.shown = { ...state.shown, route };
  planBehind ??= { route: state.route, pending: state.pending };
  applyRoute(route, false);
}

/** ルートを使わずに記録するとき、計画を隠す（端末に保存してある計画は変えない）。記録を終えて閉じたら restorePlanRoute で戻す */
export function hidePlanRoute() {
  if (!state.route) return;
  planBehind ??= { route: state.route, pending: state.pending };
  applyRoute(null, false);
}

/** ルートを使わずに記録しているあいだ、隠している計画のルートの名前（なければ null） */
export const hiddenPlanName = () => (recorder.recording && planBehind?.route ? planBehind.route.name : null);

/** ルートを使わずに始めた記録で、隠している計画のルートを使う（記録と一緒に保存するルートも、このルートにする） */
export function useHiddenPlan() {
  restorePlanRoute();
  const track = recorder.recording ? recorder.state.track : null;
  if (track && state.route) void keepRouteWithTrack(track.id);
}

/**
 * 続けた記録のルート：記録と一緒にルートを保存していなければ（この版より前に始めた記録）、今のルートを保存する。
 * ルートを使わずに始めた記録（「ルートなし」と保存してある）なら、計画を隠す
 */
export async function resumeTrackRoute(trackId: string) {
  // 読めなければ何もしない（保存してある「ルートなし」を、今のルートで上書きしないように）
  const saved = await getTrackRoute(trackId).catch((e) => {
    console.warn('記録のルートを読めませんでした', e);
    return undefined;
  });
  if (saved === null) await keepRouteWithTrack(trackId);
  else if (saved && !saved.route && recorder.state.track?.id === trackId && recorder.recording) hidePlanRoute();
}

/** 記録を閉じたとき、隠していた計画に戻す */
export function restorePlanRoute() {
  const plan = planBehind;
  if (!plan) return;
  planBehind = null;
  applyRoute(plan.route, false);
  if (plan.pending.length) {
    state.pending = plan.pending;
    renderRoute();
  }
}

/** 設定の「ルートの探し方」に合う候補に切り替える（候補は作り直さない） */
export function applyRoutePref() {
  if (!state.route?.options) return;
  const i = preferredOption(state.route.options, settings.routePref);
  if (state.route.chosen === i) return;
  setRoute(chooseOption(state.route, i));
  const span = routeSpan(state.route);
  status(`「${state.route.label}」のルートに切り替えました：${formatDistance(span.to - span.from)}`);
}

/** ルートの線と出典（地図の層。地図を読み込む前は何もしないので、読み込んだら main.ts がもう一度呼ぶ） */
export function renderRouteLine() {
  src('route')?.setData(lineFC(state.route?.coords ?? []));
  if (map.getLayer('osm-credit')) map.setLayoutProperty('osm-credit', 'visibility', state.route?.source === 'osm' ? 'visible' : 'none');
}

export function renderRoute() {
  renderRouteLine();
  for (const m of markers) m.remove();
  const list: (PlanPoint | Mark)[] = state.route ? state.route.marks : state.pending;
  let viaNo = 0;
  markers = list.map((m) => {
    const el = h('div', `mk ${m.kind}`);
    el.dataset.id = m.id;
    const pin = m.kind === 'start' ? 'S' : m.kind === 'dest' ? 'G' : m.kind === 'pass' ? '' : String(++viaNo);
    el.append(h('div', 'pin', pin), h('div', 'tag', m.name));
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openSheet();
    });
    return new Marker({ element: el, anchor: 'top', offset: [0, m.kind === 'pass' ? -7 : -14] }).setLngLat(m.lngLat).addTo(map);
  });
  markPassed(state.lastNav);
  $<HTMLButtonElement>('btn-fit').disabled = !state.route;
}

/** 地点の印：歩いている途中なら、通り過ぎた地点は薄く、次に向かう地点は目立たせる */
export function markPassed(nav: Nav | null) {
  const walking = !!state.route && !!nav && (nav.onRoute || !!nav.rejoin);
  for (const mk of markers) {
    const el = mk.getElement();
    const row = walking ? nav.rows.find((r) => r.mark.id === el.dataset.id) : undefined;
    el.classList.toggle('passed', !!row?.passed);
    el.classList.toggle('next', walking && nav.next?.mark.id === el.dataset.id);
  }
}

export async function choosePoint(kind: PointKind, lngLat: LngLat, name?: string) {
  popup.remove();
  if (state.building) return;
  // 記録のルートを出しているあいだに地点を選んだら、隠していた計画に戻してから足す（記録のルートは変えない）
  restorePlanRoute();
  const pt = makePoint(kind, lngLat, name);
  if (state.route?.kind === 'gpx') {
    const placed = placeOnRoute(state.route, pt);
    if (placed) {
      setRoute(placed);
      status(`${pt.name}を${kind === 'dest' ? '目的地' : kind === 'start' ? '出発地' : '経由地'}にしました`);
      return;
    }
    if (!confirm('読み込んだルートから離れています。\n道に沿った新しいルートを作りますか？')) return;
    const start = state.route.marks.find((m) => m.kind === 'start');
    state.pending = start ? [{ id: start.id, kind: 'start', name: start.name, lngLat: start.lngLat }] : [];
    state.route = null;
  }
  let pts = state.route?.points ? [...state.route.points] : [...state.pending];
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
    if (state.route) setRoute(null);
    state.pending = pts;
    renderRoute();
    updateNav();
    status(
      pts.some((p) => p.kind === 'dest')
        ? '出発地を選んでください（地図をタップ →「出発地」）'
        : '目的地を選んでください（地図をタップ →「目的地」）',
    );
  }
}

/** 作っている途中のルート（止めるため）と、その地点の並び。新しく作り始めたら前のものは止める（あとから頼んだほうを作る） */
let building: { ctrl: AbortController; pts: PlanPoint[] } | null = null;

export async function rebuild(pts: PlanPoint[]) {
  building?.ctrl.abort();
  const mine = { ctrl: new AbortController(), pts };
  building = mine;
  state.building = true;
  try {
    const { failedTiles, ...r } = await buildRouteOptions(pts, elevation, settings.routePref, setProgress, mine.ctrl.signal);
    if (mine.ctrl.signal.aborted) return;
    state.progressMsg = '';
    setRoute(r, true);
    const span = routeSpan(r);
    if (r.straightLegs) status('道が見つからない区間は直線で結んでいます（到着予想は不正確です）', true);
    else if (failedTiles) status(`ルートを作成しました（${r.label}）：${formatDistance(span.to - span.from)}。道のデータの一部を読めませんでした（電波が弱いなど）`, true);
    else status(`ルートを作成しました（${r.label}）：${formatDistance(span.to - span.from)}`);
    openSheet();
  } catch (err) {
    // 止めたとき（新しく作り始めた・ルートを消した）は、何もしない
    if (mine.ctrl.signal.aborted) return;
    state.pending = pts;
    renderRoute();
    status(err instanceof Error ? err.message : 'ルートを作成できませんでした', true);
  } finally {
    if (building === mine) {
      building = null;
      state.building = false;
      setProgress('');
    }
  }
}

export async function removeMark(id: string) {
  if (!state.route) return;
  // 作り直している途中なら、その地点の並び（前に消した地点を除いたもの）から消す。前の削除が戻らないように
  const points = building?.pts ?? state.route.points;
  if (state.route.kind === 'auto' && points) await rebuild(points.filter((p) => p.id !== id));
  else setRoute({ ...state.route, marks: state.route.marks.filter((m) => m.id !== id) });
}

/** 今のルートを逆向き（帰り道）にする */
export function reverseCurrentRoute() {
  if (!state.route) return;
  setRoute(reverseRoute(state.route), true);
  const span = routeSpan(state.route);
  status(`逆向きにしました（${state.route.name}）：${formatDistance(span.to - span.from)}`);
}

export function clearRoute() {
  if (!confirm('ルートと目的地を消しますか？')) return;
  building?.ctrl.abort();
  setRoute(null);
}

export function exportRoute() {
  const r = state.route;
  if (!r) return;
  const gpx = toGpx(
    r.name,
    r.coords.map((c, i) => ({ lng: c[0], lat: c[1], ele: r.eles[i] ?? undefined })),
    r.marks.map((m) => ({ lng: m.lngLat[0], lat: m.lngLat[1], name: m.name })),
  );
  download(`${r.name.replace(/[\\/:*?"<>|\s→]+/g, '_')}.gpx`, gpx);
}

/** 読み込んだGPXの出発地・目的地の間で、道沿いのルート候補を探す */
export async function searchAlternativesForGpx() {
  if (!state.route) return;
  const start = state.route.marks.find((m) => m.kind === 'start');
  const dest = state.route.marks.find((m) => m.kind === 'dest');
  if (!start || !dest) return;
  await rebuild([makePoint('start', start.lngLat, start.name), makePoint('dest', dest.lngLat, dest.name)]);
}

export async function loadGpxText(text: string) {
  const r = await buildGpxRoute(parseGpx(text), elevation);
  setRoute(r, true);
  const span = routeSpan(r);
  status(`${r.name}：${formatDistance(span.to - span.from)}`);
}
