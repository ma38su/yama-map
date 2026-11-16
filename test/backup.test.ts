import { describe, expect, it } from 'vitest';
import { routeSnapshot, type ActiveRoute } from '../src/nav/plan';
import { backupHeader, parseBackupHeader, parseBackupLine, prepareTrack } from '../src/track/backup';
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

describe('parseBackupHeader', () => {
  it('書き出したファイルの1行目を読める', () => {
    expect(parseBackupHeader(JSON.stringify(backupHeader(123))).exportedAt).toBe(123);
  });

  it('版1（全体が1つの JSON）のファイルも読める', () => {
    const v1 = { app: 'yama-map', kind: 'tracks', version: 1, exportedAt: 1, entries: [{ track: track('a'), points: [point('a', 1000)] }] };
    expect(parseBackupHeader(JSON.stringify(v1)).entries).toHaveLength(1);
  });

  it('やまマップの記録のファイルでなければ例外', () => {
    expect(() => parseBackupHeader('not json')).toThrow('やまマップの記録のファイルではありません');
    expect(() => parseBackupHeader(JSON.stringify({ app: 'other' }))).toThrow('やまマップの記録のファイルではありません');
    expect(() => parseBackupHeader(JSON.stringify({ ...backupHeader(), version: 99 }))).toThrow('新しい版');
    expect(() => parseBackupHeader(JSON.stringify({ ...backupHeader(), version: 1 }))).toThrow('壊れています');
  });
});

describe('parseBackupLine', () => {
  it('記録の行と写真の行を見分ける', () => {
    expect('track' in parseBackupLine(JSON.stringify({ track: track('a'), points: [] }))).toBe(true);
    const photo = { id: 'p', trackId: 'a', t: 1, lng: 1, lat: 1, located: 'gps', image: 'data:', thumb: 'data:' };
    expect('photo' in parseBackupLine(JSON.stringify({ photo }))).toBe(true);
    expect(() => parseBackupLine(JSON.stringify({ x: 1 }))).toThrow('壊れています');
  });
});

describe('記録のルート', () => {
  const route = { name: '手白澤温泉 → 女夫渕', coords: [[139.39, 36.86], [139.43, 36.88]], dists: [0, 3000], eles: [1400, 1000], marks: [] };
  it('記録の行のルートを読む（ルートなしの印 null も）。線のないものは読まない', () => {
    const l = parseBackupLine(JSON.stringify({ track: track('a'), points: [], route }));
    expect('track' in l && l.route?.name).toBe('手白澤温泉 → 女夫渕');
    const none = parseBackupLine(JSON.stringify({ track: track('a'), points: [], route: null }));
    expect('track' in none && none.route).toBeNull();
    const broken = parseBackupLine(JSON.stringify({ track: track('a'), points: [], route: { name: 'x', coords: [[1, 2]] } }));
    expect('track' in broken && 'route' in broken).toBe(false);
    // ルートを持たない前の版のファイルは、route なし（あとで開いたときに、いつものルートを付ける）
    expect('route' in parseBackupLine(JSON.stringify({ track: track('a'), points: [] }))).toBe(false);
  });
  it('記録と一緒に保存する写しには、ルートの候補を入れない', () => {
    const full = { ...route, kind: 'auto', options: [route, route], chosen: 1 } as unknown as ActiveRoute;
    const snap = routeSnapshot(full);
    expect('options' in snap || 'chosen' in snap).toBe(false);
    expect(snap.coords).toBe(full.coords);
    expect(full.options).toHaveLength(2);
  });
});

describe('prepareTrack', () => {
  it('同じ記録は飛ばす', () => {
    expect(prepareTrack(track('a'), [point('a', 1000)], new Set(['a']))).toBeNull();
  });

  it('記録中のまま書き出された記録は最後の点の時刻で終えたことにし、点を時刻順・記録の id にそろえる', () => {
    const b = prepareTrack(track('b', 'recording'), [point('x', 3000), point('x', 2000)], new Set())!;
    expect(b.track.status).toBe('done');
    expect(b.track.endedAt).toBe(3000);
    expect(b.track.pointCount).toBe(2);
    expect(b.points.map((p) => [p.trackId, p.t])).toEqual([
      ['b', 2000],
      ['b', 3000],
    ]);
  });
});
