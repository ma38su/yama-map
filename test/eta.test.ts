import { describe, expect, it } from 'vitest';
import { cumulativeDistances, type LngLat } from '../src/geo';
import {
  RouteTimeline,
  addEstimates,
  analyzePace,
  estimate,
  estimateFlat,
  fillElevations,
  interp,
  projectOnRoute,
  segmentStdMinutes,
  stdSpeedKmh,
  type PaceFactors,
  type TrackSample,
} from '../src/nav/eta';
import { sunTimes } from '../src/nav/sun';

describe('標準の歩行速度', () => {
  it('平地はおよそ 4km/h、登り・下りで遅くなり、緩い下りが最速', () => {
    expect(stdSpeedKmh(0)).toBeCloseTo(4.03, 1);
    expect(stdSpeedKmh(0.2)).toBeLessThan(stdSpeedKmh(0));
    expect(stdSpeedKmh(-0.3)).toBeLessThan(stdSpeedKmh(0));
    expect(stdSpeedKmh(-0.05)).toBeGreaterThan(stdSpeedKmh(0));
  });
  it('標高差300mの登り（水平1km）はおよそ45分', () => {
    const m = segmentStdMinutes(1000, 300);
    expect(m).toBeGreaterThan(38);
    expect(m).toBeLessThan(52);
  });
});

describe('補間', () => {
  it('fillElevations は null を前後で埋める', () => {
    expect(fillElevations([null, 10, null, 20, null])).toEqual([10, 10, 10, 20, 20]);
    expect(fillElevations([null, null])).toEqual([0, 0]);
  });
  it('interp', () => {
    expect(interp([0, 10, 20], [0, 100, 300], 15)).toBe(200);
    expect(interp([0, 10], [5, 6], -1)).toBe(5);
    expect(interp([0, 10], [5, 6], 99)).toBe(6);
  });
});

// 東西にまっすぐ 3km：前半 1.5km は 1000→1300m の登り、後半は平坦
const line: LngLat[] = Array.from({ length: 61 }, (_, i) => [139 + i * 0.000562, 36.8]);
const dists = cumulativeDistances(line);
const eles = dists.map((d) => (d < 1500 ? 1000 + (d / 1500) * 300 : 1300));

describe('RouteTimeline / estimate', () => {
  const tl = new RouteTimeline(dists, eles);
  it('区間の標準時間を勾配区分別に持つ', () => {
    const all = tl.between(0, tl.length);
    expect(all.up).toBeGreaterThan(all.flat);
    expect(all.down).toBeCloseTo(0, 5);
    expect(tl.between(0, 1500).total + tl.between(1500, tl.length).total).toBeCloseTo(all.total, 6);
  });
  it('ペース係数と休憩を反映する', () => {
    const base = estimate(tl, 0, tl.length, { up: 1, flat: 1, down: 1, rest: 0 });
    const slowUp = estimate(tl, 0, tl.length, { up: 1.5, flat: 1, down: 1, rest: 0 });
    const withRest = estimate(tl, 0, tl.length, { up: 1, flat: 1, down: 1, rest: 1 / 6 });
    expect(slowUp.movingMin).toBeGreaterThan(base.movingMin);
    expect(withRest.totalMin).toBeCloseTo(base.movingMin * (7 / 6), 6);
    expect(base.stdMin).toBeCloseTo(base.movingMin, 6);
  });
});

/** line 上を一定速度で歩いた記録を作る。restAt(m) で休憩を入れる */
function walk(speedFlat: number, speedUp: number, restAtM?: number, restMin = 0): TrackSample[] {
  const pts: TrackSample[] = [];
  let t = Date.parse('2026-11-15T08:00:00+09:00');
  for (let i = 0; i < line.length; i++) {
    if (i > 0) {
      const d = dists[i] - dists[i - 1];
      t += (d / (dists[i] < 1500 ? speedUp : speedFlat)) * 1000;
      if (restAtM != null && dists[i - 1] < restAtM && dists[i] >= restAtM) t += restMin * 60_000;
    }
    pts.push({ t, lng: line[i][0], lat: line[i][1], ele: eles[i] });
  }
  return pts;
}

