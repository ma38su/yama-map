/**
 * 到着予想時刻の計算。
 *
 * 1. 標準の歩行時間（コースタイムに相当）を、経路の距離と勾配から求める。
 *    速度は Tobler のハイキング関数に係数をかけたもの（平地 約4km/h、急な登り・下りで遅くなる）。
 * 2. これまでの記録から「登り・平坦・下り」それぞれで標準の何倍かかっているか（ペース係数）を求める。
 *    記録が少ないうちは、設定したペース（ゆっくり/ふつう/速め）に寄せて推定する。
 * 3. 休憩: 記録の中の立ち止まり時間から「歩行1時間あたりの休憩」を求め、残りの行程に上乗せする。
 */
import { GainCounter, distance, type LngLat } from '../geo';

/** Tobler 関数への係数。日本の登山道・荷物ありの一般的なコースタイムに合わせた値 */
export const STD_FACTOR = 0.8;
/** 勾配の計算に使う区間長 (m)。短いと標高データの細かな凹凸で勾配が暴れる */
export const STEP_M = 50;
const UP = 0.06;
const DOWN = -0.06;

export type SlopeClass = 'up' | 'flat' | 'down';

/** 標準の歩行速度 (km/h)。slope = 標高差 / 水平距離 */
export function stdSpeedKmh(slope: number): number {
  return STD_FACTOR * 6 * Math.exp(-3.5 * Math.abs(slope + 0.05));
}

export function slopeClass(slope: number): SlopeClass {
  return slope > UP ? 'up' : slope < DOWN ? 'down' : 'flat';
}

/** 区間の標準時間（分） */
export function segmentStdMinutes(horizontalM: number, dEle: number): number {
  if (horizontalM <= 0) return 0;
  const slope = Math.max(-1, Math.min(1, dEle / horizontalM));
  const slopeDist = Math.hypot(horizontalM, dEle);
  return (slopeDist / 1000 / stdSpeedKmh(slope)) * 60;
}

/** null を前後の有効値で埋める（全部 null なら 0） */
export function fillElevations(eles: (number | null | undefined)[]): number[] {
  const out = new Array<number>(eles.length);
  let last: number | null = null;
  for (let i = 0; i < eles.length; i++) {
    const e = eles[i];
    if (e != null && !Number.isNaN(e)) last = e;
    out[i] = last ?? Number.NaN;
  }
  let next: number | null = null;
  for (let i = eles.length - 1; i >= 0; i--) {
    if (!Number.isNaN(out[i])) next = out[i];
    else out[i] = next ?? 0;
  }
  return out;
}

/** 単調増加の xs 上で ys を線形補間 */
export function interp(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = xs[hi] - xs[lo];
  const f = span > 0 ? (x - xs[lo]) / span : 0;
  return ys[lo] + (ys[hi] - ys[lo]) * f;
}

/**
 * 標高のならし（3点移動平均を2回）。50m 間隔の列に使うと約150〜200m幅の平滑化になる。
 * 道の線が急斜面に沿っていると、標高データを拾ったときに実際にはない凹凸が出るため。
 */
export function smoothSeries(v: ArrayLike<number>): Float64Array {
  let cur = Float64Array.from(v);
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float64Array(cur.length);
    for (let i = 0; i < cur.length; i++) {
      const a = cur[Math.max(0, i - 1)];
      const b = cur[i];
      const c = cur[Math.min(cur.length - 1, i + 1)];
      next[i] = i === 0 || i === cur.length - 1 ? b : (a + b + c) / 3;
    }
    cur = next;
  }
  return cur;
}

export interface Minutes {
  up: number;
  flat: number;
  down: number;
  total: number;
}

/** 経路に沿った標準時間の累積（勾配区分別）。任意の2地点間の標準時間を素早く求める */
export class RouteTimeline {
  private readonly d: Float64Array;
  /** ならした標高（d と同じ位置） */
  private readonly e: Float64Array;
  private readonly up: Float64Array;
  private readonly flat: Float64Array;
  private readonly down: Float64Array;
  readonly length: number;

  constructor(dists: number[], eles: (number | null)[]) {
    const filled = fillElevations(eles);
    const total = dists[dists.length - 1] ?? 0;
    const n = Math.max(1, Math.ceil(total / STEP_M));
    this.length = total;
    this.d = new Float64Array(n + 1);
    for (let k = 1; k <= n; k++) this.d[k] = Math.min(k * STEP_M, total);
    this.e = smoothSeries(Array.from(this.d, (s) => interp(dists, filled, s)));
    this.up = new Float64Array(n + 1);
    this.flat = new Float64Array(n + 1);
    this.down = new Float64Array(n + 1);
    for (let k = 1; k <= n; k++) {
      const h = this.d[k] - this.d[k - 1];
      const dh = this.e[k] - this.e[k - 1];
      const m = segmentStdMinutes(h, dh);
      const cls = h > 0 ? slopeClass(dh / h) : 'flat';
      this.up[k] = this.up[k - 1] + (cls === 'up' ? m : 0);
      this.flat[k] = this.flat[k - 1] + (cls === 'flat' ? m : 0);
      this.down[k] = this.down[k - 1] + (cls === 'down' ? m : 0);
    }
  }

