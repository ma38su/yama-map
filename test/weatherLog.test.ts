import { describe, expect, it } from 'vitest';
import { parseBackupLine } from '../src/track/backup';
import type { TrackPoint } from '../src/track/db';
import { analysisUrl, cellKey, packWeather, type HourlyWeather } from '../src/nav/weather';
import {
  amedasUrls,
  nearestStation,
  parseAmedas,
  positionAt,
  rainClassOf,
  rainMm,
  rainRangeText,
  rainTimesToFetch,
  rasrfPastTimes,
  rasrfTileUrl,
  recordedWeather,
  sliceHourly,
  type AmedasTableEntry,
  type TrackWeather,
} from '../src/track/weatherLog';

const H = 3_600_000;
const MIN = 60_000;
/** 2026-11-15 07:00（日本時間） */
const T0 = Date.UTC(2026, 10, 14, 22, 0);
const here: [number, number] = [139.43, 36.88];

const hourly = (n: number, f: (i: number) => Partial<Record<keyof Omit<HourlyWeather, 't'>, number | null>>): HourlyWeather => {
  const rows = Array.from({ length: n }, (_, i) => f(i));
  const col = (k: keyof Omit<HourlyWeather, 't'>) => rows.map((r) => r[k] ?? null);
  return { t: rows.map((_, i) => T0 - 2 * H + i * H), pop: col('pop'), precip: col('precip'), code: col('code'), cloud: col('cloud'), temp: col('temp'), wind: col('wind'), dir: col('dir') };
};