describe('analyzePace', () => {
  it('記録がなければ設定したペースのまま', () => {
    const p = analyzePace([], 'slow');
    expect(p.factors.up).toBe(1.25);
    expect(p.movingKmh).toBeNull();
  });
  it('登りが遅い人は登りの係数が大きくなる', () => {
    const pts = walk(1.1, 0.35);
    const p = analyzePace(pts, 'normal', pts[pts.length - 1].t);
    expect(p.factors.up).toBeGreaterThan(p.factors.flat);
    expect(p.climbRate).toBeGreaterThan(200);
    expect(p.climbRate).toBeLessThan(600);
  });
  it('休憩を検出して歩行時間と分ける', () => {
    const pts = walk(1.1, 0.6, 1500, 15);
    const p = analyzePace(pts, 'normal', pts[pts.length - 1].t);
    expect(p.restMs / 60_000).toBeGreaterThan(13);
    expect(p.restMs / 60_000).toBeLessThan(16);
    expect(p.movingMs + p.restMs).toBeCloseTo(p.elapsedMs, -3);
    // 休憩率は事前値(1/6)と実績(15分/歩行時間)の間
    expect(p.factors.rest).toBeGreaterThan(0.1);
  });
  it('最後の測位から長く動いていなければ休憩中', () => {
    const pts = walk(1.1, 0.6);
    const p = analyzePace(pts, 'normal', pts[pts.length - 1].t + 10 * 60_000);
    expect(p.stoppedForMs).toBe(10 * 60_000);
    expect(p.restMs).toBeGreaterThanOrEqual(10 * 60_000);
  });
});

describe('projectOnRoute', () => {
  it('経路上の距離と離れ具合', () => {
    const p = projectOnRoute(line, dists, [139.0112, 36.8009])!;
    expect(p.along).toBeGreaterThan(950);
    expect(p.along).toBeLessThan(1050);
    expect(p.offset).toBeGreaterThan(90);
    expect(p.offset).toBeLessThan(110);
  });
  it('往復ルートでは hint 付近を優先', () => {
    const outBack: LngLat[] = [...line, ...line.slice(0, -1).reverse()];
    const d = cumulativeDistances(outBack);
    const q: LngLat = [139.0112, 36.8];
    expect(projectOnRoute(outBack, d, q, 5000)!.along).toBeGreaterThan(4500);
    expect(projectOnRoute(outBack, d, q, 900)!.along).toBeLessThan(1500);
  });
});

describe('sunTimes', () => {
  it('東京 2026/11/14（基準値: astral で 6:15 / 16:35）と数分以内で一致', () => {
    const { sunrise, sunset } = sunTimes(new Date('2026-11-14T12:00:00+09:00'), 35.6812, 139.7671);
    const jst = (d: Date) => ((d.getUTCHours() + 9) % 24) * 60 + d.getUTCMinutes();
    expect(Math.abs(jst(sunset!) - (16 * 60 + 35))).toBeLessThanOrEqual(3);
    expect(Math.abs(jst(sunrise!) - (6 * 60 + 15))).toBeLessThanOrEqual(3);
  });
});

describe('立ち止まりの判定', () => {
  it('急な登りをゆっくり歩いている区間は休憩にしない', () => {
    // 水平10mで標高4m上がる区間を 0.2m/s（50秒）で歩き続ける。10分だけ本当に休む
    const pts: TrackSample[] = [];
    let t = 0;
    for (let i = 0; i < 60; i++) {
      if (i > 0) t += 50_000;
      if (i === 30) t += 10 * 60_000;
      pts.push({ t, lng: 139 + i * 0.000112, lat: 36.8, ele: 1000 + i * 4 });
    }
    const p = analyzePace(pts, 'normal', t);
    expect(p.restMs / 60_000).toBeGreaterThan(9);
    expect(p.restMs / 60_000).toBeLessThan(11);
    expect(p.factors.up).toBeGreaterThan(1.1);
  });
});

describe('estimateFlat / addEstimates', () => {
  it('ルートに戻るまでを平坦な直線として見積もる（平地 約3.9km/h）', () => {
    const f: PaceFactors = { up: 1, flat: 1, down: 1, rest: 0 };
    const e = estimateFlat(1000, f);
    expect(e.stdMin).toBeCloseTo(segmentStdMinutes(1000, 0));
    expect(e.totalMin).toBeGreaterThan(14);
    expect(e.totalMin).toBeLessThan(17);
  });
  it('ペース係数と休憩を反映し、足し合わせられる', () => {
    const f: PaceFactors = { up: 1, flat: 1.5, down: 1, rest: 0.2 };
    const e = estimateFlat(500, f);
    expect(e.movingMin).toBeCloseTo(segmentStdMinutes(500, 0) * 1.5);
    expect(e.totalMin).toBeCloseTo(e.movingMin * 1.2);
    const sum = addEstimates(e, e);
    expect(sum.totalMin).toBeCloseTo(e.totalMin * 2);
    expect(sum.restMin).toBeCloseTo(e.restMin * 2);
  });
});