  /** 距離 a〜b (m) の標準時間（分） */
  between(a: number, b: number): Minutes {
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(this.length, Math.max(a, b));
    const up = interp(this.d, this.up, hi) - interp(this.d, this.up, lo);
    const flat = interp(this.d, this.flat, hi) - interp(this.d, this.flat, lo);
    const down = interp(this.d, this.down, hi) - interp(this.d, this.down, lo);
    return { up, flat, down, total: up + flat + down };
  }

  /** 距離 a〜b (m) の累積標高（ならした標高から） */
  gain(a: number, b: number): { ascent: number; descent: number } {
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(this.length, Math.max(a, b));
    const g = new GainCounter(3);
    g.push(interp(this.d, this.e, lo));
    for (let k = 0; k < this.d.length; k++) if (this.d[k] > lo && this.d[k] < hi) g.push(this.e[k]);
    g.push(interp(this.d, this.e, hi));
    return { ascent: g.ascent, descent: g.descent };
  }
}

// ---------- これまでの記録からペースを求める ----------

export interface TrackSample {
  t: number;
  lng: number;
  lat: number;
  ele: number | null;
}

export interface PaceFactors {
  up: number;
  flat: number;
  down: number;
  /** 歩行1分あたりの休憩（分） */
  rest: number;
}

export interface PaceStats {
  factors: PaceFactors;
  /** 全体のペース係数（標準の何倍かかっているか。1未満なら速い） */
  overall: number;
  elapsedMs: number;
  movingMs: number;
  restMs: number;
  /** 最後に動いてからの時間 (ms)。休憩中かどうかの判定用 */
  stoppedForMs: number;
  distance: number;
  /** 歩行中の平均速度 (km/h) */
  movingKmh: number | null;
  /** 登りの速さ（1時間あたりの登高, m/h） */
  climbRate: number | null;
  /** 推定に使えた標準時間（分）。多いほど係数が信頼できる */
  evidenceMin: number;
}

/** ペース設定（記録が少ないときの事前値） */
export const PACE_PRESETS = {
  slow: { label: 'ゆっくり', factor: 1.25 },
  normal: { label: 'ふつう', factor: 1.0 },
  fast: { label: '速め', factor: 0.85 },
} as const;
export type PacePreset = keyof typeof PACE_PRESETS;

/** 事前の休憩見込み：歩行60分につき10分 */
export const PRIOR_REST_PER_MIN = 10 / 60;
const PRIOR_WEIGHT_MIN = 20; // 全体係数を事前値に寄せる強さ（標準時間の分数）
const CLASS_WEIGHT_MIN = 15; // 区分別係数を全体係数に寄せる強さ
const REST_PRIOR_MOVING_MIN = 60; // 休憩率を事前値に寄せる強さ（歩行時間の分数）
// 立ち止まりの判定：90秒以上かけて斜面沿いに 0.15m/s 未満しか進んでいない区間。
// 急な登りをゆっくり歩いている（0.2〜0.3m/s）のを休憩と誤判定しないよう、低めの値にしている
const STOP_SPEED = 0.15;
const STOP_MIN_GAP_S = 90;
const ASSUMED_WALK = 0.8; // m/s 立ち止まり区間の移動分の見積もり

