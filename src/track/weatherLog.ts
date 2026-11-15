/**
 * 記録した天気（記録ごとに1つ。db.ts の weather）。予報ではなく、実際の天気だけを残す。DOM には触れない
 *  - 雨：気象庁の解析雨量（レーダーと雨量計を合わせた、1km 四方の、その時刻までの1時間の雨の量）。歩いた場所の値を30分ごと。
 *    気象庁のサイトに残っているのは12時間ほどなので、記録中（電波があるとき）と記録を終えたときに取る
 *  - 気温・風：一番近いアメダスで測った10分ごとの値。気温は、アメダスと歩いた場所の標高の差で補正して使う
 *  - 空の様子（晴れ・曇り）と雲の量：歩いたマス目の1時間ごとの天気（Open-Meteo の解析値。予報モデルの計算）
 * リプレイの雲・雨・雪と、行程・リプレイの天気の表示に使う（リプレイのときには取りに行かない）
 */
import { distance, type LngLat } from '../geo';
import { cellCenter, unpackWeather, weatherAt, type HourlyWeather, type StoredWeather, type WeatherAt } from '../nav/weather';
import type { TrackPoint } from './db';

/** 歩いた場所の、その時刻までの1時間の雨（解析雨量の階級） */
export interface RainSample {
  /** 解析雨量の時刻 (ms)。この時刻までの1時間の量 */
  t: number;
  /** 階級（RAIN_CLASSES の番号。0 は雨なし） */
  cls: number;
}

export interface AmedasStation {
  id: string;
  name: string;
  lngLat: LngLat;
  /** 標高 (m) */
  alt: number;
}

/** アメダスの10分ごとの観測 */
export interface AmedasObs {
  t: number;
  temp: number | null;
  /** 10分間の降水量 (mm) */
  precip10m: number | null;
  /** 1時間の降水量 (mm) */
  precip1h: number | null;
  /** 風速 (m/s) */
  wind: number | null;
  /** 風向（吹いてくる方位、度）。静穏なら null */
  dir: number | null;
}

export interface TrackWeather {
  trackId: string;
  rain?: { fetchedAt: number; samples: RainSample[] };
  analysis?: { fetchedAt: number; cells: Record<string, StoredWeather> };
  amedas?: { fetchedAt: number; station: AmedasStation; obs: AmedasObs[] };
}

/** 1時間ごとの天気から、from〜to（前後1時間を含む）だけを切り出す */
export function sliceHourly(h: HourlyWeather, from: number, to: number): HourlyWeather {
  const keep = h.t.map((t) => t >= from - 3_600_000 && t <= to + 3_600_000);
  const pick = <T>(v: T[]) => v.filter((_, i) => keep[i]);
  return { t: pick(h.t), pop: pick(h.pop), precip: pick(h.precip), code: pick(h.code), cloud: pick(h.cloud), temp: pick(h.temp), wind: pick(h.wind), dir: pick(h.dir) };
}

/** 記録の時刻 t の位置（前後の点のあいだ。記録の外なら端の点） */
export function positionAt(points: TrackPoint[], t: number): LngLat | null {
  if (!points.length) return null;
  if (t <= points[0].t) return [points[0].lng, points[0].lat];
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (b.t < t) continue;
    const a = points[i - 1];
    const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    return [a.lng + (b.lng - a.lng) * f, a.lat + (b.lat - a.lat) * f];
  }
  const last = points[points.length - 1];
  return [last.lng, last.lat];
}

// ---------- 解析雨量 ----------
const JMATILE = 'https://www.jma.go.jp/bosai/jmatile/data';
export const RASRF_TIMES_URL = `${JMATILE}/rasrf/targetTimes.json`;
/** 解析雨量の地図のズーム（1 ピクセル約120m。1km 四方の値を読むのに十分） */
export const RASRF_ZOOM = 10;
/** 雨を残す間隔 */
export const RAIN_STEP_MS = 30 * 60_000;

