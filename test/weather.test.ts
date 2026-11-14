import { describe, expect, it } from 'vitest';
import { cellCenter, cellKey, forecastUrl, parseForecast, weatherAt, weatherLabel } from '../src/nav/weather';

// Open-Meteo の返答の形（timeformat=unixtime、複数地点は配列）
const t0 = Date.UTC(2026, 10, 15, 2) / 1000; // 11:00 JST
const one = (pop: number[], cloud: number[]) => ({
  latitude: 36.875,
  longitude: 139.4,
  hourly: {
    time: [t0, t0 + 3600, t0 + 7200],
    precipitation_probability: pop,
    precipitation: [0, 1.2, 0.4],
    weather_code: [3, 61, 61],
    cloud_cover: cloud,
    temperature_2m: [8, 7, 6],
    wind_speed_10m: [2, 4, 3],
  },
});

describe('parseForecast', () => {
  it('1地点・複数地点の返答を読む', () => {
    expect(parseForecast(one([10, 60, 40], [80, 100, 90]))).toHaveLength(1);
    const two = parseForecast([one([10, 60, 40], [80, 100, 90]), one([0, 0, 0], [0, 0, 0])]);
    expect(two).toHaveLength(2);
    expect(two[0].t[1]).toBe((t0 + 3600) * 1000);
    expect(two[0].pop).toEqual([10, 60, 40]);
  });

  it('ない項目は null で埋める', () => {
    const r = one([1, 2, 3], [1, 2, 3]);
    delete (r.hourly as Partial<typeof r.hourly>).precipitation_probability;
    expect(parseForecast(r)[0].pop).toEqual([null, null, null]);
  });
});

describe('weatherAt', () => {
  const h = parseForecast(one([10, 60, 40], [80, 100, 90]))[0];
  it('雲量・降水量は補間し、降水確率と天気は近い時刻の値', () => {
    const w = weatherAt(h, (t0 + 1800) * 1000 + 60_000)!;
    expect(w.cloud).toBeCloseTo(90.3, 0);
    expect(w.precip).toBeCloseTo(0.62, 1);
    expect(w.pop).toBe(60);
    expect(w.code).toBe(61);
    expect(weatherAt(h, t0 * 1000 + 600_000)!.pop).toBe(10);
  });
  it('予報の範囲から外れたら null', () => {
    expect(weatherAt(h, (t0 - 7200) * 1000)).toBeNull();
    expect(weatherAt(h, (t0 + 3 * 3600) * 1000 + 3_600_001)).toBeNull();
    expect(weatherAt(h, (t0 + 2 * 3600) * 1000 + 1_800_000)!.cloud).toBe(90);
  });
});

describe('マス目とURL', () => {
  it('近い地点は同じマス目になる', () => {
    expect(cellKey([139.401, 36.874])).toBe(cellKey([139.41, 36.866]));
    expect(cellCenter(cellKey([139.401, 36.874]))).toEqual([139.4, 36.85]);
  });
  it('複数地点を1回で問い合わせる', () => {
    const u = new URL(forecastUrl([[139.4, 36.85], [139.45, 36.9]]));
    expect(u.searchParams.get('latitude')).toBe('36.85,36.9');
    expect(u.searchParams.get('longitude')).toBe('139.4,139.45');
    expect(u.searchParams.get('hourly')).toContain('precipitation_probability');
  });
  it('天気コードの名前', () => {
    expect(weatherLabel(61).label).toBe('雨');
    expect(weatherLabel(95).icon).toBe('⛈️');
  });
});
