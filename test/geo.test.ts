import { describe, expect, it } from 'vitest';
import {
  arrowPolygon,
  bbox,
  bisect,
  bearing,
  cumulativeDistances,
  densify,
  distance,
  elevationGain,
  formatDistance,
  formatDuration,
  maskLocation,
  metersPerPixel,
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

describe('bisect', () => {
  const xs = [0, 10, 10, 20, 35];
  const at = (i: number) => xs[i];
  it('x 以下で一番後ろの番号（なければ -1）', () => {
    expect(bisect(xs.length, at, -1)).toBe(-1);
    expect(bisect(xs.length, at, 0)).toBe(0);
    expect(bisect(xs.length, at, 5)).toBe(0);
    expect(bisect(xs.length, at, 10)).toBe(2);
    expect(bisect(xs.length, at, 34.9)).toBe(3);
    expect(bisect(xs.length, at, 99)).toBe(4);
    expect(bisect(0, at, 1)).toBe(-1);
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

describe('maskLocation', () => {
  it('緯度経度・地図タイルの番号・問い合わせの座標を伏せる', () => {
    expect(maskLocation('現在地 36.87427, 139.40531 付近')).toBe('現在地 …, … 付近');
    expect(maskLocation('https://cyberjapandata.gsi.go.jp/xyz/std/16/58145/25538.png')).toBe('https://cyberjapandata.gsi.go.jp/xyz/std/z/x/y.png');
    expect(maskLocation('forecast?latitude=36.85,36.9&longitude=139.4&hourly=x')).toBe('forecast?latitude=…&longitude=…&hourly=x');
  });

  it('版の番号・時刻・標高は伏せない', () => {
    expect(maskLocation('WebView 133.0.6943.137')).toBe('WebView 133.0.6943.137');
    expect(maskLocation('08:47:20.933 標高 1543.6m 気圧 1013.25hPa')).toBe('08:47:20.933 標高 1543.6m 気圧 1013.25hPa');
  });
});

describe('向きと矢じり', () => {
  const c: [number, number] = [139.4, 36.85];
  it('方位：北・東・南西', () => {
    expect(bearing(c, [139.4, 36.86])).toBeCloseTo(0, 3);
    expect(bearing(c, [139.41, 36.85])).toBeCloseTo(90, 1);
    // 経度 0.01° は緯度 0.01° より短い（約 0.89 km と 1.11 km）ので、真南西（-135°）より南寄り
    expect(bearing(c, [139.39, 36.84])).toBeCloseTo(-141.3, 0);
  });
  it('1px の長さ：ズームが1上がると半分', () => {
    expect(metersPerPixel(36.85, 15)).toBeCloseTo(metersPerPixel(36.85, 14) / 2, 6);
    expect(metersPerPixel(0, 0)).toBeCloseTo(78271.5, 0);
  });
  it('矢じりは向いた方へ尖り、閉じた形', () => {
    const ring = arrowPolygon(c, 90, 10);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // 先端は中心から東へ 10m
    expect(distance(c, ring[0])).toBeCloseTo(10, 1);
    expect(bearing(c, ring[0])).toBeCloseTo(90, 0);
    // 後ろの角は西側
    expect(ring[1][0]).toBeLessThan(c[0]);
    expect(ring[3][0]).toBeLessThan(c[0]);
  });
});