/** 解析雨量の階級：色（気象庁の雨の色）と、1時間の量の範囲 (mm) */
export const RAIN_CLASSES: { rgb: [number, number, number]; lo: number; hi: number | null }[] = [
  { rgb: [0, 0, 0], lo: 0, hi: 0 },
  { rgb: [242, 242, 255], lo: 0, hi: 1 },
  { rgb: [160, 210, 255], lo: 1, hi: 5 },
  { rgb: [33, 140, 255], lo: 5, hi: 10 },
  { rgb: [0, 65, 255], lo: 10, hi: 20 },
  { rgb: [250, 245, 0], lo: 20, hi: 30 },
  { rgb: [255, 153, 0], lo: 30, hi: 50 },
  { rgb: [255, 40, 0], lo: 50, hi: 80 },
  { rgb: [180, 0, 104], lo: 80, hi: null },
];

/** 地図の1ピクセルの色から階級（透明は雨なし。少し違う色は一番近い色の階級） */
export function rainClassOf(r: number, g: number, b: number, a: number): number {
  if (a < 128) return 0;
  let best = 1;
  let bestD = Infinity;
  for (let i = 1; i < RAIN_CLASSES.length; i++) {
    const [cr, cg, cb] = RAIN_CLASSES[i].rgb;
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestD) [best, bestD] = [i, d];
  }
  return best;
}

/** 階級の代表の量 (mm/h)。雨の描き方に使う */
export function rainMm(cls: number): number {
  const c = RAIN_CLASSES[cls];
  if (!c || cls === 0) return 0;
  return c.hi == null ? c.lo * 1.2 : (c.lo + c.hi) / 2;
}

