/**
 * 記録をまとめて書き出す・読み込むファイルの形（別の端末へ移す、バックアップにする）。DOM と保存先には触れない（app/transfer.ts から使う）。
 * 1行に1つの JSON を並べる（JSON Lines）。写真がたくさんあっても、全体を1つの文字列にせずに書き出し・読み込みができるように：
 *   1行目: { app: 'yama-map', kind: 'tracks', version: 2, exportedAt }
 *   記録:  { track, points, weather?, route? }（weather は記録したときの天気。./weatherLog.ts。route は記録と一緒に保存したルート。null はルートなしで記録した）
 *   写真:  { photo }（画像は data URL）。その写真の記録の行より後に置く
 * 版1（全体が1つの JSON で entries を持つ）のファイルも読める
 */
import type { ActiveRoute } from '../nav/plan';
import type { Track, TrackPhoto, TrackPoint } from './db';
import type { TrackWeather } from './weatherLog';

export const BACKUP_VERSION = 2;

/** ファイルの中の写真（画像は data URL） */
export type BackupPhoto = Omit<TrackPhoto, 'image' | 'thumb'> & { image: string; thumb: string };

export interface BackupEntry {
  track: Track;
  points: TrackPoint[];
  photos?: BackupPhoto[];
}

export interface BackupHeader {
  app: 'yama-map';
  kind: 'tracks';
  version: number;
  exportedAt: number;
  /** 版1だけ：記録をすべて持つ */
  entries?: BackupEntry[];
}

/** 1行の中身 */
export type BackupLine = { track: Track; points: TrackPoint[]; weather?: TrackWeather; route?: ActiveRoute | null } | { photo: BackupPhoto };

export const backupHeader = (now = Date.now()): BackupHeader => ({ app: 'yama-map', kind: 'tracks', version: BACKUP_VERSION, exportedAt: now });

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('やまマップの記録のファイルではありません（読めない形式です）');
  }
}

/** 1行目を読んで確かめる。やまマップの記録のファイルでなければ例外 */
export function parseBackupHeader(line: string): BackupHeader {
  const h = json(line) as Partial<BackupHeader>;
  if (h?.app !== 'yama-map' || h.kind !== 'tracks') throw new Error('やまマップの記録のファイルではありません');
  if (typeof h.version !== 'number' || h.version > BACKUP_VERSION) {
    throw new Error('新しい版のやまマップで書き出したファイルです。アプリを新しくしてから読み込んでください');
  }
  if (h.version === 1 && !Array.isArray(h.entries)) throw new Error('記録のファイルが壊れています');
  for (const e of h.entries ?? []) {
    if (!e?.track?.id || !Array.isArray(e.points)) throw new Error('記録のファイルが壊れています');
  }
  return h as BackupHeader;
}

/** 2行目からの1行を読む */
export function parseBackupLine(line: string): BackupLine {
  const l = json(line) as Partial<{ track: Track; points: TrackPoint[]; weather: TrackWeather; route: ActiveRoute | null; photo: BackupPhoto }>;
  if (l.photo?.id && l.photo.trackId) return { photo: l.photo };
  if (l.track?.id && Array.isArray(l.points)) {
    const weather = l.weather && typeof l.weather === 'object' && (l.weather.rain || l.weather.analysis || l.weather.amedas) ? { ...l.weather, trackId: l.track.id } : undefined;
    // ルートは、線（2点以上）があるものか、ルートなしの印（null）だけ
    const route = l.route === null || (l.route && Array.isArray(l.route.coords) && l.route.coords.length > 1) ? l.route : undefined;
    return { track: l.track, points: l.points, ...(weather ? { weather } : {}), ...(route !== undefined ? { route } : {}) };
  }
  throw new Error('記録のファイルが壊れています');
}

/**
 * 読み込む記録を保存できる形に整える。同じ記録（id が同じ）がもうあれば null。
 *  - 記録中のまま書き出された記録は、最後の点の時刻で終えたことにする（読み込んだ端末で「続きを記録しますか」と聞かないように）
 *  - 点の trackId を記録に合わせ、時刻順に並べる
 */
export function prepareTrack(track: Track, points: TrackPoint[], existingIds: Set<string>): { track: Track; points: TrackPoint[] } | null {
  if (existingIds.has(track.id)) return null;
  const sorted = points.map((p) => ({ ...p, trackId: track.id })).sort((a, b) => a.t - b.t);
  const done: Track = track.status === 'recording' ? { ...track, status: 'done', endedAt: sorted.at(-1)?.t ?? track.startedAt } : { ...track };
  return { track: { ...done, pointCount: sorted.length }, points: sorted };
}
