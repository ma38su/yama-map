import { describe, expect, it } from 'vitest';
import { distance, lngLatToTile, tileCount, tileRange, type LngLat } from '../src/geo';
import { aroundPoint, corridorTiles, nearRoute, tileSizeM } from '../src/offline/corridor';
import { planCorridorTiles } from '../src/offline/download';

// 北東へ斜めに約 7km のルート（L 字の折れ曲がりあり）
const route: LngLat[] = [
  [139.40, 36.85],
  [139.43, 36.87],
  [139.43, 36.90],
];

describe('ルート沿いのタイル', () => {
  it('点の上下左右の範囲', () => {
    const [w, s, e, n] = aroundPoint([139.4, 36.85], 1000);
    expect(distance([139.4, s], [139.4, n])).toBeCloseTo(2000, -1);
    expect(distance([w, 36.85], [e, 36.85])).toBeCloseTo(2000, -1);
  });
  it('タイルの一辺', () => {
    expect(tileSizeM(36.85, 16)).toBeGreaterThan(450);
    expect(tileSizeM(36.85, 16)).toBeLessThan(520);
  });
  it('ルートの点はすべて覆い、囲む長方形全体よりずっと少ない', () => {
    const z = 16;
    const tiles = corridorTiles(route, 500, z);
    for (const [lng, lat] of route) {
      const t = lngLatToTile(lng, lat, z);
      expect(tiles.has(`${Math.floor(t.x)}/${Math.floor(t.y)}`)).toBe(true);
    }
    // 同じ幅だけ広げた、ルートを囲む長方形
    const [w, s] = aroundPoint([139.4, 36.85], 500);
    const [, , e, n] = aroundPoint([139.43, 36.9], 500);
    const box = tileCount(tileRange([w, s, e, n], z));
    expect(tiles.size).toBeLessThan(box * 0.6);
  });
  it('ルートの途中の点の両側も覆う', () => {
    const z = 16;
    const tiles = corridorTiles(route, 1000, z);
    // 1本目の区間の真ん中から、北西へ約 700m の点
    const mid: LngLat = [139.415, 36.86];
    const side: LngLat = [mid[0] - 0.0055, mid[1] + 0.0045];
    expect(distance(mid, side)).toBeLessThan(1000);
    const t = lngLatToTile(side[0], side[1], z);
    expect(tiles.has(`${Math.floor(t.x)}/${Math.floor(t.y)}`)).toBe(true);
  });
  it('幅を広げるとタイルが増える', () => {
    expect(corridorTiles(route, 2000, 15).size).toBeGreaterThan(corridorTiles(route, 500, 15).size);
  });
  it('レイヤーとズームごとの URL', () => {
    const urls = planCorridorTiles(route, 500, [{ template: 'https://t/{z}/{x}/{y}.png', minZoom: 14, maxZoom: 15 }]);
    expect(urls.length).toBe(corridorTiles(route, 500, 14).size + corridorTiles(route, 500, 15).size);
    expect(urls[0]).toMatch(/^https:\/\/t\/14\/\d+\/\d+\.png$/);
  });
  it('ルートの近くか', () => {
    expect(nearRoute(route, [139.4001, 36.8501], 100)).toBe(true);
    expect(nearRoute(route, [139.5, 36.8], 1000)).toBe(false);
  });
});
