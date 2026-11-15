import { describe, expect, it } from 'vitest';
import { cumulativeDistances, type LngLat } from '../src/geo';
import { departureAt, detectPassPoints, insertVia, makePoint, normalizePoints, placeOnRoute, preferredOption, reverseRoute, routeSpan, trailShare, type ActiveRoute, type RouteOption } from '../src/nav/plan';
import { clipLine, gsiKind, osmKind } from '../src/route/roadTiles';
import { PROFILES, TrailGraph, overlapRatio, type RouteLine } from '../src/route/trailRouter';

// 1度 ≒ 経度 89km / 緯度 111km（北緯37度付近）。0.0001度 ≒ 9-11m
const P = (x: number, y: number): LngLat => [139 + x * 0.0001, 37 + y * 0.0001];
const len = (c: LngLat[]) => cumulativeDistances(c).at(-1)!;
const T = (coords: LngLat[], kind: RouteLine['kind'] = 'trail'): RouteLine => ({ coords, kind });

describe('TrailGraph', () => {
  it('交差点を経由した最短経路を返す', () => {
    // 「工」の字：上の道(y=10)、下の道(y=0)、真ん中に縦の道(x=50)
    const g = new TrailGraph([
      T([P(0, 10), P(50, 10), P(100, 10)]),
      T([P(0, 0), P(50, 0), P(100, 0)]),
      T([P(50, 0), P(50, 10)]),
    ]);
    const r = g.route(P(0, 0), P(100, 10))!;
    expect(r).not.toBeNull();
    // 0,0 → 50,0 → 50,10 → 100,10
    expect(len(r.coords)).toBeCloseTo(len([P(0, 0), P(50, 0), P(50, 10), P(100, 10)]), 0);
  });

  it('タイル境界で切れた線（端点がわずかにずれる）もつながる', () => {
    const g = new TrailGraph([
      T([P(0, 0), P(50, 0)]),
      T([[139 + 50 * 0.0001 + 0.000005, 37], P(100, 0)]), // 約0.5mずれ
    ]);
    expect(g.route(P(0, 0), P(100, 0))).not.toBeNull();
  });

  it('線の途中に接する行き止まり（T字で頂点がない）もつながる', () => {
    const g = new TrailGraph([
      T([P(0, 0), P(100, 0)]), // 横の道（x=50 に頂点なし）
      T([P(50, 0.2), P(50, 30)]), // 縦の道の端が横の道の約2m手前
    ]);
    const r = g.route(P(0, 0), P(50, 30));
    expect(r).not.toBeNull();
    expect(len(r!.coords)).toBeLessThan(len([P(0, 0), P(50, 0), P(50, 30)]) + 10);
  });

  it('つながっていなければ null、遠すぎる点も null', () => {
    const g = new TrailGraph([T([P(0, 0), P(10, 0)]), T([P(0, 50), P(10, 50)])]);
    expect(g.route(P(0, 0), P(10, 50))).toBeNull();
    expect(g.route(P(0, 0), P(0, 5000), { maxSnap: 300 })).toBeNull();
  });

  // 林道（まっすぐ）と登山道（少し遠回り）の2本。登山道優先なら登山道、最短距離なら林道
  const fork = () =>
    new TrailGraph([
      T([P(-20, 0), P(0, 0)]),
      T([P(100, 0), P(120, 0)]),
      T([P(0, 0), P(100, 0)], 'track'),
      T([P(0, 0), P(50, 15), P(100, 0)], 'trail'),
    ]);
  const viaTrail = (c: LngLat[]) => c.some((p) => Math.abs(p[1] - (37 + 15 * 0.0001)) < 1e-9);

  it('登山道優先では林道より登山道を選び、距離の内訳を返す', () => {
    const r = fork().route(P(-20, 0), P(120, 0), { profile: PROFILES.walk })!;
    expect(viaTrail(r.coords)).toBe(true);
    expect(r.byKind.track).toBe(0);
    expect(r.byKind.trail).toBeCloseTo(r.length, 3);
  });

  it('最短距離では林道を選ぶ', () => {
    const r = fork().route(P(-20, 0), P(120, 0), { profile: PROFILES.short })!;
    expect(viaTrail(r.coords)).toBe(false);
    expect(r.byKind.track).toBeGreaterThan(800);
  });

  it('通った道にペナルティをかけると別ルートになる', () => {
    const g = fork();
    const a = g.route(P(-20, 0), P(120, 0), { profile: PROFILES.short })!;
    const penalty = new Map(a.edges.map((e) => [e, 4]));
    const b = g.route(P(-20, 0), P(120, 0), { profile: PROFILES.short, penalty })!;
    expect(viaTrail(b.coords)).toBe(true);
    expect(overlapRatio(a.coords, b.coords)).toBeLessThan(0.5);
    expect(overlapRatio(a.coords, a.coords)).toBeCloseTo(1, 5);
  });
});