describe('記録したときの天気（実際の天気）', () => {
  it('1時間ごとの天気から記録の時間（前後1時間）だけを切り出す', () => {
    const s = sliceHourly(hourly(12, (i) => ({ temp: i })), T0, T0 + 2 * H);
    expect(s.t[0]).toBe(T0 - H);
    expect(s.temp).toEqual([1, 2, 3, 4, 5]);
  });

  it('記録の時刻の位置（前後の点のあいだ）', () => {
    const pts = [
      { t: T0, lng: 139.4, lat: 36.8 },
      { t: T0 + 10 * MIN, lng: 139.5, lat: 36.9 },
    ] as TrackPoint[];
    expect(positionAt(pts, T0 - H)).toEqual([139.4, 36.8]);
    const mid = positionAt(pts, T0 + 5 * MIN)!;
    expect(mid[0]).toBeCloseTo(139.45, 6);
    expect(mid[1]).toBeCloseTo(36.85, 6);
    expect(positionAt(pts, T0 + H)).toEqual([139.5, 36.9]);
    expect(positionAt([], T0)).toBeNull();
  });

  it('解析雨量の色から階級を読む', () => {
    expect(rainClassOf(0, 0, 0, 0)).toBe(0); // 透明は雨なし
    expect(rainClassOf(242, 242, 255, 255)).toBe(1);
    expect(rainClassOf(160, 210, 255, 255)).toBe(2);
    expect(rainClassOf(250, 245, 0, 255)).toBe(5);
    expect(rainClassOf(178, 2, 100, 255)).toBe(8); // 少し違う色は近い色
    expect(rainRangeText(0)).toBe('雨なし');
    expect(rainRangeText(1)).toBe('1mm未満');
    expect(rainRangeText(2)).toBe('1〜5mm');
    expect(rainRangeText(8)).toBe('80mm以上');
    expect(rainMm(2)).toBe(3);
  });

  it('解析雨量のタイルと時刻：取れる時刻のうち、記録を30分ごとに覆うものをまだ残していない分だけ', () => {
    expect(rasrfTileUrl(T0, 908, 402)).toBe('https://www.jma.go.jp/bosai/jmatile/data/rasrf/20261114220000/none/20261114220000/surf/rasrf/10/908/402.png');
    const times = rasrfPastTimes([
      { basetime: '20261114220000', validtime: '20261114220000' },
      { basetime: '20261114223000', validtime: '20261114223000' },
      { basetime: '20261114230000', validtime: '20261114230000' },
      { basetime: '20261114230000', validtime: '20261115030000' }, // 予報は除く
    ]);
    expect(times).toEqual([T0, T0 + 30 * MIN, T0 + H]);
    const available = Array.from({ length: 10 }, (_, i) => T0 + i * 30 * MIN);
    // 7:10〜8:20 の記録 → 7:30・8:00・8:30・9:00・（9:20 まで）
    const want = rainTimesToFetch(available, T0 + 10 * MIN, T0 + H + 20 * MIN, []);
    expect(want).toEqual([T0 + 30 * MIN, T0 + H, T0 + 90 * MIN, T0 + 2 * H]);
    expect(rainTimesToFetch(available, T0 + 10 * MIN, T0 + H + 20 * MIN, [{ t: T0 + H, cls: 0 }])).not.toContain(T0 + H);
  });

  it('過去の空の様子の URL：日付は UTC、3か月より前は過去の予報の API', () => {
    const url = new URL(analysisUrl([here], T0, T0 + 3 * H, T0 + 5 * H));
    expect(url.host).toBe('api.open-meteo.com');
    expect(url.searchParams.get('start_date')).toBe('2026-11-14');
    expect(url.searchParams.get('end_date')).toBe('2026-11-15');
    expect(new URL(analysisUrl([here], T0, T0 + H, T0 + 200 * 86_400_000)).host).toBe('historical-forecast-api.open-meteo.com');
  });

  it('気温と降水量を観測している一番近いアメダスと、その観測の読み方', () => {
    const table: Record<string, AmedasTableEntry> = {
      '41116': { kjName: '土呂部', lat: [36, 52.0], lon: [139, 31.0], alt: 925, elems: '11112110' },
      '42106': { kjName: '片品', lat: [36, 52.6], lon: [139, 25.0], alt: 861, elems: '01000000' }, // 降水量だけ
      '44132': { kjName: '東京', lat: [35, 41.5], lon: [139, 45.0], alt: 25, elems: '11111111' }, // 遠い
    };
    expect(nearestStation(table, here)?.name).toBe('土呂部');
    expect(nearestStation({ '44132': table['44132'] }, here)).toBeNull();
    expect(amedasUrls('41116', T0, T0 + 2 * H + 20 * MIN)).toEqual([
      'https://www.jma.go.jp/bosai/amedas/data/point/41116/20261115_06.json',
      'https://www.jma.go.jp/bosai/amedas/data/point/41116/20261115_09.json',
    ]);
    const obs = parseAmedas(
      {
        '20261115070000': { temp: [8.8, 0], precipitation10m: [0.5, 0], precipitation1h: [1.5, 0], wind: [1.0, 0], windDirection: [16, 0] },
        '20261115071000': { temp: [9.1, 0], precipitation10m: [null, 5], wind: [0.2, 0], windDirection: [0, 0] },
        '20261115120000': { temp: [12, 0] }, // 範囲の外
      },
      T0,
      T0 + H,
    );
    expect(obs).toHaveLength(2);
    expect(obs[0]).toEqual({ t: T0, temp: 8.8, precip10m: 0.5, precip1h: 1.5, wind: 1.0, dir: 0 });
    expect(obs[1].precip10m).toBeNull();
    expect(obs[1].dir).toBeNull();
  });

  it('実際の天気：雨は解析雨量、気温はアメダスを標高で補正、空の様子は解析値', () => {
    // 解析値は霧雨（弱い雨を出しやすい）
    const analysis = hourly(8, () => ({ cloud: 80, precip: 0.4, code: 51, temp: 4, wind: 3, dir: 180 }));
    const rec: TrackWeather = {
      trackId: 'x',
      // 7:30 までの1時間は雨なし、8:00・8:30 までは 1〜5mm
      rain: { fetchedAt: T0 + 5 * H, samples: [{ t: T0 + 30 * MIN, cls: 0 }, { t: T0 + H, cls: 2 }, { t: T0 + 90 * MIN, cls: 2 }] },
      analysis: { fetchedAt: T0 + 5 * H, cells: { [cellKey(here)]: packWeather(analysis) } },
      amedas: {
        fetchedAt: T0 + 5 * H,
        station: { id: '41116', name: '土呂部', lngLat: here, alt: 925 },
        obs: [
          { t: T0 + 10 * MIN, temp: 7.5, precip10m: 0, precip1h: 0, wind: 6, dir: 90 },
          { t: T0 + 40 * MIN, temp: 6.0, precip10m: 0.5, precip1h: 1, wind: 2, dir: 90 },
        ],
      },
    };
    const r = recordedWeather(rec);
    // 7:10：解析雨量で降っていないので、解析値の霧雨は曇りに。気温は 1325m に補正（400m 上で 2.6℃ 低い）
    const a = r.actual(here, T0 + 10 * MIN, 1325)!;
    expect(a.rainCls).toBe(0);
    expect(a.code).toBe(3);
    expect(a.temp).toBeCloseTo(4.9, 6);
    expect(a.wind).toBe(6);
    // 7:40：雨 1〜5mm
    const b = r.actual(here, T0 + 40 * MIN, 1325)!;
    expect(b.rainCls).toBe(2);
    expect(b.snow).toBe(false);
    // 標高 2200m なら補正した気温が 1℃ 以下なので雪
    expect(r.actual(here, T0 + 40 * MIN, 2200)!.snow).toBe(true);
    // リプレイの雨の量は階級の代表の量、雲量は解析値
    expect(r.at(here, T0 + 40 * MIN, 1325)).toMatchObject({ precip: 3, cloud: 80, code: 51 });
    expect(r.at(here, T0 + 10 * MIN, 1325)).toMatchObject({ precip: 0, code: 3 });
    // まとめ：30分ごとの1時間の量を足して半分（0 + 3 + 3）/ 2 = 3mm、気温は補正して 3.4〜4.9℃
    const sum = r.summary(T0, T0 + H, 1325)!;
    expect(sum.rainMm).toBeCloseTo(3, 6);
    expect(sum.minTemp).toBeCloseTo(3.4, 6);
    expect(sum.maxTemp).toBeCloseTo(4.9, 6);
    // なにもなければ null
    expect(recordedWeather({ trackId: 'x' }).actual(here, T0, 1000)).toBeNull();
    expect(recordedWeather({ trackId: 'x' }).summary(T0, T0 + H)).toBeNull();
  });

  it('書き出したファイルの記録の行に、記録したときの天気を入れて読める', () => {
    const track = { id: 'a', name: 't', startedAt: T0, status: 'done', distance: 0, ascent: 0, descent: 0, pointCount: 0 };
    const l = parseBackupLine(JSON.stringify({ track, points: [], weather: { trackId: 'old', rain: { fetchedAt: T0, samples: [] } } }));
    expect('track' in l && l.weather?.trackId).toBe('a');
    const noWeather = parseBackupLine(JSON.stringify({ track, points: [] }));
    expect('track' in noWeather && noWeather.weather).toBeUndefined();
  });
});
