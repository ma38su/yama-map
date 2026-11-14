import { describe, expect, it } from 'vitest';
import type { LngLat } from '../src/geo';
import type { Mark } from '../src/nav/plan';
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

  it('ルートの地点から離れていれば「出発地」「到着地」', () => {
    const far = actualRows(points, [mark('start', '別の登山口', 120), mark('dest', '別の下山口', 0)]);
    expect(far.filter((r) => r.kind !== 'rest').map((r) => r.name)).toEqual(['出発地', '到着地']);
  });
});