describe('道の種類', () => {
  it('地理院：徒歩道・石段は登山道、幅3m未満は林道扱い、高速道路は除外', () => {
    expect(gsiKind({ vt_code: 2721, vt_rdctg: '市区町村道等', vt_rnkwidth: '3m未満' })).toBe('trail');
    expect(gsiKind({ vt_code: 2733 })).toBe('trail');
    expect(gsiKind({ vt_code: 2701, vt_rdctg: '市区町村道等', vt_rnkwidth: '3m未満' })).toBe('track');
    expect(gsiKind({ vt_code: 2701, vt_rdctg: '市区町村道等', vt_rnkwidth: '3m-5.5m未満' })).toBe('road');
    expect(gsiKind({ vt_code: 2701, vt_rdctg: '国道' })).toBe('major');
    expect(gsiKind({ vt_code: 2701, vt_rdctg: '高速自動車国道等', vt_motorway: 1 })).toBeNull();
  });
  it('OpenStreetMap：path は登山道、track は林道、高速道路は除外', () => {
    expect(osmKind({ class: 'path', subclass: 'path' })).toBe('trail');
    expect(osmKind({ class: 'path', subclass: 'steps' })).toBe('trail');
    expect(osmKind({ class: 'track' })).toBe('track');
    expect(osmKind({ class: 'minor' })).toBe('road');
    expect(osmKind({ class: 'tertiary' })).toBe('major');
    expect(osmKind({ class: 'motorway' })).toBeNull();
    expect(osmKind({ class: 'rail' })).toBeNull();
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
      label: 'GPX',
      kind: 'gpx',
      source: 'gpx',
      byKind: { trail: 0, track: 0, road: 0, major: 0 },
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

  it('逆向き（帰り道）：道の形・距離・地点の位置・候補・名前を入れ替える', () => {
    const coords = [P(0, 0), P(100, 0), P(300, 0)];
    const dists = cumulativeDistances(coords);
    const total = dists[2];
    const s = makePoint('start', coords[0], '女夫渕');
    const v = makePoint('via', coords[1], '八丁の湯');
    const d = makePoint('dest', coords[2], '手白澤温泉');
    const opt: RouteOption = {
      label: '登山道優先',
      source: 'gsi',
      byKind: { trail: total, track: 0, road: 0, major: 0 },
      coords,
      eles: [1000, 1100, 1400],
      dists,
      straightLegs: 0,
      marks: [
        { ...s, along: 0 },
        { ...v, along: dists[1] },
        { id: 'p', kind: 'pass', name: '加仁湯', lngLat: P(200, 0), along: dists[1] + 100 },
        { ...d, along: total },
      ],
    };
    const route: ActiveRoute = { ...opt, name: '女夫渕 → 手白澤温泉', kind: 'auto', points: [s, v, d], options: [opt], chosen: 0 };
    const back = reverseRoute(route);
    expect(back.name).toBe('手白澤温泉 → 女夫渕');
    expect(back.coords[0]).toEqual(coords[2]);
    expect(back.eles).toEqual([1400, 1100, 1000]);
    expect(back.dists[0]).toBe(0);
    expect(back.dists[2]).toBeCloseTo(total, 6);
    expect(back.marks.map((m) => [m.kind, m.name])).toEqual([
      ['start', '手白澤温泉'],
      ['pass', '加仁湯'],
      ['via', '八丁の湯'],
      ['dest', '女夫渕'],
    ]);
    expect(back.marks[1].along).toBeCloseTo(total - dists[1] - 100, 6);
    expect(routeSpan(back)).toEqual({ from: 0, to: total });
    expect(back.points!.map((p) => [p.kind, p.name])).toEqual([
      ['start', '手白澤温泉'],
      ['via', '八丁の湯'],
      ['dest', '女夫渕'],
    ]);
    expect(back.options![0].coords[0]).toEqual(coords[2]);
    // 元のルートは変えない・2回で元に戻る
    expect(route.coords[0]).toEqual(coords[0]);
    expect(reverseRoute(back).marks.map((m) => m.kind)).toEqual(['start', 'via', 'pass', 'dest']);
  });
});

describe('通過点・登山道の割合', () => {
  const coords = [P(0, 0), P(100, 0), P(200, 0)];
  const dists = cumulativeDistances(coords);
  it('ルート沿いの温泉・小屋などを通過点にし、川の名前や離れた地名・重複は除く', () => {
    const labels = [
      { text: '八丁の湯', lngLat: P(60, 2) },
      { text: '八丁の湯', lngLat: P(60, 2) },
      { text: 'カッタテ沢', lngLat: P(120, 1) },
      { text: '手白山', lngLat: P(150, 300) },
      { text: '加仁湯', lngLat: P(140, -3) },
      { text: '出発地の宿', lngLat: P(1, 0) },
    ];
    const marks = detectPassPoints(coords, dists, labels, [
      { along: 0, name: '女夫渕' },
      { along: dists[2], name: '手白澤温泉' },
    ]);
    expect(marks.map((m) => m.name).sort()).toEqual(['八丁の湯', '加仁湯']);
    expect(marks.every((m) => m.kind === 'pass')).toBe(true);
  });
  it('trailShare', () => {
    expect(trailShare({ byKind: { trail: 750, track: 250, road: 0, major: 0 } } as never)).toBeCloseTo(0.75);
    expect(trailShare({ byKind: { trail: 0, track: 0, road: 0, major: 0 } } as never)).toBeNull();
  });
});

describe('preferredOption', () => {
  const opt = (label: string, len: number, trail: number, sameAs: string[] = []) =>
    ({
      label,
      source: 'gsi',
      coords: [],
      eles: [],
      dists: [0, len],
      marks: [],
      byKind: { trail, track: 0, road: len - trail, major: 0 },
      straightLegs: 0,
      sameAs,
    }) as unknown as RouteOption;
  const opts = [opt('登山道優先', 6000, 5000), opt('林道・車道経由', 5000, 500), opt('最短距離', 4800, 2000)];

  it('既定（登山道優先）と最短距離で選ぶ候補が変わる', () => {
    expect(preferredOption(opts, 'trail')).toBe(0);
    expect(preferredOption(opts, 'short')).toBe(2);
  });
  it('同じ経路にまとめられた候補も名前で見つける', () => {
    const merged = [opt('登山道優先', 6000, 5000, ['最短距離']), opt('林道・車道経由', 5000, 500)];
    expect(preferredOption(merged, 'short')).toBe(0);
  });
});

describe('departureAt', () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 15, h, m).getTime();

  it('今日のその時刻にする', () => {
    expect(departureAt('09:30', at(7))).toBe(at(9, 30));
    // 少し前の時刻（出発したばかりの計画を見直すとき）は今日のまま
    expect(departureAt('06:00', at(7))).toBe(at(6));
  });

  it('今より6時間以上前の時刻は翌日（夜に翌朝の出発時刻を入れたとき）', () => {
    expect(departureAt('05:00', at(21))).toBe(new Date(2026, 10, 16, 5, 0).getTime());
    expect(departureAt('15:00', at(21))).toBe(at(15));
  });

  it('日付を選んだら、その日のその時刻（今との前後によらない）', () => {
    expect(departureAt('2026-11-20T05:30', at(21))).toBe(new Date(2026, 10, 20, 5, 30).getTime());
    expect(departureAt('2026-11-15T05:00', at(21))).toBe(at(5));
  });
});
