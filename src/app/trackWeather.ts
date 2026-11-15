/**
 * 記録した天気（../track/weatherLog.ts。実際の天気だけ）の保存と読み出し：
 *  - 記録中は、電波があれば30分ごとに、そこまでの歩いた場所の雨（解析雨量。12時間ほどしか残らない）を取って残す
 *  - 記録を終えたときに、雨と、空の様子（解析値）・一番近いアメダスの気温と風を取って残す
 *  - 圏外で取れなかった分は、電波が戻ったとき・アプリを開いたとき・画面に戻ったときに、裏で取る
 *  - 記録を開いたとき・リプレイのときには取りに行かない。開いている記録の天気を、行程・リプレイの表示と雲・雨・雪に渡す
 */
import type { LngLat } from '../geo';
import { lngLatToTile } from '../geo';
import { log } from '../log';
import { analysisUrl, cellCenter, cellKey, packWeather, parseForecast, weatherLabel } from '../nav/weather';
import { getPoints, getTrackWeather, listTracks, putTrackWeather, type Track, type TrackPoint } from '../track/db';
import { pointsIn, trackTimes } from '../track/trim';
import {
  AMEDAS_KEEP_MS,
  AMEDAS_TABLE_URL,
  RASRF_TIMES_URL,
  RASRF_ZOOM,
  amedasUrls,
  nearestStation,
  parseAmedas,
  positionAt,
  rainClassOf,
  rainRangeText,
  rainTimesToFetch,
  rasrfPastTimes,
  rasrfTileUrl,
  recordedWeather,
  sliceHourly,
  type AmedasTableEntry,
  type RecordedWeather,
  type TrackWeather,
} from '../track/weatherLog';
import { updateNav } from './nav';
import { state } from './state';
import { weatherFor } from './weather';

// ---------- 取ってくる ----------
const timeout = (ms: number) => AbortSignal.timeout(ms);

let amedasTable: Promise<Record<string, AmedasTableEntry>> | null = null;
function getAmedasTable() {
  amedasTable ??= fetch(AMEDAS_TABLE_URL, { signal: timeout(15_000) })
    .then((r) => {
      if (!r.ok) throw new Error(`アメダスの地点を取れませんでした（${r.status}）`);
      return r.json() as Promise<Record<string, AmedasTableEntry>>;
    })
    .catch((e) => {
      amedasTable = null;
      throw e;
    });
  return amedasTable;
}

/** 解析雨量の地図のタイルを読む（色を読めるように、気象庁の CORS の許可で読み込む） */
function loadTile(url: string): Promise<ImageData | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(null), 15_000);
    img.onload = () => {
      clearTimeout(timer);
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      try {
        resolve(ctx.getImageData(0, 0, c.width, c.height));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = url;
  });
}

/** 解析雨量の、地点の階級（タイルを読めなければ null） */
async function rainClassAt(t: number, at: LngLat, tiles: Map<string, Promise<ImageData | null>>): Promise<number | null> {
  const p = lngLatToTile(at[0], at[1], RASRF_ZOOM);
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  const url = rasrfTileUrl(t, x, y);
  if (!tiles.has(url)) tiles.set(url, loadTile(url));
  const img = await tiles.get(url)!;
  if (!img) return null;
  const px = Math.min(img.width - 1, Math.floor((p.x - x) * img.width));
  const py = Math.min(img.height - 1, Math.floor((p.y - y) * img.height));
  const o = (py * img.width + px) * 4;
  return rainClassOf(img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]);
}

/** 解析雨量が残っている期間（12時間ほど。少し短めに） */
const RAIN_KEEP_MS = 11 * 3_600_000;
/** 解析値を取れる期間 */
const ANALYSIS_KEEP_MS = 2 * 365 * 86_400_000;
/** 終えてすぐに取った値は、落ち着いてから取り直す（アメダス・解析値は少し遅れて出る） */
const SETTLE_MS = 2 * 3_600_000;

/** 足りない分があるか（rain：解析雨量がまだ残っていて取り切れていない。analysis・amedas：まだ取っていない・終えてすぐに取っただけ） */
function wants(rec: TrackWeather, track: Track, now: number, final: boolean) {
  const { end } = trackTimes(track);
  const settled = (fetchedAt?: number) => fetchedAt != null && (fetchedAt >= end + SETTLE_MS || now < end + SETTLE_MS);
  return {
    rain: now - end < RAIN_KEEP_MS && (rec.rain?.fetchedAt ?? 0) < Math.min(now, end + 3_600_000) - 15 * 60_000,
    analysis: final && now - end < ANALYSIS_KEEP_MS && !settled(rec.analysis?.fetchedAt),
    amedas: final && now - end < AMEDAS_KEEP_MS && !settled(rec.amedas?.fetchedAt),
  };
}

