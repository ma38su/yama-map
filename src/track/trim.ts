/**
 * 記録の始めと終わり（記録の上の開始・終了の位置）。点は消さず、どこからどこまでを記録とみなすかの時刻だけを持つ。
 * 出発前・到着後にほとんど動いていなかった時間（駐車場で支度していた、山小屋に着いてからも記録し続けた）を除くのに使う。
 * 範囲を変えたら、距離・登り・下りを範囲の中の点で数え直して記録の概要に入れる（一覧などはそのまま使える）。DOM には触れない
 */
import { GainCounter, distance, type LngLat } from '../geo';
import type { Track, TrackPoint } from './db';

/** 記録の範囲 (ms)。start がなければ記録を始めたときから、end がなければ終えたときまで */
export interface TrimRange {
  start?: number;
  end?: number;
}

/** この半径の中にいるあいだは、止まっていたとみなす（測位のぶれを含めて） */
export const IDLE_RADIUS_M = 50;
/** これより短い止まり方は、除くことを勧めない */
export const MIN_IDLE_MS = 5 * 60_000;

const ll = (p: TrackPoint): LngLat => [p.lng, p.lat];

/** 範囲の中の点（範囲がなければ全部） */
export function pointsIn(points: TrackPoint[], trim?: TrimRange): TrackPoint[] {
  if (!trim || (trim.start == null && trim.end == null)) return points;
  const start = trim.start ?? -Infinity;
  const end = trim.end ?? Infinity;
  return points.filter((p) => p.t >= start && p.t <= end);
}

/** 点の歩数（記録を始めてからの歩数）の差から、点のあいだの歩数（歩数がなければ undefined） */
export function stepsBetween(points: TrackPoint[]): number | undefined {
  let first: number | undefined;
  let last: number | undefined;
  for (const p of points) {
    if (p.steps == null) continue;
    first ??= p.steps;
    last = p.steps;
  }
  return first != null && last != null ? Math.max(0, last - first) : undefined;
}

/** 点から、距離・登り・下り・歩数を数える（記録しているときと同じ数え方。歩数は歩数計があったときだけ） */
export function summarize(points: TrackPoint[]): { distance: number; ascent: number; descent: number; steps?: number } {
  const gain = new GainCounter();
  let dist = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) dist += distance(ll(points[i - 1]), ll(points[i]));
    gain.push(points[i].ele);
  }
  const steps = stepsBetween(points);
  return { distance: dist, ascent: gain.ascent, descent: gain.descent, ...(steps != null ? { steps } : {}) };
}

/** 記録の上の始めと終わりの時刻 */
export function trackTimes(t: Track): { start: number; end: number } {
  return { start: t.trim?.start ?? t.startedAt, end: t.trim?.end ?? t.endedAt ?? Date.now() };
}

/**
 * 記録に範囲を当てはめる。range が null・全部を含むなら範囲をなくす（元に戻す）。
 * 概要（距離・登り・下り）は範囲の中の点で数え直す。点の数（pointCount）は全部の数のまま
 */
export function applyTrim(track: Track, all: TrackPoint[], range: TrimRange | null): Track {
  const first = all[0]?.t ?? -Infinity;
  const last = all.at(-1)?.t ?? Infinity;
  const start = range?.start != null && range.start > first ? range.start : undefined;
  const end = range?.end != null && range.end < last ? range.end : undefined;
  const { trim: _old, steps: _steps, ...rest } = track;
  const trim = start != null || end != null ? { ...(start != null ? { start } : {}), ...(end != null ? { end } : {}) } : undefined;
  return { ...rest, ...summarize(pointsIn(all, trim)), ...(trim ? { trim } : {}) };
}

/** 地図に表示する記録：範囲の中の点（points）と、全部の点（all） */
export function shownOf(track: Track, all: TrackPoint[]): { track: Track; points: TrackPoint[]; all: TrackPoint[] } {
  return { track, points: pointsIn(all, track.trim), all };
}

/** 点 i にいた時間 (ms)：次の点までの時間（最後の点は前の点からの時間）。止まっていた点ほど大きい */
function dwell(points: TrackPoint[], i: number): number {
  const next = points[i + 1]?.t ?? points[i].t + (points[i].t - (points[i - 1]?.t ?? points[i].t));
  return Math.max(1000, next - points[i].t);
}

/**
 * 先頭（dir = 1）または末尾（dir = -1）から続いて、ある場所の半径 IDLE_RADIUS_M の中にいた点の番号の端。
 * 場所は端の点から始め、近くにいた点の真ん中（いた時間の重み付き。歩き出した点に引っぱられないように）に置き直して
 * もう一度数える（端の点が測位のぶれで外れていても拾えるように）
 */
function clusterEdge(points: TrackPoint[], dir: 1 | -1): number {
  const from = dir === 1 ? 0 : points.length - 1;
  let center = ll(points[from]);
  let edge = from;
  for (let pass = 0; pass < 2; pass++) {
    edge = from;
    while (edge + dir >= 0 && edge + dir < points.length && distance(center, ll(points[edge + dir])) <= IDLE_RADIUS_M) edge += dir;
    const [a, b] = dir === 1 ? [from, edge] : [edge, from];
    let lng = 0;
    let lat = 0;
    let sum = 0;
    for (let i = a; i <= b; i++) {
      const w = dwell(points, i);
      lng += points[i].lng * w;
      lat += points[i].lat * w;
      sum += w;
    }
    center = [lng / sum, lat / sum];
  }
  return edge;
}

export interface IdleSuggestion {
  /** 出発したころの点の番号（ここから記録にする）。出発前に止まっていなければ null */
  start: number | null;
  /** 出発前に止まっていた時間 (ms) */
  startIdleMs: number;
  /** 到着したころの点の番号（ここまで記録にする）。到着後に止まっていなければ null */
  end: number | null;
  /** 到着後に止まっていた時間 (ms) */
  endIdleMs: number;
}

/**
 * 出発前・到着後に、ほとんど動いていなかった時間を見つける（MIN_IDLE_MS 以上のときだけ）。
 * 出発は、出発地の近く（半径 IDLE_RADIUS_M）にいた最後の点。到着は、目的地の近くに入った最初の点。
 * 出発地と目的地が同じ（周回）でも、あいだで離れていれば別々に見つける。見つからなければ null
 */
export function detectIdle(points: TrackPoint[], startedAt: number, endedAt?: number): IdleSuggestion | null {
  if (points.length < 3) return null;
  const dep = clusterEdge(points, 1);
  const arr = clusterEdge(points, -1);
  if (dep >= arr) return null; // ずっと同じところにいた
  const startIdleMs = points[dep].t - Math.min(startedAt, points[0].t);
  const endIdleMs = Math.max(endedAt ?? 0, points[points.length - 1].t) - points[arr].t;
  const start = startIdleMs >= MIN_IDLE_MS ? dep : null;
  const end = endIdleMs >= MIN_IDLE_MS ? arr : null;
  return start == null && end == null ? null : { start, startIdleMs, end, endIdleMs };
}

/** 見つけた止まっていた時間を除く範囲 */
export function suggestedRange(points: TrackPoint[], s: IdleSuggestion): TrimRange {
  return {
    ...(s.start != null ? { start: points[s.start].t } : {}),
    ...(s.end != null ? { end: points[s.end].t } : {}),
  };
}
