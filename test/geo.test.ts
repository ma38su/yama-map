import { describe, expect, it } from 'vitest';
import {
  bbox,
  cumulativeDistances,
  densify,
  distance,
  elevationGain,
  formatDistance,
  formatDuration,
  lngLatToTile,
  tileCount,
  tileRange,
  tileUrl,
  viewBounds,
} from '../src/geo';

describe('distance', () => {
  it('東京駅〜富士山頂 はおよそ 100km', () => {
    const d = distance([139.7671, 35.6812], [138.7274, 35.3606]);
    expect(d / 1000).toBeGreaterThan(98);
    expect(d / 1000).toBeLessThan(102);
  });
  it('同じ点は 0', () => {
    expect(distance([137.6, 36.3], [137.6, 36.3])).toBe(0);
  });
});

describe('タイル計算', () => {
  it('地理院の例と一致する（東京, z14 → 14552/6451）', () => {
    const t = lngLatToTile(139.755, 35.685, 14);
    expect(Math.floor(t.x)).toBe(14552);
    expect(Math.floor(t.y)).toBe(6451);
  });
  it('範囲のタイル数', () => {
    const r = tileRange([139.74, 35.65, 139.76, 35.67], 14);
    expect(r.minX).toBeLessThanOrEqual(r.maxX);
    expect(tileCount(r)).toBeGreaterThan(0);
    expect(tileCount(r)).toBeLessThan(10);
  });
  it('viewBounds は中心を含み、ズームで半分になる', () => {
    const b12 = viewBounds([137.65, 36.34], 12, 400, 800);
    const b13 = viewBounds([137.65, 36.34], 13, 400, 800);
    expect(b12[0]).toBeLessThan(137.65);
    expect(b12[2]).toBeGreaterThan(137.65);
    expect(b12[1]).toBeLessThan(36.34);
    expect(b12[3]).toBeGreaterThan(36.34);
    expect((b12[2] - b12[0]) / (b13[2] - b13[0])).toBeCloseTo(2, 5);
  });
});

describe('累積標高', () => {
  it('ノイズ（閾値未満の上下）は数えない', () => {
    const g = elevationGain([1000, 1002, 999, 1001, 1000, 1003]);
    expect(g.ascent).toBe(0);
    expect(g.descent).toBe(0);
  });
  it('登って下る', () => {
    const g = elevationGain([1000, 1010, 1050, 1100, 1080, 1020]);
    expect(g.ascent).toBe(100);
    expect(g.descent).toBe(80);
  });
  it('null は飛ばす', () => {
    expect(elevationGain([null, 500, null, 600]).ascent).toBe(100);
  });
});

describe('累積距離・表示', () => {
  it('cumulativeDistances は単調増加で先頭0', () => {
    const d = cumulativeDistances([
      [137.0, 36.0],
      [137.001, 36.0],
      [137.002, 36.001],
    ]);
    expect(d[0]).toBe(0);
    expect(d[1]).toBeGreaterThan(0);
    expect(d[2]).toBeGreaterThan(d[1]);
  });
  it('formatDistance / formatDuration', () => {
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(1234)).toBe('1.23 km');
    expect(formatDistance(12345)).toBe('12.3 km');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });
});

describe('densify', () => {
  it('間隔が maxStep 以下になり、元の点は残る', () => {
    const src: [number, number][] = [
      [137.0, 36.0],
      [137.01, 36.0],
      [137.01, 36.0001],
    ];
    const out = densify(src, 50);
    expect(out[0]).toEqual(src[0]);
    expect(out[out.length - 1]).toEqual(src[2]);
    expect(out).toContainEqual(src[1]);
    for (let i = 1; i < out.length; i++) {
      const d = cumulativeDistances([out[i - 1], out[i]])[1];
      expect(d).toBeLessThanOrEqual(50.001);
    }
    // 全長はほぼ変わらない
    const total = (c: [number, number][]) => cumulativeDistances(c).at(-1)!;
    expect(total(out)).toBeCloseTo(total(src), 3);
  });
});

describe('bbox', () => {
  it('座標を囲む範囲 (west, south, east, north)', () => {
    expect(bbox([[139.5, 36.9], [139.4, 37.1], [139.45, 36.8]])).toEqual([139.4, 36.8, 139.5, 37.1]);
  });

  it('引数の数の上限を超える点の数でも求められる', () => {
    const many = Array.from({ length: 300_000 }, (_, i): [number, number] => [139 + i * 1e-6, 36 + i * 1e-6]);
    const [w, s, e, n] = bbox(many);
    expect(w).toBe(139);
    expect(s).toBe(36);
    expect(e).toBeCloseTo(139.299999, 6);
    expect(n).toBeCloseTo(36.299999, 6);
  });
});

describe('tileUrl', () => {
  it('{z}/{x}/{y} を埋める', () => {
    expect(tileUrl('https://example.com/{z}/{x}/{y}.png', 14, 14567, 6400)).toBe('https://example.com/14/14567/6400.png');
  });
});
