/**
 * 天気予報（Open-Meteo の1時間ごとの予報。日本付近は気象庁のモデルなどを使う。API キー不要、CC BY 4.0）。
 * 予報は約5kmのマス目（WEATHER_CELL_DEG）ごとに取り、同じマスの地点は同じ予報を使う。
 */
import type { LngLat } from '../geo';

/** 予報を取るマス目の大きさ（度）。予報モデルの細かさ（約5km）に合わせる */
export const WEATHER_CELL_DEG = 0.05;

/** 1地点の1時間ごとの予報 */
export interface HourlyWeather {
  /** 時刻 (ms) */
  t: number[];
  /** 降水確率 (%) */
  pop: (number | null)[];
  /** 降水量 (mm/h) */
  precip: (number | null)[];
  /** 天気（WMO の天気コード） */
  code: (number | null)[];
  /** 雲量 (%) */
  cloud: (number | null)[];
  /** 気温 (℃) */
  temp: (number | null)[];
  /** 風速 (m/s) */
  wind: (number | null)[];
  /** 風向（風が吹いてくる方位、度） */
  dir: (number | null)[];
}

export interface WeatherAt {
  pop: number | null;
  precip: number;
  code: number | null;
  cloud: number;
  temp: number | null;
  wind: number | null;
  dir: number | null;
}

/** マス目の番号（中心の座標は cellCenter） */
export const cellKey = ([lng, lat]: LngLat) => `${Math.round(lng / WEATHER_CELL_DEG)},${Math.round(lat / WEATHER_CELL_DEG)}`;
export function cellCenter(key: string): LngLat {
  const [x, y] = key.split(',').map(Number);
  return [+(x * WEATHER_CELL_DEG).toFixed(4), +(y * WEATHER_CELL_DEG).toFixed(4)];
}

const HOURLY = ['precipitation_probability', 'precipitation', 'weather_code', 'cloud_cover', 'temperature_2m', 'wind_speed_10m', 'wind_direction_10m'] as const;

export function forecastUrl(points: LngLat[]): string {
  const q = new URLSearchParams({
    latitude: points.map((p) => p[1]).join(','),
    longitude: points.map((p) => p[0]).join(','),
    hourly: HOURLY.join(','),
    wind_speed_unit: 'ms',
    timeformat: 'unixtime',
    timezone: 'GMT',
    past_days: '2',
    forecast_days: '3',
  });
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}

interface OpenMeteoResponse {
  hourly?: { time: number[] } & Partial<Record<(typeof HOURLY)[number], (number | null)[]>>;
}

/** Open-Meteo の返答（1地点なら1つ、複数地点なら配列）を地点ごとの予報にする */
export function parseForecast(json: unknown): HourlyWeather[] {
  const list = (Array.isArray(json) ? json : [json]) as OpenMeteoResponse[];
  return list.map((r) => {
    const h = r.hourly;
    if (!h?.time) throw new Error('天気予報の形式が違います');
    const col = (k: (typeof HOURLY)[number]) => h[k] ?? h.time.map(() => null);
    return {
      t: h.time.map((s) => s * 1000),
      pop: col('precipitation_probability'),
      precip: col('precipitation'),
      code: col('weather_code'),
      cloud: col('cloud_cover'),
      temp: col('temperature_2m'),
      wind: col('wind_speed_10m'),
      dir: col('wind_direction_10m'),
    };
  });
}

export async function fetchForecast(points: LngLat[], signal?: AbortSignal): Promise<HourlyWeather[]> {
  const res = await fetch(forecastUrl(points), { signal });
  if (!res.ok) throw new Error(`天気予報を取得できませんでした（${res.status}）`);
  return parseForecast(await res.json());
}

/**
 * 時刻 time の天気。雲量・降水量・気温・風は前後の時刻で補間し、降水確率と天気は近いほうの時刻の値。
 * 予報の範囲から1時間以上外れていれば null
 */
export function weatherAt(h: HourlyWeather, time: number): WeatherAt | null {
  const n = h.t.length;
  if (!n || time < h.t[0] - 3_600_000 || time > h.t[n - 1] + 3_600_000) return null;
  let i = 0;
  while (i < n - 2 && h.t[i + 1] <= time) i++;
  const span = h.t[i + 1] - h.t[i] || 1;
  const f = n > 1 ? Math.max(0, Math.min(1, (time - h.t[i]) / span)) : 0;
  const j = Math.min(n - 1, i + 1);
  const near = f < 0.5 ? i : j;
  const lerp = (v: (number | null)[]) => {
    const a = v[i];
    const b = v[j];
    if (a == null) return b;
    if (b == null) return a;
    return a + (b - a) * f;
  };
  return {
    pop: h.pop[near],
    precip: lerp(h.precip) ?? 0,
    code: h.code[near],
    cloud: lerp(h.cloud) ?? 0,
    temp: lerp(h.temp),
    wind: lerp(h.wind),
    dir: h.dir[near],
  };
}

const HOUR_MS = 3_600_000;

/** 端末に保存する形。時刻は1時間おきなので、先頭の時刻と本数だけにする（保存の大きさが3分の2ほどになる） */
export type StoredWeather = Omit<HourlyWeather, 't'> & { t?: number[]; t0?: number; n?: number };

export function packWeather(h: HourlyWeather): StoredWeather {
  const { t, ...rest } = h;
  const hourly = t.length > 0 && t.every((v, i) => i === 0 || v - t[i - 1] === HOUR_MS);
  return hourly ? { ...rest, t0: t[0], n: t.length } : h;
}

/** 保存した形から戻す（以前の形の t の配列もそのまま読む）。読めない・古い形（風向なし）なら null */
export function unpackWeather(s: StoredWeather): HourlyWeather | null {
  const t = s.t ?? (s.t0 != null && s.n != null ? Array.from({ length: s.n }, (_, i) => s.t0! + i * HOUR_MS) : null);
  if (!t || !s.dir) return null;
  return { t, pop: s.pop, precip: s.precip, code: s.code, cloud: s.cloud, temp: s.temp, wind: s.wind, dir: s.dir };
}

/** 天気コード（WMO）の絵文字と名前 */
export function weatherLabel(code: number | null): { icon: string; label: string } {
  if (code == null) return { icon: '', label: '' };
  if (code === 0) return { icon: '☀️', label: '晴れ' };
  if (code <= 2) return { icon: '🌤️', label: '晴れ時々曇り' };
  if (code === 3) return { icon: '☁️', label: '曇り' };
  if (code === 45 || code === 48) return { icon: '🌫️', label: '霧' };
  if (code >= 51 && code <= 57) return { icon: '🌦️', label: '霧雨' };
  if (code >= 61 && code <= 67) return { icon: '🌧️', label: '雨' };
  if (code >= 71 && code <= 77) return { icon: '🌨️', label: '雪' };
  if (code >= 80 && code <= 82) return { icon: '🌦️', label: 'にわか雨' };
  if (code === 85 || code === 86) return { icon: '🌨️', label: 'にわか雪' };
  if (code >= 95) return { icon: '⛈️', label: '雷雨' };
  return { icon: '☁️', label: '' };
}
