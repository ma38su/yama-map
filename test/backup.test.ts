import { describe, expect, it } from 'vitest';
import { entriesToImport, makeBackup, parseBackup } from '../src/track/backup';
import type { Track, TrackPoint } from '../src/track/db';

const track = (id: string, status: Track['status'] = 'done'): Track => ({
  id,
  name: `記録 ${id}`,
  startedAt: 1000,
  endedAt: status === 'done' ? 5000 : undefined,
  status,
  distance: 100,
  ascent: 10,
  descent: 5,
  pointCount: 2,
});
const point = (trackId: string, t: number): TrackPoint => ({ trackId, t, lng: 139.4, lat: 36.8, alt: null, acc: 5, ele: 1200 });

describe('parseBackup', () => {
  it('書き出したファイルを読める', () => {
    const file = makeBackup([{ track: track('a'), points: [point('a', 1000), point('a', 2000)] }], 123);
    const back = parseBackup(JSON.stringify(file));
    expect(back.exportedAt).toBe(123);
    expect(back.entries[0].points).toHaveLength(2);
  });

  it('やまマップの記録のファイルでなければ例外', () => {
    expect(() => parseBackup('not json')).toThrow('やまマップの記録のファイルではありません');
    expect(() => parseBackup(JSON.stringify({ app: 'other', entries: [] }))).toThrow('やまマップの記録のファイルではありません');
    expect(() => parseBackup(JSON.stringify({ ...makeBackup([]), version: 99 }))).toThrow('新しい版');
    expect(() => parseBackup(JSON.stringify({ ...makeBackup([]), entries: [{ track: {} }] }))).toThrow('壊れています');
  });
});

describe('entriesToImport', () => {
  it('同じ記録は飛ばし、記録中のまま書き出された記録は最後の点の時刻で終えたことにする', () => {
    const file = makeBackup([
      { track: track('a'), points: [point('a', 1000)] },
      { track: track('b', 'recording'), points: [point('x', 3000), point('x', 2000)] },
    ]);
    const { entries, skipped } = entriesToImport(file, new Set(['a']));
    expect(skipped).toBe(1);
    expect(entries).toHaveLength(1);
    const [b] = entries;
    expect(b.track.status).toBe('done');
    expect(b.track.endedAt).toBe(3000);
    expect(b.track.pointCount).toBe(2);
    // 点は時刻順・記録の id に合わせる
    expect(b.points.map((p) => [p.trackId, p.t])).toEqual([
      ['b', 2000],
      ['b', 3000],
    ]);
  });
});
