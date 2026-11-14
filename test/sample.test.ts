import { describe, expect, it } from 'vitest';
import { cumulativeDistances, type LngLat } from '../src/geo';
import { RouteTimeline, analyzePace, paceSegments } from '../src/nav/eta';
import { paceColor } from '../src/ui/profile';
import { generateSampleTrack } from '../src/track/sample';

// 東西 6km、前半 3km で 300m 登って後半で下る経路
const coords: LngLat[] = Array.from({ length: 121 }, (_, i) => [139.4 + (i * 50) / 89_000, 36.87]);
const eles = coords.map((_, i) => 800 + 300 * (1 - Math.abs(i - 60) / 60));
const start = new Date('2026-11-13T08:30:00+09:00').getTime();
const { track, points } = generateSampleTrack(coords, eles, { startMs: start, name: 'サンプル', seed: 42 });

const gaps = points.slice(1).map((p, i) => (p.t - points[i].t) / 60_000);
const rests = gaps.filter((m) => m > 2);

describe('generateSampleTrack', () => {
  it('歩行は標準タイムどおり（区間のゆらぎは平均でならされる）', () => {
    const dists = cumulativeDistances(coords);
    const std = new RouteTimeline(dists, eles).between(0, dists[dists.length - 1]).total;
    const walking = gaps.filter((m) => m <= 2).reduce((a, b) => a + b, 0);
    expect(walking / std).toBeGreaterThan(0.95);
    expect(walking / std).toBeLessThan(1.05);
  });

  it('歩行30分ごとに5〜10分休む', () => {
    const walkingMin = gaps.filter((m) => m <= 2).reduce((a, b) => a + b, 0);
    expect(rests.length).toBe(Math.floor(walkingMin / 30));
    for (const m of rests) {
      expect(m).toBeGreaterThanOrEqual(5);
      expect(m).toBeLessThanOrEqual(10.1);
    }
  });

  it('記録としての集計と、ペースの分析で標準どおり・休憩ありと読める', () => {
    expect(track.status).toBe('done');
    expect(track.pointCount).toBe(points.length);
    expect(track.endedAt).toBe(points.at(-1)!.t);
    expect(track.distance).toBeGreaterThan(5900);
    expect(track.ascent).toBeGreaterThan(250);
    const pace = analyzePace(points, 'normal', track.endedAt);
    expect(pace.overall).toBeGreaterThan(0.85);
    expect(pace.overall).toBeLessThan(1.15);
    expect(pace.restMs / 60_000).toBeCloseTo(rests.reduce((a, b) => a + b, 0), -1);
  });

  it('同じ種なら同じ軌跡', () => {
    const again = generateSampleTrack(coords, eles, { startMs: start, name: 'サンプル', seed: 42 });
    expect(again.points).toEqual(points);
  });
});

describe('paceSegments', () => {
  const { segments, rests: found } = paceSegments(points);
  it('記録の全体を区間に分け、標準どおりなら比はおおむね1', () => {
    expect(segments[0].d0).toBe(0);
    expect(segments.at(-1)!.d1).toBeCloseTo(track.distance, 0);
    for (let i = 1; i < segments.length; i++) expect(segments[i].d0).toBe(segments[i - 1].d1);
    const mean = segments.reduce((a, s) => a + s.ratio, 0) / segments.length;
    expect(mean).toBeGreaterThan(0.85);
    expect(mean).toBeLessThan(1.15);
  });
  it('休憩を見つけ、その長さは実際の休憩とほぼ同じ', () => {
    expect(found.length).toBe(rests.length);
    found.forEach((r, i) => expect((r.t1 - r.t0) / 60_000).toBeCloseTo(rests[i], 0));
  });
});

describe('paceColor', () => {
  it('標準は灰色、速いと青、遅いと赤に寄る', () => {
    expect(paceColor(1)).toBe('rgba(168, 179, 191, 1)');
    expect(paceColor(0.5)).toBe('rgba(37, 99, 235, 1)');
    expect(paceColor(2)).toBe('rgba(214, 51, 74, 1)');
  });
});
