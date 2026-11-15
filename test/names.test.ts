import { describe, expect, it } from 'vitest';
import type { LngLat } from '../src/geo';
import type { Track } from '../src/track/db';
import { guessRouteName, nearestName, routeNameOf, trackFullName, trackTitle, trackWhen, type NamedPlace } from '../src/track/names';

/** 北へ m メートル・東へ m メートル */
const at = (north: number, east = 0): LngLat => [139.4 + east / 89_000, 36.85 + north / 111_000];

const places: NamedPlace[] = [
  { lngLat: at(-120, 40), title: '女夫渕' },
  { lngLat: at(2950), title: '八丁の湯' },
  { lngLat: at(6020, 80), title: '手白澤温泉' },
  { lngLat: at(6400), title: '日光澤温泉' },
];

/** fromM から toM まで北・南へ（100m ごと） */
const line = (fromM: number, toM: number): LngLat[] => {
  const out: LngLat[] = [];
  const step = fromM < toM ? 100 : -100;
  for (let m = fromM; step > 0 ? m <= toM : m >= toM; m += step) out.push(at(m));
  return out;
};

/** 端末の時刻で（テストを動かす場所の時間帯によらないように） */
const local = (d: number, hh: number, mm: number) => new Date(2026, 10, d, hh, mm).getTime();

const track = (over: Partial<Track> = {}): Track => ({
  id: 'x',
  name: '2026/11/15 07:20 の記録',
  startedAt: local(15, 7, 20),
  endedAt: local(15, 9, 5),
  status: 'done',
  distance: 0,
  ascent: 0,
  descent: 0,
  pointCount: 0,
  ...over,
});

describe('記録の名前', () => {
  it('ルートの名前のうち、どこか分かるものだけを経路名にする', () => {
    expect(routeNameOf('女夫渕 → 手白澤温泉')).toBe('女夫渕 → 手白澤温泉');
    expect(routeNameOf('出発地 → 目的地')).toBeNull();
    expect(routeNameOf('ルート')).toBeNull();
    expect(routeNameOf('  ')).toBeNull();
    expect(routeNameOf(undefined)).toBeNull();
    // 片方だけ分かれば使う
    expect(routeNameOf('女夫渕 → 目的地')).toBe('女夫渕 → 目的地');
  });

  it('出発地・到着地の近くの場所の名前から経路名を付ける', () => {
    expect(nearestName(at(0), places)).toBe('女夫渕');
    expect(nearestName(at(1500), places)).toBeNull();
    expect(guessRouteName(line(0, 6000), places)).toBe('女夫渕 → 手白澤温泉');
    expect(guessRouteName(line(6000, 0), places)).toBe('手白澤温泉 → 女夫渕');
    // 往復は一番遠いところの名前もはさむ
    expect(guessRouteName([...line(0, 6400), ...line(6300, 0)], places)).toBe('女夫渕 → 日光澤温泉 → 女夫渕');
    // 遠いところに名前がなければ周回
    expect(guessRouteName([...line(0, 1500), ...line(1400, 0)], places)).toBe('女夫渕 周回');
    // 片方だけ
    expect(guessRouteName(line(0, 1500), places)).toBe('女夫渕から');
    expect(guessRouteName(line(1500, 6000), places)).toBe('手白澤温泉まで');
    expect(guessRouteName(line(1000, 2000), places)).toBeNull();
    expect(guessRouteName([], places)).toBeNull();
  });

  it('一覧に出す名前と日時', () => {
    expect(trackTitle(track())).toBe('2026/11/15 07:20 の記録');
    expect(trackTitle(track({ route: '女夫渕 → 手白澤温泉' }))).toBe('女夫渕 → 手白澤温泉');
    // 空の経路名は「経路名なし」
    expect(trackTitle(track({ route: '' }))).toBe('2026/11/15 07:20 の記録');
    expect(trackFullName(track({ route: '女夫渕 → 手白澤温泉' }))).toBe('女夫渕 → 手白澤温泉（2026/11/15 07:20 の記録）');
    expect(trackWhen(track())).toBe('2026/11/15(日) 7:20〜9:05');
    // 記録の範囲を変えていれば、その始めと終わり
    expect(trackWhen(track({ trim: { start: local(15, 7, 41) } }))).toBe('2026/11/15(日) 7:41〜9:05');
    // 日をまたぐ
    expect(trackWhen(track({ endedAt: local(16, 8, 10) }))).toBe('2026/11/15(日) 7:20〜11/16(月) 8:10');
    expect(trackWhen(track({ status: 'recording', endedAt: undefined }))).toBe('2026/11/15(日) 7:20〜');
  });
});
