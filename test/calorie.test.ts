import { describe, expect, it } from 'vitest';
import { BODY_KG, PACK_KG, fmtKcal, hikingKcal, walkingKcal } from '../src/nav/calorie';

describe('hikingKcal', () => {
  it('コース定数に体重と荷物の重さをかける', () => {
    // 歩行2時間21分・5.99km・登り518m・下り159m → コース定数 約11.30
    const k = hikingKcal(141, 5990, 518, 159);
    expect(k / (BODY_KG + PACK_KG)).toBeCloseTo(1.8 * 2.35 + 0.3 * 5.99 + 10 * 0.518 + 0.6 * 0.159, 6);
    expect(Math.round(k)).toBe(904);
  });

  it('歩いていなければ 0', () => {
    expect(hikingKcal(0, 0, 0, 0)).toBe(0);
  });

  it('登りは下りより重く数える', () => {
    expect(hikingKcal(60, 3000, 300, 0)).toBeGreaterThan(hikingKcal(60, 3000, 0, 300));
  });
});

describe('walkingKcal', () => {
  it('記録の距離・登り下りから乗り物の分を除く', () => {
    const track = { distance: 37_000, ascent: 700, descent: 900 };
    const vehicle = { m: 33_000, ascent: 500, descent: 600 };
    expect(walkingKcal(90 * 60_000, track, vehicle)).toBeCloseTo(hikingKcal(90, 4000, 200, 300), 6);
  });

  it('乗り物がなければ記録のまま。引きすぎても負にしない', () => {
    const track = { distance: 5990, ascent: 518, descent: 159 };
    expect(walkingKcal(141 * 60_000, track, { m: 0, ascent: 0, descent: 0 })).toBeCloseTo(hikingKcal(141, 5990, 518, 159), 6);
    expect(walkingKcal(0, track, { m: 9000, ascent: 900, descent: 900 })).toBe(0);
  });
});

describe('fmtKcal', () => {
  it('10kcal 単位で丸め、千の位に区切りを入れる', () => {
    expect(fmtKcal(847.6)).toBe('約850kcal');
    expect(fmtKcal(1234)).toBe('約1,230kcal');
    expect(fmtKcal(4)).toBe('約0kcal');
  });
});
