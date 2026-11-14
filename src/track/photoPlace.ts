/**
 * 写真を記録のどこに置くか。
 *  1. 写真に位置情報があればそこ
 *  2. なければ撮った時刻に軌跡のどこにいたかを、前後の点から補って求める
 *  3. 記録中で、最後の点より後に撮った写真（今撮った写真）は、今の現在地
 * 時刻が記録の前後 TIME_TOLERANCE_MS より外れていたら置けない（別の日の写真など）
 */
import type { LngLat } from '../geo';
import type { PhotoMeta } from './exif';
import type { TrackPhoto } from './db';

export const TIME_TOLERANCE_MS = 10 * 60_000;

export interface Placed {
  t: number;
  lngLat: LngLat;
  located: TrackPhoto['located'];
}

/** 時刻 t にいた場所。points は時刻順 */
export function positionAt(points: readonly { t: number; lng: number; lat: number }[], t: number): LngLat | null {
  if (!points.length) return null;
  if (t <= points[0].t) return [points[0].lng, points[0].lat];
  const last = points[points.length - 1];
  if (t >= last.t) return [last.lng, last.lat];
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return [a.lng + (b.lng - a.lng) * k, a.lat + (b.lat - a.lat) * k];
}

/**
 * meta：写真の Exif、fileTime：ファイルの更新時刻（Exif に時刻がないとき使う）、
 * here：記録中なら今の現在地とその時刻
 */
export function placePhoto(
  meta: PhotoMeta,
  fileTime: number,
  points: readonly { t: number; lng: number; lat: number }[],
  here: { lngLat: LngLat; t: number } | null,
): Placed | null {
  const t = meta.time ?? fileTime;
  if (meta.lng != null && meta.lat != null) return { t, lngLat: [meta.lng, meta.lat], located: 'gps' };
  const first = points[0];
  const last = points[points.length - 1];
  // 今撮った写真：最後の点より後で、今の現在地が分かっている
  if (here && (!last || t > last.t) && Math.abs(t - here.t) <= TIME_TOLERANCE_MS) return { t, lngLat: here.lngLat, located: 'here' };
  if (!first || t < first.t - TIME_TOLERANCE_MS || t > last.t + TIME_TOLERANCE_MS) return null;
  return { t, lngLat: positionAt(points, t)!, located: 'time' };
}
