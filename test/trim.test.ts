import { describe, expect, it } from 'vitest';
import { distance } from '../src/geo';
import type { Track, TrackPoint } from '../src/track/db';
import { applyTrim, detectIdle, pointsIn, shownOf, suggestedRange, summarize, trackTimes } from '../src/track/trim';

const T0 = Date.parse('2026-11-15T07:00:00+09:00');
const MIN = 60_000;
/** 北へ m メートル */
const north = (m: number) => m / 111_000;

/** 出発地で20分（測位のぶれで数点）→ 北へ 2km を40分 → 目的地で2時間（ぶれで数点） */
function hike(): TrackPoint[] {
  const pts: TrackPoint[] = [];
  const add = (t: number, dy: number, dx = 0, ele = 1000 + dy / 10) =>
    pts.push({ trackId: 'x', t, lng: 139.4 + dx / 89_000, lat: 36.85 + north(dy), alt: null, acc: 5, ele });
  // 出発地：ぶれは 20m くらいまで
  add(T0, 0);
  add(T0 + 6 * MIN, 12, 5);
  add(T0 + 13 * MIN, -9, -10);
  add(T0 + 20 * MIN, 4);
  // 歩く：20m ごと、12秒ごと（40分で 2km）
  for (let i = 1; i <= 100; i++) add(T0 + 20 * MIN + i * 24_000, i * 20);
  // 目的地：ぶれで 30m ほど動く点が2時間のあいだにいくつか
  const at = T0 + 60 * MIN;
  add(at + 15 * MIN, 2000 + 25, 18);
  add(at + 50 * MIN, 2000 - 12, -22);
  add(at + 95 * MIN, 2000 + 30, 6);
  add(at + 120 * MIN, 2000 + 8, -15);
  return pts;
}

const track = (pts: TrackPoint[]): Track => ({
  id: 'x',
  name: 't',
  startedAt: T0 - 30_000,
  endedAt: pts.at(-1)!.t + 60_000,
  status: 'done',
  ...summarize(pts),
  pointCount: pts.length,
});

describe('記録の範囲', () => {
  it('出発前と到着後に止まっていた時間を見つける', () => {
    const pts = hike();
    const t = track(pts);
    const s = detectIdle(pts, t.startedAt, t.endedAt)!;
    // 出発は、出発地の近くにいた最後の点（07:20 のあと 20m・40m の点まで）
    expect(pts[s.start!].t).toBeGreaterThanOrEqual(T0 + 20 * MIN);
    expect(pts[s.start!].t).toBeLessThanOrEqual(T0 + 21 * MIN);
    expect(s.startIdleMs).toBeGreaterThan(19 * MIN);
    // 到着は、目的地の近くに入った最初の点（08:00 の少し前）
    expect(pts[s.end!].t).toBeGreaterThan(T0 + 58 * MIN);
    expect(pts[s.end!].t).toBeLessThanOrEqual(T0 + 60 * MIN);
    expect(s.endIdleMs).toBeGreaterThan(120 * MIN);
  });

  it('範囲を当てはめると、距離・登りは範囲の中で数え直し、時刻は範囲の端', () => {
    const pts = hike();
    const t = track(pts);
    const range = suggestedRange(pts, detectIdle(pts, t.startedAt, t.endedAt)!);
    const trimmed = applyTrim(t, pts, range);
    expect(trimmed.trim).toEqual(range);
    expect(trimmed.pointCount).toBe(pts.length);
    // ぶれの分（行ったり来たり）がなくなり、ほぼ歩いた 2km（端の 50m ほどは止まっていた側に入る）
    expect(t.distance).toBeGreaterThan(2150);
    expect(trimmed.distance).toBeGreaterThan(1850);
    expect(trimmed.distance).toBeLessThan(2000);
    const times = trackTimes(trimmed);
    expect(times.end - times.start).toBeLessThan(41 * MIN);
    // 表示する点は範囲の中だけ、全部の点も残す
    const shown = shownOf(trimmed, pts);
    expect(shown.points.length).toBeLessThan(pts.length);
    expect(shown.points[0].t).toBe(range.start);
    expect(shown.all).toBe(pts);
  });

  it('元に戻す・全部を含む範囲は範囲なし', () => {
    const pts = hike();
    const t = track(pts);
    const trimmed = applyTrim(t, pts, { start: pts[5].t, end: pts[50].t });
    expect(pointsIn(pts, trimmed.trim)).toHaveLength(46);
    const back = applyTrim(trimmed, pts, null);
    expect(back.trim).toBeUndefined();
    expect(back.distance).toBeCloseTo(t.distance, 6);
    expect(trackTimes(back)).toEqual({ start: t.startedAt, end: t.endedAt });
    expect(applyTrim(t, pts, { start: pts[0].t, end: pts.at(-1)!.t }).trim).toBeUndefined();
    // 終わりだけ変える
    const endOnly = applyTrim(t, pts, { end: pts[50].t });
    expect(endOnly.trim).toEqual({ end: pts[50].t });
    expect(trackTimes(endOnly).start).toBe(t.startedAt);
  });

  it('止まっていなければ・ずっと同じところにいたら、勧めない', () => {
    const walk = hike().slice(3, 104);
    expect(detectIdle(walk, walk[0].t, walk.at(-1)!.t)).toBeNull();
    const still = hike().slice(0, 4);
    expect(detectIdle(still, T0, T0 + 30 * MIN)).toBeNull();
  });

  it('周回（出発地に戻る）でも、出発前と到着後を別々に見つける', () => {
    const out = hike().slice(0, 54); // 出発地で20分 → 1km 歩く
    const back = out
      .slice(4)
      .reverse()
      .map((p, i) => ({ ...p, t: out.at(-1)!.t + (i + 1) * 24_000 }));
    const last = back.at(-1)!;
    const pts = [...out, ...back, { ...last, t: last.t + 30 * MIN }];
    const s = detectIdle(pts, T0, last.t + 30 * MIN)!;
    expect(s.start).not.toBeNull();
    expect(s.end).not.toBeNull();
    expect(s.end!).toBeGreaterThan(s.start!);
    expect(distance([pts[s.start!].lng, pts[s.start!].lat], [pts[s.end!].lng, pts[s.end!].lat])).toBeLessThan(100);
  });
});
