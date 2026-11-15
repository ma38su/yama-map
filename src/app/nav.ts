/** 到着予想：ルート上の位置・ペース・出発時刻から、各地点の到着予想を計算して画面に反映する */
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
import type { Track, TrackPoint } from '../track/db';
import { summarize } from '../track/trim';
import { sunTimes } from '../nav/sun';
import { settings } from '../settings';
import { lineFC, emptyFC, src } from './mapView';
import { hereLngLat, recorder, renderTrack, updateCurrentEle } from './recording';
import { pocketActive } from './pocket';
import { markPassed } from './route';
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

/** ルートからこれ以上離れていたら、ルートの上にいないとみなす (m) */
const ON_ROUTE_M = 300;
/** 地点のこれだけ手前まで来たら、通ったとみなす (m) */
const PASSED_M = 30;

/**
 * 記録の点ごとの「ルートのどこまで進んだか」（ルートに当てはめた位置の、それまでで一番先。ルートから離れた点は数えない）。
 * 前の点の位置を手がかりに当てはめるので、周回・往復のルートでも出発地と目的地を取り違えない。点は増えるだけなので、増えた分だけ当てはめる
 */
let reach: { route: ActiveRoute | null; key: string; along: number[]; hint: number | undefined } = { route: null, key: '', along: [], hint: undefined };
function reachedAlong(r: ActiveRoute, from: number, pts: TrackPoint[]): number[] {
  const key = `${pts[0]?.trackId}:${state.revision}`;
  if (reach.route !== r || reach.key !== key || reach.along.length > pts.length) reach = { route: r, key, along: [], hint: from };
  let max = reach.along.at(-1) ?? -Infinity;
  for (let i = reach.along.length; i < pts.length; i++) {
    const pos = projectOnRoute(r.coords, r.dists, [pts[i].lng, pts[i].lat], reach.hint);
    if (pos && pos.offset < ON_ROUTE_M) {
      reach.hint = pos.along;
      max = Math.max(max, pos.along);
    }
    reach.along.push(max);
  }
  return reach.along;
}

