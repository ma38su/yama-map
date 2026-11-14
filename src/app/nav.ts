/** 到着予想：ルート上の位置・ペース・出発時刻から、各地点の到着予想を計算して画面に反映する */
import { distance, type LngLat } from '../geo';
import {
  RouteTimeline,
  addEstimates,
  analyzePace,
  defaultFactors,
  estimate,
  estimateFlat,
  projectOnRoute,
  type LegEstimate,
  type PaceStats,
  type RoutePosition,
} from '../nav/eta';
import { routeSpan, type Mark } from '../nav/plan';
import type { TrackPoint } from '../track/db';
import { sunTimes } from '../nav/sun';
import { settings } from '../settings';
import { lineFC, emptyFC, src } from './mapView';
import { hereLngLat, recorder, renderTrack, updateCurrentEle } from './recording';
import { renderBody, renderCard, sheet } from './sheetView';
import { state } from './state';
import { renderStatus, status } from './status';

// ---------- 到着予想 ----------
export interface Row {
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
export interface Nav {
  pos: RoutePosition | null;
  onRoute: boolean;
  offRoute: boolean;
  /** 記録中にルートから離れているとき、いちばん近いルート上の地点（fromAlong）に戻るまでの見積もり */
  rejoin: (LegEstimate & { distM: number }) | null;
  fromAlong: number;
  factors: ReturnType<typeof defaultFactors>;
  pace: PaceStats | null;
  rows: Row[];
  next: Row | null;
  dest: Row | null;
  sunset: number | null;
}

function gainBetween(tl: RouteTimeline, a: number, b: number) {
  return tl.gain(a, b);
}

/** 記録の中で地点の近く（80m以内）を最初に通った時刻 */
function arrivalTime(m: Mark): number | null {
  for (const p of recorder.state.points) if (distance([p.lng, p.lat], m.lngLat) < 80) return p.t;
  return null;
}

/** 出発時刻 (ms)。記録中・時刻を指定していないときは今 */
export function departureTime(): number {
  const now = Date.now();
  if (recorder.recording || !settings.departAt) return now;
  const [hh, mm] = settings.departAt.split(':').map(Number);
  const d = new Date(now);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

/**
 * 記録のペース分析（analyzePace）を覚えておく。点が増えたとき・設定が変わったときだけ計算し直す。
 * 記録中は経過時間が進むので15秒ごとにも計算し直す。finished なら最後の点の時刻で締める
 */
const paceMemo = new Map<string, PaceStats>();
export function paceOf(points: TrackPoint[], finished = false): PaceStats {
  const key = `${points[0]?.trackId}:${points.length}:${settings.pace}:${finished ? 'end' : Math.floor(Date.now() / 15_000)}`;
  let p = paceMemo.get(key);
  if (!p) {
    p = analyzePace(points, settings.pace, finished && points.length ? points[points.length - 1].t : Date.now());
    if (paceMemo.size > 8) paceMemo.clear();
    paceMemo.set(key, p);
  }
  return p;
}

function computeNav(): Nav | null {
  const r = state.route;
  const tl = state.timeline;
  if (!r || !tl) return null;
  const span = routeSpan(r);
  const here = hereLngLat();
  const pos = here ? projectOnRoute(r.coords, r.dists, here, state.lastNav?.pos?.along) : null;
  // 出発時刻を指定しているあいだは計画の確認なので、現在地に関係なく出発地から数える
  const planning = !recorder.recording && !!settings.departAt;
  const onRoute = !planning && !!pos && pos.offset < 300 && pos.along >= span.from - 100 && pos.along <= span.to + 100;
  const pace = recorder.recording ? paceOf(recorder.state.points) : null;
  const factors = pace?.factors ?? defaultFactors(settings.pace);
  // 記録中にルートから離れたら、いちばん近いルート上の地点に戻ってから先を歩くとみなす
  // （戻るまでは平坦な直線として見積もる）。遠すぎるときは出発地から数える
  const rejoining = !onRoute && recorder.recording && !!pos && pos.offset < 5000;
  const fromAlong = (onRoute || rejoining) && pos ? Math.min(span.to, Math.max(span.from, pos.along)) : span.from;
  const rejoinM = rejoining && pos ? pos.offset + Math.abs(pos.along - fromAlong) : 0;
  const rejoin = rejoining ? { ...estimateFlat(rejoinM, factors), distM: rejoinM } : null;
  const now = onRoute || rejoining ? Date.now() : departureTime();
  const marks = r.marks.filter((m) => m.along >= span.from - 1 && m.along <= span.to + 1);
  const rows: Row[] = marks.map((m, i) => {
    const prev = i > 0 ? marks[i - 1].along : m.along;
    const g = gainBetween(tl, prev, m.along);
    // ルートから離れているあいだは、戻る地点より手前の地点だけを通過済みにする（目的地に着いたことにはしない）
    const passed = onRoute ? m.along <= fromAlong + 30 : rejoining && m.kind !== 'dest' && m.along < fromAlong - 30;
    const ahead = passed ? null : estimate(tl, fromAlong, m.along, factors);
    const remain = ahead && rejoin ? addEstimates(rejoin, ahead) : ahead;
    return {
      mark: m,
      passed,
      time: remain ? now + remain.totalMin * 60_000 : arrivalTime(m),
      remainM: passed ? 0 : Math.max(0, m.along - fromAlong) + rejoinM,
      remain,
      leg: i > 0 ? { dist: m.along - prev, up: g.ascent, down: g.descent, est: estimate(tl, prev, m.along, factors) } : null,
    };
  });
  const sun = sunTimes(new Date(), r.coords[0][1], r.coords[0][0]);
  return {
    pos,
    onRoute,
    offRoute: !!pos && pos.offset >= 150 && pos.offset < 5000 && recorder.recording,
    rejoin,
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
export function updateNav() {
  const nav = computeNav();
  state.lastNav = nav;
  if (nav?.dest?.passed && !arrivedNotified) {
    arrivedNotified = true;
    status(`${nav.dest.mark.name}に到着しました。おつかれさまでした！`);
  }
  if (!nav?.dest?.passed) arrivedNotified = false;
  // 歩き終えた部分のルートを灰色に
  if (state.route && nav?.onRoute) {
    const done: LngLat[] = [];
    for (let i = 0; i < state.route.coords.length && state.route.dists[i] <= nav.fromAlong; i++) done.push(state.route.coords[i]);
    src('route-done')?.setData(lineFC(done));
  } else src('route-done')?.setData(emptyFC);
  renderCard(nav);
  if (sheet.isOpen) renderBody(nav);
  renderStatus();
}
// ---------- 描き直しの間隔 ----------
/**
 * 測位などのデータは届いたら受け取って保存するだけにし、計算と描き直しは画面が表のときにまとめて行う。
 * 現在地の印は MapLibre が測位のたびに動かすので、ここが30秒ごとでも見た目は遅れない
 */
const REFRESH_MS = 30_000;
let trackStale = false;
/** 記録の点が増えたことを覚えておく（次にまとめて描き直す） */
export function markTrackStale() {
  trackStale = true;
}
/** たまっているデータを処理して、画面を今の状態に合わせる */
export async function refreshNow() {
  if (trackStale) {
    trackStale = false;
    renderTrack();
  }
  await updateCurrentEle();
  updateNav();
}
const visible = () => document.visibilityState === 'visible';
setInterval(() => visible() && void refreshNow(), REFRESH_MS);
// 裏から戻ったら、たまった分をすぐ処理する
document.addEventListener('visibilitychange', () => visible() && void refreshNow());
setInterval(() => {
  // ルートなしで記録中は経過時間を毎秒更新
  if (recorder.recording && !state.route && document.visibilityState === 'visible') renderCard(state.lastNav);
}, 1000);

export const isLate = (row: Row, sunset: number | null) => !row.passed && !!sunset && !!row.time && row.time > sunset - 30 * 60_000;