/** 記録ごとに、読んで足して書く処理を1つずつ行う（記録中の取得と終えたときの取得が重ならないように） */
const queues = new Map<string, Promise<unknown>>();
function queued<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(id) ?? Promise.resolve()).then(fn, fn);
  queues.set(id, run.catch(() => undefined));
  return run;
}

/**
 * 記録の実際の天気を取って残す（圏外・取れなければ何もしない）。final は記録を終えているとき（空の様子とアメダスも取る）。
 * 新しく残したものがあれば true
 */
function collect(track: Track, all: TrackPoint[], final: boolean): Promise<boolean> {
  return queued(track.id, async () => {
    if (track.id.startsWith('plan-') || !navigator.onLine) return false;
    const pts = pointsIn(all, track.trim);
    if (pts.length < 2) return false;
    const now = Date.now();
    const { start, end: rawEnd } = trackTimes(track);
    const end = final ? rawEnd : Math.min(rawEnd, now);
    const rec = (await getTrackWeather(track.id).catch(() => null)) ?? { trackId: track.id };
    const want = wants(rec, { ...track, endedAt: end }, now, final);
    if (!want.rain && !want.analysis && !want.amedas) return false;
    const got: string[] = [];
    if (want.rain) {
      try {
        const res = await fetch(RASRF_TIMES_URL, { signal: timeout(15_000) });
        if (!res.ok) throw new Error(`${res.status}`);
        const times = rainTimesToFetch(rasrfPastTimes(await res.json()), start, end, rec.rain?.samples ?? []);
        const tiles = new Map<string, Promise<ImageData | null>>();
        const samples = [...(rec.rain?.samples ?? [])];
        for (const t of times) {
          // その時刻までの1時間の真ん中のあたりにいた場所
          const at = positionAt(pts, Math.min(end, Math.max(start, t - 30 * 60_000)));
          const cls = at ? await rainClassAt(t, at, tiles) : null;
          if (cls != null) samples.push({ t, cls });
        }
        samples.sort((a, b) => a.t - b.t);
        rec.rain = { fetchedAt: now, samples };
        got.push(`雨 ${samples.length}`);
      } catch (e) {
        log(`記録したときの雨（解析雨量）を取れなかった: ${e instanceof Error ? e.message : e}`);
      }
    }
    // 歩いたマス目（多すぎれば間引く）
    const cells = [...new Set(pts.map((p) => cellKey([p.lng, p.lat])))].slice(0, 30);
    if (want.analysis) {
      try {
        const res = await fetch(analysisUrl(cells.map(cellCenter), start, end, now), { signal: timeout(20_000) });
        if (!res.ok) throw new Error(`${res.status}`);
        const list = parseForecast(await res.json());
        rec.analysis = { fetchedAt: now, cells: Object.fromEntries(cells.map((k, i) => [k, packWeather(sliceHourly(list[i], start, end))])) };
        got.push(`空 ${cells.length}マス`);
      } catch (e) {
        log(`記録したときの空の様子（解析値）を取れなかった: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (want.amedas) {
      try {
        const mid = pts[Math.floor(pts.length / 2)];
        const station = nearestStation(await getAmedasTable(), [mid.lng, mid.lat]);
        if (station) {
          const files = await Promise.all(
            amedasUrls(station.id, start, end).map((u) =>
              fetch(u, { signal: timeout(15_000) })
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null),
            ),
          );
          const obs = files.flatMap((j) => (j ? parseAmedas(j, start, end) : []));
          if (obs.length) {
            const { distM: _d, ...st } = station;
            rec.amedas = { fetchedAt: now, station: st, obs };
            got.push(`アメダス ${st.name} ${obs.length}`);
          }
        }
      } catch (e) {
        log(`アメダスの観測を取れなかった: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (!got.length) return false;
    await putTrackWeather(rec);
    log(`記録したときの天気を残した（${track.id.slice(0, 8)}・${got.join('・')}）`);
    if (shown?.id === track.id) shown = null; // 開いている記録なら読み直す
    state.revision++;
    updateNav();
    return true;
  });
}

/** 記録中の取得の間隔 */
const DURING_MS = 30 * 60_000;
/**
 * 最新の点がこれより古ければ、今歩いている記録ではない（途中で閉じた記録を締めるために読み込んだところ。読み込んだときは記録中に見える）。
 * そのときは取らない（「今」までを範囲にして、歩き終えたあとの時間の雨まで取ってしまうため。締めたあとに collectFinished で取る）
 */
const LIVE_POINT_MS = 10 * 60_000;
let lastDuring = 0;

/** 記録の点が増えたら呼ぶ。電波があれば30分ごとに、そこまでの雨を取って残す */
export function collectWhileRecording(track: Track | null, points: TrackPoint[]) {
  if (!track || track.status !== 'recording' || !navigator.onLine || Date.now() - lastDuring < DURING_MS) return;
  if (points.length < 2 || points[points.length - 1].t - points[0].t < DURING_MS) return;
  if (Date.now() - points[points.length - 1].t > LIVE_POINT_MS) return;
  lastDuring = Date.now();
  void collect(track, points, false).catch((e) => console.warn('記録中の天気を取れませんでした', e));
}

/** 記録を終えたら呼ぶ */
export function collectFinished(track: Track, points: TrackPoint[]) {
  void collect(track, points, true).catch((e) => console.warn('記録したときの天気を取れませんでした', e));
}

/** 圏外などで取れなかった分を取る（最近の記録だけ）。電波が戻ったとき・アプリを開いたとき・画面に戻ったとき */
let pendingAt = 0;
async function collectPending() {
  if (!navigator.onLine || Date.now() - pendingAt < 10 * 60_000) return;
  pendingAt = Date.now();
  const now = Date.now();
  for (const t of await listTracks().catch(() => [] as Track[])) {
    if (t.status !== 'done' || t.id.startsWith('plan-') || now - trackTimes(t).end > AMEDAS_KEEP_MS) continue;
    const rec = (await getTrackWeather(t.id).catch(() => null)) ?? { trackId: t.id };
    const w = wants(rec, t, now, true);
    if (w.rain || w.analysis || w.amedas) await collect(t, await getPoints(t.id), true).catch(() => false);
  }
}
window.addEventListener('online', () => void collectPending());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void collectPending();
});
setTimeout(() => void collectPending(), 8000);

// ---------- 開いている記録の天気 ----------
let shown: { id: string; rec: RecordedWeather | null } | null = null;

/** 開いている記録の天気（まだ読んでいなければ読み始めて、読めたら画面を描き直す。取りには行かない） */
export function shownWeather(): RecordedWeather | null {
  const t = state.shown?.track;
  if (!t) return null;
  if (shown?.id !== t.id) {
    const id = t.id;
    const entry: { id: string; rec: RecordedWeather | null } = { id, rec: null };
    shown = entry;
    void getTrackWeather(id)
      .catch(() => null)
      .then((r) => {
        if (shown !== entry || !r) return;
        entry.rec = recordedWeather(r);
        state.revision++;
        updateNav();
      });
  }
  return shown.rec;
}

/** 開いている記録の、時刻 t の標高（気温を標高で補正するとき） */
export function shownEleAt(t: number): number | null {
  const pts = state.shown?.points;
  if (!pts?.length) return null;
  let best = pts[0];
  for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return best.ele;
}

/** リプレイの雲・雨・雪に渡す、記録したときの天気（標高は時刻ごとに一度だけ引く） */
let eleMemo: { t: number; ele: number | null } | null = null;
export const recordedWeatherSource = (lngLat: LngLat, t: number) => {
  if (eleMemo?.t !== t) eleMemo = { t, ele: shownEleAt(t) };
  return shownWeather()?.at(lngLat, t, eleMemo.ele) ?? null;
};

/** 開いているのが計画（最初から入れてある予定・計画のリプレイ）か。計画は予報、記録は記録したときの天気を使う */
export const showingPlan = () => !!state.shown?.track.id.startsWith('plan-');

/** 天気の短い表示「🌧️ 弱い雨 8℃」（リプレイの時刻の横。記録は実際の天気、計画は予報） */
export function weatherShort(lngLat: LngLat, t: number): string {
  if (showingPlan()) {
    const w = weatherFor(lngLat, t);
    if (!w) return '';
    const { icon } = weatherLabel(w.code);
    return `${icon}${w.pop != null ? ` ${Math.round(w.pop)}%` : ''}${w.temp != null ? ` ${Math.round(w.temp)}℃` : ''}`.trim();
  }
  const a = shownWeather()?.actual(lngLat, t, shownEleAt(t));
  if (!a) return '';
  const { icon } = weatherLabel(a.code);
  const rain = a.rainCls ? ` ${a.snow ? '雪' : '雨'}${rainRangeText(a.rainCls)}` : '';
  return `${icon}${rain}${a.temp != null ? ` ${Math.round(a.temp)}℃` : ''}`.trim();
}
