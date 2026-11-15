import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track, TrackPoint } from '../src/track/db';
import type { Fix } from '../src/track/location';

// 保存先と測位は差し替える（保存できる・できないを切り替え、測位はテストから渡す）
const db = vi.hoisted(() => ({
  fail: false,
  saved: [] as TrackPoint[],
  calls: 0,
}));
vi.mock('../src/track/db', () => ({
  appendPoints: async (_t: Track, points: TrackPoint[]) => {
    db.calls++;
    if (db.fail) throw new Error('QuotaExceededError');
    db.saved.push(...points);
  },
  putTrack: async () => {
    if (db.fail) throw new Error('QuotaExceededError');
  },
  getPoints: async () => [],
  updateElevations: async () => undefined,
}));
const loc = vi.hoisted(() => ({ onFix: null as ((f: Fix) => void) | null }));
vi.mock('../src/track/location', () => ({
  backgroundCapable: true,
  clearRecordedFixes: async () => undefined,
  currentPressure: async () => null,
  readRecordedFixes: async () => undefined,
  requestTrackingPermissions: async () => true,
  watchLocation: (onFix: (f: Fix) => void) => {
    loc.onFix = onFix;
    return { stop: async () => true };
  },
}));
vi.mock('../src/log', () => ({ log: () => undefined }));

const { TrackRecorder } = await import('../src/track/recorder');
type RecState = import('../src/track/recorder').RecorderState;

/** 北へ 20m ずつ進む測位 */
const fix = (i: number, more = false): Fix => ({
  lng: 139.4,
  lat: 36.85 + i * 0.00018,
  accuracy: 5,
  altitude: null,
  timestamp: 1_000_000 + i * 15_000,
  more,
});

/** 順番待ちの処理が終わるまで待つ */
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

describe('記録の保存', () => {
  let states: RecState[];
  let rec: InstanceType<typeof TrackRecorder>;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { addEventListener: () => undefined, visibilityState: 'visible' });
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.fail = false;
    db.saved = [];
    db.calls = 0;
    states = [];
    rec = new TrackRecorder({ elevation: async () => 500 } as never, (s) => states.push(s));
    await rec.start();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('ふだんの測位は1点ごとに保存する', async () => {
    loc.onFix!(fix(0));
    loc.onFix!(fix(1));
    await settle();
    expect(db.saved).toHaveLength(2);
    expect(rec.state.saveFailed).toBe(false);
  });

  it('まとめて取り込んでいる途中は「保存できていない」にしない。50点ごとに保存する', async () => {
    const seen: boolean[] = [];
    for (let i = 0; i < 120; i++) {
      loc.onFix!(fix(i, i < 119));
      // 取り込みの途中で画面を描き直したときに見える状態
      seen.push(rec.state.saveFailed);
      await settle();
      seen.push(rec.state.saveFailed);
    }
    expect(seen.every((x) => !x)).toBe(true);
    expect(db.saved).toHaveLength(120);
    // 50点・100点・最後の1点で3回
    expect(db.calls).toBe(3);
  });

  it('保存に失敗したら知らせ、点が増えなくても15秒ごとにやり直す', async () => {
    db.fail = true;
    loc.onFix!(fix(0));
    await settle();
    expect(rec.state.saveFailed).toBe(true);
    expect(states.at(-1)!.saveFailed).toBe(true);
    expect(db.saved).toHaveLength(0);
    // まだ保存できない
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rec.state.saveFailed).toBe(true);
    // 空きができたら、次のやり直しで保存できて警告が消える
    db.fail = false;
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(db.saved).toHaveLength(1);
    expect(rec.state.saveFailed).toBe(false);
    expect(states.at(-1)!.saveFailed).toBe(false);
  });
});