/** 地点に着いた時刻：記録で、地点の手前 PASSED_M まで最初に進んだ点の時刻（通過の判定と同じ）。まだなら null */
function arrivalTime(m: Mark, pts: TrackPoint[], reached: number[]): number | null {
  let lo = 0;
  let hi = reached.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (reached[mid] >= m.along - PASSED_M) hi = mid;
    else lo = mid + 1;
  }
  return lo < reached.length ? pts[lo].t : null;
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
  const onRoute = !planning && !!pos && pos.offset < ON_ROUTE_M && pos.along >= span.from - 100 && pos.along <= span.to + 100;
  // recorder.state は呼ぶたびに作り直すので1回だけ
  const points = recorder.state.points;
  const pace = recorder.recording ? paceOf(points) : null;
  const factors = pace?.factors ?? defaultFactors(settings.pace);
  // 記録中にルートから離れたら、いちばん近いルート上の地点に戻ってから先を歩くとみなす
  // （戻るまでは平坦な直線として見積もる）。遠すぎるときは出発地から数える
  const rejoining = !onRoute && recorder.recording && !!pos && pos.offset < 5000;
  const fromAlong = (onRoute || rejoining) && pos ? Math.min(span.to, Math.max(span.from, pos.along)) : span.from;
  const rejoinM = rejoining && pos ? pos.offset + Math.abs(pos.along - fromAlong) : 0;
  const rejoin = rejoining ? { ...estimateFlat(rejoinM, factors), distM: rejoinM } : null;
  const startAt = onRoute || rejoining ? Date.now() : departureTime();
  const marks = r.marks.filter((m) => m.along >= span.from - 1 && m.along <= span.to + 1);
  /** 記録の点ごとの、ルートのどこまで進んだか（通った地点の到着時刻を出すのに使う） */
  const reached = points.length ? reachedAlong(r, span.from, points) : [];
  const rows: Row[] = marks.map((m, i) => {
    const prev = i > 0 ? marks[i - 1].along : m.along;
    const g = tl.gain(prev, m.along);
    // ルートから離れているあいだは、戻る地点より手前の地点だけを通過済みにする（目的地に着いたことにはしない）
    const passed = onRoute ? m.along <= fromAlong + PASSED_M : rejoining && m.kind !== 'dest' && m.along < fromAlong - PASSED_M;
    const ahead = passed ? null : estimate(tl, fromAlong, m.along, factors);
    const remain = ahead && rejoin ? addEstimates(rejoin, ahead) : ahead;
    return {
      mark: m,
      passed,
      time: remain ? startAt + remain.totalMin * 60_000 : arrivalTime(m, points, reached),
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

/** 計画のリプレイの記録の id（保存しない。plan- で始まるので「予定」として扱われる） */
export const PLAN_REPLAY_ID = 'plan-replay';

/**
 * 計画のリプレイ用の記録：今のルートを、出発時刻から今のペース（休憩込み）の到着予想どおりに歩いたとする。
 * 保存はしない。記録中・ルートがなければ null
 */
export function planTrack(): { track: Track; points: TrackPoint[] } | null {
  const r = state.route;
  const tl = state.timeline;
  if (!r || !tl || recorder.recording) return null;
  const span = routeSpan(r);
  const factors = defaultFactors(settings.pace);
  const startAt = departureTime();
  const points: TrackPoint[] = [];
  r.coords.forEach(([lng, lat], i) => {
    const d = r.dists[i];
    if (d < span.from - 1 || d > span.to + 1) return;
    const min = d > span.from ? estimate(tl, span.from, d, factors).totalMin : 0;
    points.push({ trackId: PLAN_REPLAY_ID, t: startAt + min * 60_000, lng, lat, alt: null, acc: 0, ele: r.eles[i] ?? null });
  });
  if (points.length < 2) return null;
  const track: Track = {
    id: PLAN_REPLAY_ID,
    // 経路名は付けない（タイトルなどに「計画：」の付いた名前を出す）
    name: `計画：${r.name}`,
    startedAt: startAt,
    endedAt: points[points.length - 1].t,
    status: 'done',
    ...summarize(points),
    pointCount: points.length,
  };
  return { track, points };
}

/** 歩き終えた部分のルート（灰色の線）と、これからの部分（向きの印）として描いてあるもの。変わらなければ描き直さない（地図の描き直しが起きるため） */
let doneDrawn: { route: ActiveRoute | null; n: number } = { route: null, n: -1 };
function renderDone(nav: Nav | null) {
  const r = state.route;
  let n = 0;
  if (r && nav?.onRoute) while (n < r.coords.length && r.dists[n] <= nav.fromAlong) n++;
  if (r === doneDrawn.route && n === doneDrawn.n) return;
  const done = src('route-done');
  const ahead = src('route-ahead');
  if (!done || !ahead) return; // 地図の読み込み前
  done.setData(r && n ? lineFC(r.coords.slice(0, n)) : emptyFC);
  ahead.setData(r ? lineFC(r.coords.slice(Math.max(0, n - 1))) : emptyFC);
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
  // ポケット表示のあいだは地図とシートを隠しているので描かない（到着予想はポケット表示が使う）。戻ったら refreshNow で描く
  if (pocketActive()) return;
  renderDone(nav);
  // 地点の印（通過・次）は線と別に毎回合わせる（ルートに戻る途中は線が変わらなくても、印は変わるため。class を変えるだけで軽い）
  markPassed(nav);
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
// 表のときは30秒ごと、裏から戻ったらすぐ、たまった分を処理する（ルートなしで記録中の経過時間は、sheetView.ts が毎秒その数字だけ書き換える）
whileVisible(REFRESH_MS, () => void refreshNow());

export const isLate = (row: Row, sunset: number | null) => !row.passed && !!sunset && !!row.time && row.time > sunset - 30 * 60_000;
