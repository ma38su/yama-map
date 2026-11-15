import { describe, expect, it } from 'vitest';
import type { LngLat } from '../src/geo';
import type { Mark } from '../src/nav/plan';
import { splitMoving } from '../src/nav/eta';
import { actualRows } from '../src/track/actual';
import { generateSampleTrack } from '../src/track/sample';

const coords: LngLat[] = Array.from({ length: 121 }, (_, i) => [139.4 + (i * 50) / 89_000, 36.87]);
const eles = coords.map((_, i) => 800 + 300 * (1 - Math.abs(i - 60) / 60));
const start = new Date('2026-11-13T08:30:00+09:00').getTime();
const { track, points } = generateSampleTrack(coords, eles, { startMs: start, name: 'サンプル', seed: 42 });
const mark = (kind: Mark['kind'], name: string, i: number): Mark => ({ id: name, kind, name, lngLat: coords[i], along: i * 50 });
const marks = [mark('start', '登山口', 0), mark('pass', '山頂', 60), mark('dest', '下山口', 120)];

describe('actualRows', () => {
  const rows = actualRows(points, marks);
  const stops = rows.filter((r) => r.kind !== 'rest');

  it('出発・通った地点・到着を時刻順に並べる', () => {
    expect(stops.map((r) => r.name)).toEqual(['登山口', '山頂', '下山口']);
    expect(stops[0].t).toBe(start);
    expect(stops.at(-1)!.t).toBe(track.endedAt);
    for (let i = 1; i < rows.length; i++) expect(rows[i].t).toBeGreaterThanOrEqual(rows[i - 1].t);
  });

  it('区間の所要時間と休憩の合計が全体と合う', () => {
    const total = stops.reduce((s, r) => s + (r.leg?.ms ?? 0), 0);
    expect(total).toBe(track.endedAt! - start);
    const restRows = rows.filter((r) => r.kind === 'rest');
    expect(restRows.length).toBeGreaterThan(0);
    const restSum = stops.reduce((s, r) => s + (r.leg?.restMs ?? 0), 0);
    expect(restSum).toBeCloseTo(restRows.reduce((s, r) => s + r.restMs!, 0), -4);
    expect(stops[1].leg!.up).toBeGreaterThan(250);
  });

  it('区間ごとの休憩と途中の休憩の行は、休憩を区間ごとに全部見るやり方と同じ', () => {
    // 地点を細かく置いて区間を増やし、区間の境をまたぐ休憩も作る
    const many = [mark('start', '登山口', 0), ...[15, 30, 45, 60, 75, 90, 105].map((i) => mark('via', `地点${i}`, i)), mark('dest', '下山口', 120)];
    const got = actualRows(points, many);
    const { rests } = splitMoving(points);
    const stopsOf = got.filter((r) => r.kind !== 'rest');
    for (let k = 1; k < stopsOf.length; k++) {
      const t0 = points[stopsOf[k - 1].index].t;
      const t1 = points[stopsOf[k].index].t;
      const want = rests.reduce((sum, r) => sum + Math.max(0, Math.min(r.t1, t1) - Math.max(r.t0, t0)), 0);
      expect(stopsOf[k].leg!.restMs).toBe(want);
    }
    for (const r of got.filter((x) => x.kind === 'rest')) {
      let index = 0;
      while (index < points.length - 1 && points[index + 1].t <= r.t) index++;
      expect(r.index).toBe(index);
    }
  });

  it('ルートの地点から離れていれば「出発地」「到着地」', () => {
    const far = actualRows(points, [mark('start', '別の登山口', 120), mark('dest', '別の下山口', 0)]);
    expect(far.filter((r) => r.kind !== 'rest').map((r) => r.name)).toEqual(['出発地', '到着地']);
  });
});