/** 階級の表し方「1mm未満」「1〜5mm」「80mm以上」 */
export function rainRangeText(cls: number): string {
  const c = RAIN_CLASSES[cls];
  if (!c || cls === 0) return '雨なし';
  if (c.lo === 0) return `${c.hi}mm未満`;
  return c.hi == null ? `${c.lo}mm以上` : `${c.lo}〜${c.hi}mm`;
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** 解析雨量の地図のタイルの URL（時刻は UTC の「20261115080000」） */
export function rasrfTileUrl(t: number, x: number, y: number, z = RASRF_ZOOM): string {
  const s = stamp(t);
  return `${JMATILE}/rasrf/${s}/none/${s}/surf/rasrf/${z}/${x}/${y}.png`;
}

/** 解析雨量の、いま取れる過去の時刻 (ms)（targetTimes.json のうち、解析した時刻と対象の時刻が同じもの） */
export function rasrfPastTimes(json: unknown): number[] {
  const list = Array.isArray(json) ? (json as { basetime?: string; validtime?: string }[]) : [];
  const parse = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
  return [...new Set(list.filter((x) => x.basetime && x.basetime === x.validtime).map((x) => parse(x.basetime!)))].sort((a, b) => a - b);
}

/**
 * 残す雨の時刻：from〜to を30分ごとに覆う、取れる時刻のうちまだ残していないもの。
 * 解析雨量はその時刻までの1時間の量なので、to の1時間後まで（いま取れるところまで）
 */
export function rainTimesToFetch(available: number[], from: number, to: number, have: RainSample[]): number[] {
  const done = new Set(have.map((s) => s.t));
  const ok = new Set(available);
  const out: number[] = [];
  const first = Math.ceil((from + 1) / RAIN_STEP_MS) * RAIN_STEP_MS;
  for (let t = first; t <= to + 3_600_000; t += RAIN_STEP_MS) if (ok.has(t) && !done.has(t)) out.push(t);
  return out;
}

// ---------- アメダス ----------
export const AMEDAS_TABLE_URL = 'https://www.jma.go.jp/bosai/amedas/const/amedastable.json';
const AMEDAS_POINT_URL = 'https://www.jma.go.jp/bosai/amedas/data/point';
/** アメダスの観測を取れる期間（気象庁のサイトに残っているのは10日ほど） */
export const AMEDAS_KEEP_MS = 9 * 86_400_000;
/** これより遠いアメダスは使わない（山の向こうの、天気の違う場所になりやすい） */
export const AMEDAS_MAX_KM = 30;
/** 気温の高さによる下がり方（℃/m）。標高が100m上がると約0.65℃下がる */
export const LAPSE_RATE = 0.0065;

/** アメダスの地点の一覧の1つ（緯度・経度は [度, 分]。elems は観測する要素：1文字目が気温、2文字目が降水量） */
export interface AmedasTableEntry {
  kjName: string;
  lat: [number, number];
  lon: [number, number];
  alt: number;
  elems: string;
}

/** 気温と降水量を観測している、一番近いアメダス（AMEDAS_MAX_KM より遠ければ null） */
export function nearestStation(table: Record<string, AmedasTableEntry>, at: LngLat): (AmedasStation & { distM: number }) | null {
  let best: (AmedasStation & { distM: number }) | null = null;
  for (const [id, e] of Object.entries(table)) {
    if (e.elems?.[0] !== '1' || e.elems?.[1] !== '1') continue;
    const lngLat: LngLat = [e.lon[0] + e.lon[1] / 60, e.lat[0] + e.lat[1] / 60];
    const d = distance(at, lngLat);
    if (d <= AMEDAS_MAX_KM * 1000 && (!best || d < best.distM)) best = { id, name: e.kjName, lngLat, alt: e.alt, distM: d };
  }
  return best;
}

const JST_MS = 9 * 3_600_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** from〜to（前後30分を含む）の観測のファイル（日本時間の3時間ごと） */
export function amedasUrls(id: string, from: number, to: number): string[] {
  const urls: string[] = [];
  const step = 3 * 3_600_000;
  const first = Math.floor((from - 30 * 60_000 + JST_MS) / step) * step;
  for (let b = first; b <= to + 30 * 60_000 + JST_MS; b += step) {
    const d = new Date(b); // 日本時間を UTC として読む
    urls.push(`${AMEDAS_POINT_URL}/${id}/${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}.json`);
  }
  return urls;
}

type AmedasValue = [number | null, number] | undefined;
/** 品質が正常・準正常の値だけ */
const val = (v: AmedasValue) => (v && typeof v[0] === 'number' && v[1] <= 1 ? v[0] : null);

/** 観測のファイル（時刻「20261115120000」（日本時間）ごとの値）を、from〜to（前後30分を含む）の観測にする */
export function parseAmedas(json: unknown, from: number, to: number): AmedasObs[] {
  const out: AmedasObs[] = [];
  for (const [key, v] of Object.entries((json ?? {}) as Record<string, Record<string, AmedasValue>>)) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(key);
    if (!m) continue;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - JST_MS;
    if (t < from - 30 * 60_000 || t > to + 30 * 60_000) continue;
    const code = val(v.windDirection);
    out.push({
      t,
      temp: val(v.temp),
      precip10m: val(v.precipitation10m),
      precip1h: val(v.precipitation1h),
      wind: val(v.wind),
      // 風向は16方位（1 = 北北東 … 16 = 北、0 = 静穏）
      dir: code ? (code * 22.5) % 360 : null,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------- 記録した天気を引く ----------
/** その時刻・場所の実際の天気（行程・リプレイの表示用） */
export interface ActualWeather {
  /** 空の様子（解析値の天気コード。解析雨量に合わせて、降っていれば雨・雪、降っていなければ曇りに直す） */
  code: number | null;
  /** 雨の階級（解析雨量。なければ null） */
  rainCls: number | null;
  /** 雪か（気温が低いとき・解析値が雪のとき） */
  snow: boolean;
  /** 気温（アメダスを標高で補正。なければ解析値） */
  temp: number | null;
  /** 風速（アメダス。なければ解析値） */
  wind: number | null;
}

export interface RecordedWeather {
  /** リプレイの雲・雨・雪に使う天気（記録したときの天気がなければ null） */
  at(lngLat: LngLat, t: number, ele?: number | null): WeatherAt | null;
  /** 表示用の実際の天気（なにも残っていなければ null） */
  actual(lngLat: LngLat, t: number, ele?: number | null): ActualWeather | null;
  station: AmedasStation | null;
  /** 記録の範囲の雨の量の合計（約、mm）と、補正した気温の最低・最高 */
  summary(from: number, to: number, ele?: number | null): { rainMm: number | null; minTemp: number | null; maxTemp: number | null } | null;
}

/** 時刻 t に一番近いもの（maxMs より離れていれば null） */
function nearestInTime<T extends { t: number }>(list: T[], t: number, maxMs: number): T | null {
  let best: T | null = null;
  for (const x of list) if (Math.abs(x.t - t) <= maxMs && (!best || Math.abs(x.t - t) < Math.abs(best.t - t))) best = x;
  return best;
}

const isSnowCode = (c: number | null) => c != null && ((c >= 71 && c <= 77) || c === 85 || c === 86);
const isWetCode = (c: number | null) => c != null && c >= 51;

export function recordedWeather(rec: TrackWeather): RecordedWeather {
  const cells = Object.entries(rec.analysis?.cells ?? {})
    .map(([k, s]) => ({ center: cellCenter(k), h: unpackWeather(s) }))
    .filter((c): c is { center: LngLat; h: HourlyWeather } => c.h != null);
  const obs = rec.amedas?.obs ?? [];
  const station = rec.amedas?.station ?? null;
  const rain = rec.rain?.samples ?? [];
  const analyzed = (lngLat: LngLat, t: number) => {
    if (!cells.length) return null;
    const near = cells.reduce((a, b) => (distance(lngLat, b.center) < distance(lngLat, a.center) ? b : a));
    return weatherAt(near.h, t);
  };
  const observed = (t: number) => nearestInTime(obs, t, 10 * 60_000);
  /** 時刻 t の雨：t を含む1時間の解析雨量（t のあと1時間以内で一番近い時刻のもの） */
  const rainAt = (t: number) => {
    let best: RainSample | null = null;
    for (const s of rain) if (s.t >= t && s.t - t <= 3_600_000 && (!best || s.t < best.t)) best = s;
    return best ?? nearestInTime(rain, t, RAIN_STEP_MS);
  };
  /** アメダスの気温を、歩いた場所の標高に補正する */
  const correct = (temp: number, ele?: number | null) => (ele == null || !station ? temp : temp - (ele - station.alt) * LAPSE_RATE);
  const actual = (lngLat: LngLat, t: number, ele?: number | null): ActualWeather | null => {
    const a = analyzed(lngLat, t);
    const r = rainAt(t);
    const o = observed(t);
    const temp = o?.temp != null ? correct(o.temp, ele) : (a?.temp ?? null);
    if (!a && !r && temp == null) return null;
    const wet = r ? r.cls > 0 : isWetCode(a?.code ?? null);
    const snow = wet && (isSnowCode(a?.code ?? null) || (temp != null && temp <= 1));
    // 空の様子は解析値。解析雨量で降っていなければ、雨の天気コードは曇りにする（解析値は弱い雨を出しやすい）
    let code = a?.code ?? null;
    if (r && r.cls === 0 && isWetCode(code)) code = 3;
    if (r && r.cls > 0 && !isWetCode(code)) code = 61;
    if (snow) code = 71;
    return { code, rainCls: r ? r.cls : null, snow, temp, wind: o?.wind ?? a?.wind ?? null };
  };
  return {
    at(lngLat, t, ele) {
      const x = actual(lngLat, t, ele);
      if (!x) return null;
      const a = analyzed(lngLat, t);
      const wet = x.rainCls != null ? x.rainCls > 0 : isWetCode(x.code);
      return {
        pop: null,
        precip: x.rainCls != null ? rainMm(x.rainCls) : (a?.precip ?? 0),
        code: x.code,
        cloud: a?.cloud ?? (wet ? 95 : 0),
        temp: x.temp,
        wind: x.wind,
        dir: observed(t)?.dir ?? a?.dir ?? null,
      };
    },
    actual,
    station,
    summary(from, to, ele) {
      const inRain = rain.filter((s) => s.t > from && s.t <= to + 3_600_000);
      // 30分ごとの「その時刻までの1時間の量」なので、足して半分にすると合計になる
      const rainTotal = inRain.length ? inRain.reduce((sum, s) => sum + rainMm(s.cls), 0) * (RAIN_STEP_MS / 3_600_000) : null;
      const temps = obs.filter((o) => o.t >= from - 5 * 60_000 && o.t <= to + 5 * 60_000 && o.temp != null).map((o) => correct(o.temp!, ele));
      if (rainTotal == null && !temps.length) return null;
      return { rainMm: rainTotal, minTemp: temps.length ? Math.min(...temps) : null, maxTemp: temps.length ? Math.max(...temps) : null };
    },
  };
}
