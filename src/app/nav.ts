/** 到着予想：ルート上の位置・ペース・出発時刻から、各地点の到着予想を計算して画面に反映する */
import { distance } from '../geo';
import {
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
import { OFF_ROUTE } from '../nav/offRoute';
import { departureAt, routeSpan, type ActiveRoute, type Mark } from '../nav/plan';
import type { TrackPoint } from '../track/db';
import { sunTimes } from '../nav/sun';
import { settings } from '../settings';
import { lineFC, emptyFC, src } from './mapView';
import { hereLngLat, recorder, renderTrack, updateCurrentEle } from './recording';
import { renderBody, renderCard, sheet } from './sheetView';
import { whileVisible } from './scheduler';
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
  /** 到着予想の基準の時刻 (ms)：この時刻に今の位置（計画なら出発地）を出るとして数える */
  startAt: number;
  factors: ReturnType<typeof defaultFactors>;
  pace: PaceStats | null;
  rows: Row[];
  next: Row | null;
  dest: Row | null;
  sunset: number | null;
}

/** 記録の中で地点の近く（80m以内）を最初に通った時刻 */
function arrivalTime(m: Mark): number | null {
  for (const p of recorder.state.points) if (distance([p.lng, p.lat], m.lngLat) < 80) return p.t;
  return null;
}

/** 出発時刻 (ms)。記録中・時刻を指定していないときは今。今より6時間以上前の時刻は翌日 */
export function departureTime(): number {
  const now = Date.now();
  if (recorder.recording || !settings.departAt) return now;
  return departureAt(settings.departAt, now);
}

/**
 * 記録のペース分析（analyzePace）を覚えておく。点が増えたとき・設定が変わったときだけ計算し直す。
 * 記録中は経過時間が進むので15秒ごとにも計算し直す。finished なら最後の点の時刻で締める
 */
const paceMemo = new Map<string, PaceStats>();
export function paceOf(points: TrackPoint[], finished = false): PaceStats {
  const key = `${points[0]?.trackId}:${points.length}:${state.revision}:${settings.pace}:${finished ? 'end' : Math.floor(Date.now() / 15_000)}`;
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
  const startAt = onRoute || rejoining ? Date.now() : departureTime();
  const marks = r.marks.filter((m) => m.along >= span.from - 1 && m.along <= span.to + 1);
  const rows: Row[] = marks.map((m, i) => {
    const prev = i > 0 ? marks[i - 1].along : m.along;
    const g = tl.gain(prev, m.along);
    // ルートから離れているあいだは、戻る地点より手前の地点だけを通過済みにする（目的地に着いたことにはしない）
    const passed = onRoute ? m.along <= fromAlong + 30 : rejoining && m.kind !== 'dest' && m.along < fromAlong - 30;
    const ahead = passed ? null : estimate(tl, fromAlong, m.along, factors);
    const remain = ahead && rejoin ? addEstimates(rejoin, ahead) : ahead;
    return {
      mark: m,
      passed,
      time: remain ? startAt + remain.totalMin * 60_000 : arrivalTime(m),
      remainM: passed ? 0 : Math.max(0, m.along - fromAlong) + rejoinM,
      remain,
      leg: i > 0 ? { dist: m.along - prev, up: g.ascent, down: g.descent, est: estimate(tl, prev, m.along, factors) } : null,
    };
  });
  // 日没は出発する日のもの（翌朝の出発時刻を入れていれば翌日）
  const sun = sunTimes(new Date(startAt), r.coords[0][1], r.coords[0][0]);
  return {
    pos,
    onRoute,
    offRoute: !!pos && pos.offset >= OFF_ROUTE.OFF_M && pos.offset < 5000 && recorder.recording,
    rejoin,
    fromAlong,
    startAt,
    factors,
    pace,
    rows,
    next: rows.find((x) => !x.passed && x.mark.kind !== 'start') ?? null,
    dest: rows.at(-1) ?? null,
    sunset: sun.sunset?.getTime() ?? null,
  };
}

/** 歩き終えた部分のルート（灰色の線）として描いてあるもの。変わらなければ描き直さない（地図の描き直しが起きるため） */
let doneDrawn: { route: ActiveRoute | null; n: number } = { route: null, n: 0 };
function renderDone(nav: Nav | null) {
  const r = state.route;
  let n = 0;
  if (r && nav?.onRoute) while (n < r.coords.length && r.dists[n] <= nav.fromAlong) n++;
  if (r === doneDrawn.route && n === doneDrawn.n) return;
  const source = src('route-done');
  if (!source) return; // 地図の読み込み前
  source.setData(r && n ? lineFC(r.coords.slice(0, n)) : emptyFC);
  doneDrawn = { route: r, n };
}

let arrivedNotified = false;
export function updateNav() {
  const nav = computeNav();
  state.lastNav = nav;
  // 到着のお知らせは記録中だけ（目的地の近くで計画を見ているだけのときは出さない）
  const arrived = recorder.recording && !!nav?.dest?.passed;
  if (arrived && !arrivedNotified) status(`${nav!.dest!.mark.name}に到着しました。おつかれさまでした！`);
  arrivedNotified = arrived;
  renderDone(nav);
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
// 表のときは30秒ごと、裏から戻ったらすぐ、たまった分を処理する
whileVisible(REFRESH_MS, () => void refreshNow());
// ルートなしで記録中は経過時間を毎秒更新
whileVisible(1000, () => recorder.recording && !state.route && renderCard(state.lastNav));

export const isLate = (row: Row, sunset: number | null) => !row.passed && !!sunset && !!row.time && row.time > sunset - 30 * 60_000;
