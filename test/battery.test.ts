import { describe, expect, it } from 'vitest';
import { addBatterySample, batteryRemainingMs, type BatterySample } from '../src/nav/battery';

const MIN = 60_000;

/** 0分に start% を見て、そこから every 分ごとに1%ずつ減っていくのを、n 回見た記録 */
function drain(start: number, every: number, n: number): BatterySample[] {
  let s = addBatterySample([], start, false, 0);
  for (let i = 1; i <= n; i++) s = addBatterySample(s, start - i, false, i * every * MIN);
  return s;
}

describe('addBatterySample', () => {
  it('残りが変わったときだけ足し、最初の点は変わった時刻が分からない点にする', () => {
    let s = addBatterySample([], 80, false, 0);
    s = addBatterySample(s, 80, false, MIN);
    s = addBatterySample(s, 79, false, 2 * MIN);
    expect(s).toEqual([
      { t: 0, level: 80, changed: false },
      { t: 2 * MIN, level: 79, changed: true },
    ]);
  });

  it('同じ残りなら同じ配列を返す（保存し直さないため）', () => {
    const s = addBatterySample([], 80, false, 0);
    expect(addBatterySample(s, 80, false, MIN)).toBe(s);
    expect(addBatterySample([], 80, true, 0)).toEqual([]);
  });

  it('充電中・残りが増えたら最初からにする', () => {
    const s = drain(80, 5, 3);
    expect(addBatterySample(s, 77, true, 20 * MIN)).toEqual([]);
    expect(addBatterySample(s, 90, false, 20 * MIN)).toEqual([{ t: 20 * MIN, level: 90, changed: false }]);
  });
});

describe('batteryRemainingMs', () => {
  it('1%減るのにかかった時間 × 残りで見積もる', () => {
    // 6分ごとに1%：80% → 76%。今は76%になったばかり
    const s = drain(80, 6, 4);
    expect(batteryRemainingMs(s, 24 * MIN)).toBe(76 * 6 * MIN);
  });

  it('最初に見ただけの点は使わず、2%減るまでは分からない', () => {
    expect(batteryRemainingMs(drain(80, 6, 1), 6 * MIN)).toBeNull();
    expect(batteryRemainingMs(drain(80, 6, 2), 12 * MIN)).toBeNull();
    expect(batteryRemainingMs(drain(80, 6, 3), 18 * MIN)).toBe(77 * 6 * MIN);
  });

  it('今の残りになってから長くたっていれば、減り方がゆるくなったとみる', () => {
    // 6分ごとに減っていたが、76%になってから30分減らない
    const s = drain(80, 6, 4);
    const ms = batteryRemainingMs(s, 54 * MIN)!;
    expect(ms).toBeGreaterThan(76 * 6 * MIN);
    // 79%になってから今までの48分で、4段（減った3%と今の段）進んだとみる
    expect(ms).toBeCloseTo((76 * (54 - 6) * MIN) / 4, 0);
  });

  it('直近1時間で分かれば、それより前の減り方は使わない', () => {
    // はじめは20分ごと、あとの1時間は5分ごとに減った
    let s = drain(80, 20, 6); // 0〜120分で80% → 74%
    for (let i = 1; i <= 12; i++) s = addBatterySample(s, 74 - i, false, (120 + i * 5) * MIN);
    expect(batteryRemainingMs(s, 180 * MIN)).toBeCloseTo(62 * 5 * MIN, 0);
  });

  it('直近1時間で分からなければ、覚えている全部で見る', () => {
    // 40分ごとに1%：直近1時間では1%しか減っていない
    const s = drain(80, 40, 3);
    expect(batteryRemainingMs(s, 120 * MIN)).toBe(77 * 40 * MIN);
  });
});
