/**
 * 想定の記録。ルートを標準タイム（eta.ts の標準の歩行時間）の決まった倍率で歩き、
 * 歩行30分ごとに休んだ想定の軌跡を作る（最初から入っている「予定」の記録に使う）。
 * 実際の記録が手元になくても、記録の見え方（軌跡・標高グラフ・ペースの分析・リプレイ）を確かめられる。
 */
import { GainCounter, bisect, cumulativeDistances, distance, type LngLat } from '../geo';
import { RouteTimeline, fillElevations, interp } from '../nav/eta';
import type { Track, TrackPoint } from './db';

export interface SampleOptions {
  /** 歩き始めの時刻 (ms) */
  startMs: number;
  name: string;
  /** 記録の id（なければ sample-歩き始めの時刻） */
  id?: string;
  /** 乱数の種。同じ種なら同じ軌跡になる */
  seed?: number;
  /** 何分歩くごとに休むか */
  restEveryMin?: number;
  /** 1回の休憩の長さ（分）の範囲 */
  restMin?: [number, number];
  /** 標準タイムの何倍で歩くか（1 で標準どおり、ゆっくりなら 1.25） */
  pace?: number;
}

/** 記録する間隔 (m)。実際の記録も8m以上動いたときだけ点を足す */
const STEP_M = 10;
/** 歩く速さのゆらぎ（区間ごとに標準の何倍か）。平均は標準どおり */
const PACE_JITTER = 0.1;
const PACE_SPAN_M = 250;
/** GPS の位置のぶれ (m) */
const GPS_JITTER_M = 2.5;

/** 種つきの乱数（mulberry32） */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 経路上の距離 s (m) の地点（区間は二分探索で） */
function pointAt(coords: LngLat[], dists: number[], s: number): LngLat {
  const i = Math.max(1, Math.min(dists.length - 1, bisect(dists.length, (k) => dists[k], s) + 1));
  const span = dists[i] - dists[i - 1];
  const f = span > 0 ? Math.max(0, Math.min(1, (s - dists[i - 1]) / span)) : 0;
  const [a, b] = [coords[i - 1], coords[i]];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

export function generateSampleTrack(
  coords: LngLat[],
  eles: (number | null)[],
  opts: SampleOptions,
): { track: Track; points: TrackPoint[] } {
  const rand = random(opts.seed ?? 1);
  const restEvery = opts.restEveryMin ?? 30;
  const [restLo, restHi] = opts.restMin ?? [5, 10];
  const dists = cumulativeDistances(coords);
  const filled = fillElevations(eles);
  const timeline = new RouteTimeline(dists, eles);
  const total = dists[dists.length - 1];
  const id = opts.id ?? `sample-${opts.startMs}`;
  const mPerDegLat = 110_574;
  const mPerDegLng = 111_320 * Math.cos((coords[0][1] * Math.PI) / 180);

  const points: TrackPoint[] = [];
  const gain = new GainCounter();
  let t = opts.startMs;
  let walked = 0; // 前の休憩からの歩行時間（分）
  const basePace = opts.pace ?? 1;
  let pace = basePace;
  let distanceSum = 0;
  for (let s = 0, lastS = 0; ; lastS = s, s = Math.min(total, s + STEP_M)) {
    if (s > 0) {
      if (Math.floor(s / PACE_SPAN_M) !== Math.floor(lastS / PACE_SPAN_M)) pace = basePace * (1 + (rand() * 2 - 1) * PACE_JITTER);
      const min = timeline.between(lastS, s).total * pace;
      t += min * 60_000;
      walked += min;
      // 歩行30分ごとに休憩（ゴールの直前では休まない）
      if (walked >= restEvery && total - s > 300) {
        t += (restLo + rand() * (restHi - restLo)) * 60_000;
        walked = 0;
      }
    }
    const [lng, lat] = pointAt(coords, dists, s);
    const jitter = () => (rand() * 2 - 1) * GPS_JITTER_M;
    const p: TrackPoint = {
      trackId: id,
      t: Math.round(t),
      lng: lng + jitter() / mPerDegLng,
      lat: lat + jitter() / mPerDegLat,
      ele: Math.round(interp(dists, filled, s) * 10) / 10,
      alt: null,
      acc: Math.round(4 + rand() * 8),
    };
    p.alt = Math.round((p.ele! + (rand() * 2 - 1) * 6) * 10) / 10;
    const prev = points[points.length - 1];
    if (prev) distanceSum += distance([prev.lng, prev.lat], [p.lng, p.lat]);
    points.push(p);
    gain.push(p.ele);
    if (s >= total) break;
  }
  const track: Track = {
    id,
    name: opts.name,
    startedAt: opts.startMs,
    endedAt: points[points.length - 1].t,
    status: 'done',
    distance: distanceSum,
    ascent: gain.ascent,
    descent: gain.descent,
    pointCount: points.length,
  };
  return { track, points };
}
