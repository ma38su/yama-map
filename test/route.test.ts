import { describe, expect, it } from 'vitest';
import { cumulativeDistances, type LngLat } from '../src/geo';
import { insertVia, makePoint, normalizePoints, placeOnRoute, routeSpan, type ActiveRoute } from '../src/nav/plan';
import { clipLine } from '../src/route/roadTiles';
import { TrailGraph } from '../src/route/trailRouter';

// 1度 ≒ 経度 89km / 緯度 111km（北緯37度付近）。0.0001度 ≒ 9-11m
const P = (x: number, y: number): LngLat => [139 + x * 0.0001, 37 + y * 0.0001];
const len = (c: LngLat[]) => cumulativeDistances(c).at(-1)!;

describe('TrailGraph', () => {
  it('交差点を経由した最短経路を返す', () => {
    // 「工」の字：上の道(y=10)、下の道(y=0)、真ん中に縦の道(x=50)
    const g = new TrailGraph([
      { coords: [P(0, 10), P(50, 10), P(100, 10)] },
      { coords: [P(0, 0), P(50, 0), P(100, 0)] },
      { coords: [P(50, 0), P(50, 10)] },
    ]);
    const r = g.route(P(0, 0), P(100, 10))!;
    expect(r).not.toBeNull();
    // 0,0 → 50,0 → 50,10 → 100,10
    expect(len(r.coords)).toBeCloseTo(len([P(0, 0), P(50, 0), P(50, 10), P(100, 10)]), 0);
  });

  it('タイル境界で切れた線（端点がわずかにずれる）もつながる', () => {
    const g = new TrailGraph([
      { coords: [P(0, 0), P(50, 0)] },
      { coords: [[139 + 50 * 0.0001 + 0.000005, 37], P(100, 0)] }, // 約0.5mずれ
    ]);
    expect(g.route(P(0, 0), P(100, 0))).not.toBeNull();
  });

  it('線の途中に接する行き止まり（T字で頂点がない）もつながる', () => {
    const g = new TrailGraph([
      { coords: [P(0, 0), P(100, 0)] }, // 横の道（x=50 に頂点なし）
      { coords: [P(50, 0.2), P(50, 30)] }, // 縦の道の端が横の道の約2m手前
    ]);
    const r = g.route(P(0, 0), P(50, 30));
    expect(r).not.toBeNull();
    expect(len(r!.coords)).toBeLessThan(len([P(0, 0), P(50, 0), P(50, 30)]) + 10);
  });

  it('つながっていなければ null、遠すぎる点も null', () => {
    const g = new TrailGraph([{ coords: [P(0, 0), P(10, 0)] }, { coords: [P(0, 50), P(10, 50)] }]);
    expect(g.route(P(0, 0), P(10, 50))).toBeNull();
    expect(g.route(P(0, 0), P(0, 5000), 300)).toBeNull();
  });

  it('徒歩道を少しだけ優先する', () => {
    const g = new TrailGraph(
      [
        { coords: [P(-20, 0), P(0, 0)], trail: true },
        { coords: [P(100, 0), P(120, 0)], trail: true },
        { coords: [P(0, 0), P(100, 0)], trail: false },
        { coords: [P(0, 0), P(50, 3), P(100, 0)], trail: true },
      ],
      1.5,
      4,
      1.1,
    );
    const r = g.route(P(-20, 0), P(120, 0))!;
    expect(r.coords.some((c) => Math.abs(c[1] - (37 + 3 * 0.0001)) < 1e-9)).toBe(true);
  });
});

describe('clipLine', () => {
  it('タイル外（バッファ）を切り落とす', () => {
    const parts = clipLine(
      [
        { x: -100, y: 10 },
        { x: 100, y: 10 },
        { x: 5000, y: 10 },
      ],
      4096,
    );
    expect(parts).toHaveLength(1);
    expect(parts[0][0]).toEqual({ x: 0, y: 10 });
    expect(parts[0].at(-1)).toEqual({ x: 4096, y: 10 });
  });
  it('出て戻る線は2本に分かれる', () => {
    const parts = clipLine(
      [
        { x: 10, y: 10 },
        { x: 10, y: -50 },
        { x: 20, y: 10 },
      ],
      4096,
    );
    expect(parts).toHaveLength(2);
  });
});

describe('plan', () => {
  it('経由地は遠回りが最小の位置に入る', () => {
    const s = makePoint('start', P(0, 0));
    const d = makePoint('dest', P(100, 0));
    const v1 = makePoint('via', P(30, 1));
    const v2 = makePoint('via', P(70, 1));
    let pts = insertVia([s, d], v2);
    pts = insertVia(pts, v1);
    expect(pts.map((p) => p.id)).toEqual([s.id, v1.id, v2.id, d.id]);
    expect(normalizePoints([d, v1, s]).map((p) => p.kind)).toEqual(['start', 'via', 'dest']);
  });

  it('GPXルート上に目的地・経由地を投影し、離れすぎは拒否', () => {
    const coords = [P(0, 0), P(100, 0), P(200, 0)];
    const dists = cumulativeDistances(coords);
    const route: ActiveRoute = {
      name: 't',
      source: 'gpx',
      coords,
      eles: [0, 0, 0],
      dists,
      straightLegs: 0,
      marks: [
        { ...makePoint('start', coords[0]), along: 0 },
        { ...makePoint('dest', coords[2]), along: dists[2] },
      ],
    };
    const r2 = placeOnRoute(route, makePoint('dest', P(150, 1)))!;
    expect(r2.marks.filter((m) => m.kind === 'dest')).toHaveLength(1);
    expect(routeSpan(r2).to).toBeCloseTo(dists[2] * 0.75, -1);
    const r3 = placeOnRoute(r2, makePoint('via', P(50, 2)))!;
    expect(r3.marks.map((m) => m.kind)).toEqual(['start', 'via', 'dest']);
    expect(placeOnRoute(route, makePoint('via', P(50, 500)))).toBeNull();
  });
});