export function defaultFactors(preset: PacePreset = 'normal'): PaceFactors {
  const f = PACE_PRESETS[preset].factor;
  return { up: f, flat: f, down: f, rest: PRIOR_REST_PER_MIN };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 記録の中の休憩（立ち止まり） */
export interface RestSpan {
  /** 記録の始点からの距離 (m) */
  d: number;
  /** 休憩の始まりと終わり (ms) */
  t0: number;
  t1: number;
}

/** 点ごとの累積距離 (m) と累積の歩行時間 (s)、休憩の区間 */
export function splitMoving(points: TrackSample[]): { cumD: Float64Array; cumMove: Float64Array; rests: RestSpan[] } {
  const cumD = new Float64Array(points.length);
  const cumMove = new Float64Array(points.length);
  const rests: RestSpan[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = distance([a.lng, a.lat], [b.lng, b.lat]);
    const d3 = a.ele != null && b.ele != null ? Math.hypot(d, b.ele - a.ele) : d;
    const dt = Math.max(0, (b.t - a.t) / 1000);
    let moving = dt;
    if (dt > STOP_MIN_GAP_S && d3 / dt < STOP_SPEED) {
      moving = Math.min(dt, d / ASSUMED_WALK);
      // 歩いた分は休憩の前に置く
      rests.push({ d: cumD[i - 1] + d, t0: a.t + moving * 1000, t1: b.t });
    }
    cumD[i] = cumD[i - 1] + d;
    cumMove[i] = cumMove[i - 1] + moving;
  }
  return { cumD, cumMove, rests };
}

/** 記録を区切った区間ごとのペース */
export interface PaceSegment {
  /** 区間の始まりと終わり：記録の始点からの距離 (m) */
  d0: number;
  d1: number;
  /** 区間の始まりと終わりの時刻 (ms)。途中の休憩を含む */
  t0: number;
  t1: number;
  /** 標準時間に対する実際の歩行時間の比（1 で標準どおり、大きいほど遅い） */
  ratio: number;
}

/**
 * 記録を一定の距離ごとに区切って、区間ごとのペース（標準時間の何倍で歩いたか）を求める。
 * 区間の長さは、全体を40区間ほどに分ける長さ（100m〜500m）。休憩は歩行時間に含めない。
 */
export function paceSegments(points: TrackSample[], segmentM?: number): { segments: PaceSegment[]; rests: RestSpan[] } {
  if (points.length < 2) return { segments: [], rests: [] };
  const { cumD, cumMove, rests } = splitMoving(points);
  const total = cumD[points.length - 1];
  const step = segmentM ?? Math.max(100, Math.min(500, Math.round(total / 40 / 50) * 50));
  const timeline = new RouteTimeline(Array.from(cumD), points.map((p) => p.ele));
  const times = points.map((p) => p.t);
  const segments: PaceSegment[] = [];
  for (let d0 = 0; d0 < total - 1; d0 += step) {
    const d1 = Math.min(total, d0 + step);
    // 端数の短い区間は前の区間にまとめる
    const end = total - d1 < step / 3 ? total : d1;
    const std = timeline.between(d0, end).total;
    const actual = (interp(cumD, cumMove, end) - interp(cumD, cumMove, d0)) / 60;
    segments.push({
      d0,
      d1: end,
      t0: interp(cumD, times, d0),
      t1: interp(cumD, times, end),
      ratio: std > 0.05 ? clamp(actual / std, 0.3, 4) : 1,
    });
    if (end === total) break;
  }
  return { segments, rests };
}

export function analyzePace(points: TrackSample[], preset: PacePreset = 'normal', now = Date.now()): PaceStats {
  const prior = PACE_PRESETS[preset].factor;
  const empty: PaceStats = {
    factors: defaultFactors(preset),
    overall: prior,
    elapsedMs: points.length ? Math.max(0, now - points[0].t) : 0,
    movingMs: 0,
    restMs: 0,
    stoppedForMs: points.length ? Math.max(0, now - points[points.length - 1].t) : 0,
    distance: 0,
    movingKmh: null,
    climbRate: null,
    evidenceMin: 0,
  };
  if (points.length < 2) return empty;

  // 1) 生の点列から歩行時間と休憩時間を分ける
  const { cumD, cumMove, rests } = splitMoving(points);
  let restS = rests.reduce((sum, r) => sum + (r.t1 - r.t0) / 1000, 0);
  const last = points[points.length - 1];
  const sinceLast = Math.max(0, (now - last.t) / 1000);
  // 最後の測位から3分以上動いていなければ今は休憩中。表示には含めるが、休憩率の推定には使わない
  const restDoneS = restS;
  if (sinceLast > 180) restS += sinceLast;
  const total = cumD[points.length - 1];
  const movingS = cumMove[points.length - 1];

  // 2) 50m ごとに区切り、勾配区分ごとに「実際の歩行時間 / 標準時間」を集計
  const eles = fillElevations(points.map((p) => p.ele));
  const A = { up: 0, flat: 0, down: 0 };
  const S = { up: 0, flat: 0, down: 0 };
  let climbM = 0;
  let climbMin = 0;
  const n = Math.ceil(total / STEP_M);
  const rs = new Float64Array(n + 1);
  for (let k = 1; k <= n; k++) rs[k] = Math.min(k * STEP_M, total);
  const re = smoothSeries(Array.from(rs, (s) => interp(cumD, eles, s)));
  const rt = Array.from(rs, (s) => interp(cumD, cumMove, s));
  for (let k = 1; k <= n; k++) {
    const h = rs[k] - rs[k - 1];
    if (h <= 1) continue;
    const dh = re[k] - re[k - 1];
    const cls = slopeClass(dh / h);
    const actual = (rt[k] - rt[k - 1]) / 60;
    A[cls] += actual;
    S[cls] += segmentStdMinutes(h, dh);
    if (cls === 'up') {
      climbM += dh;
      climbMin += actual;
    }
  }
  const sumA = A.up + A.flat + A.down;
  const sumS = S.up + S.flat + S.down;
  const overall = clamp((sumA + prior * PRIOR_WEIGHT_MIN) / (sumS + PRIOR_WEIGHT_MIN), 0.4, 3);
  const cls = (c: SlopeClass) => clamp((A[c] + overall * CLASS_WEIGHT_MIN) / (S[c] + CLASS_WEIGHT_MIN), 0.4, 3);
  const movingMin = movingS / 60;
  const rest = (restDoneS / 60 + PRIOR_REST_PER_MIN * REST_PRIOR_MOVING_MIN) / (movingMin + REST_PRIOR_MOVING_MIN);

  return {
    factors: { up: cls('up'), flat: cls('flat'), down: cls('down'), rest: clamp(rest, 0, 1) },
    overall,
    elapsedMs: Math.max(0, now - points[0].t),
    movingMs: movingS * 1000,
    restMs: restS * 1000,
    stoppedForMs: sinceLast * 1000,
    distance: total,
    movingKmh: movingS > 60 ? total / 1000 / (movingS / 3600) : null,
    climbRate: climbMin > 5 ? (climbM / climbMin) * 60 : null,
    evidenceMin: sumS,
  };
}

export interface LegEstimate {
  /** 標準時間（コースタイム相当, 分） */
  stdMin: number;
  /** あなたのペースでの歩行時間（分） */
  movingMin: number;
  /** 休憩の見込み（分） */
  restMin: number;
  totalMin: number;
}

export function estimate(timeline: RouteTimeline, fromM: number, toM: number, f: PaceFactors): LegEstimate {
  const m = timeline.between(fromM, toM);
  const movingMin = m.up * f.up + m.flat * f.flat + m.down * f.down;
  const restMin = movingMin * f.rest;
  return { stdMin: m.total, movingMin, restMin, totalMin: movingMin + restMin };
}

/** 道のない区間を平坦な直線とみなした見積もり（ルートから離れた場所からルートに戻るまで） */
export function estimateFlat(distanceM: number, f: PaceFactors): LegEstimate {
  const stdMin = segmentStdMinutes(distanceM, 0);
  const movingMin = stdMin * f.flat;
  const restMin = movingMin * f.rest;
  return { stdMin, movingMin, restMin, totalMin: movingMin + restMin };
}

/** 2つの見積もりを足す */
export function addEstimates(a: LegEstimate, b: LegEstimate): LegEstimate {
  return { stdMin: a.stdMin + b.stdMin, movingMin: a.movingMin + b.movingMin, restMin: a.restMin + b.restMin, totalMin: a.totalMin + b.totalMin };
}

/** 経路上の位置（経路の始点からの距離）と、経路からの離れ具合 */
export interface RoutePosition {
  along: number;
  offset: number;
  index: number;
}

/**
 * 点を経路上に投影する。往復ルートなどで近くを2回通る場合に飛ばないよう、
 * hint（前回の位置）付近で十分近い場所が見つかればそれを優先する。
 */
export function projectOnRoute(coords: LngLat[], dists: number[], p: LngLat, hint?: number): RoutePosition | null {
  if (coords.length < 2) return null;
  const kx = 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const ky = 110_574;
  const search = (lo: number, hi: number) => {
    let best: RoutePosition | null = null;
    for (let i = Math.max(1, lo); i <= Math.min(coords.length - 1, hi); i++) {
      const a = coords[i - 1];
      const b = coords[i];
      const ax = (a[0] - p[0]) * kx;
      const ay = (a[1] - p[1]) * ky;
      const bx = (b[0] - p[0]) * kx;
      const by = (b[1] - p[1]) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? clamp(-(ax * dx + ay * dy) / len2, 0, 1) : 0;
      const off = Math.hypot(ax + dx * t, ay + dy * t);
      if (!best || off < best.offset) {
        best = { along: dists[i - 1] + (dists[i] - dists[i - 1]) * t, offset: off, index: t < 0.5 ? i - 1 : i };
      }
    }
    return best;
  };
  if (hint != null) {
    // hint の前後 ±600m の範囲を先に探す
    let lo = 0;
    let hi = coords.length - 1;
    while (lo < coords.length - 1 && dists[lo] < hint - 600) lo++;
    while (hi > 0 && dists[hi] > hint + 600) hi--;
    const near = search(lo, hi);
    if (near && near.offset < 60) return near;
  }
  return search(1, coords.length - 1);
}
