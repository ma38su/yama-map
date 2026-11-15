/**
 * 記録をまとめて書き出す・読み込むファイルの形（別の端末へ移す、バックアップにする）。
 * 写真は data URL（base64）にして同じファイルに入れる。DOM と保存先には触れない（app/transfer.ts から使う）
 */
import type { Track, TrackPhoto, TrackPoint } from './db';

export const BACKUP_VERSION = 1;

/** ファイルの中の写真（画像は data URL） */
export type BackupPhoto = Omit<TrackPhoto, 'image' | 'thumb'> & { image: string; thumb: string };

export interface BackupEntry {
  track: Track;
  points: TrackPoint[];
  photos?: BackupPhoto[];
}

export interface BackupFile {
  app: 'yama-map';
  kind: 'tracks';
  version: number;
  exportedAt: number;
  entries: BackupEntry[];
}

export function makeBackup(entries: BackupEntry[], now = Date.now()): BackupFile {
  return { app: 'yama-map', kind: 'tracks', version: BACKUP_VERSION, exportedAt: now, entries };
}

/** ファイルを読んで確かめる。やまマップの記録のファイルでなければ例外 */
export function parseBackup(text: string): BackupFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('やまマップの記録のファイルではありません（読めない形式です）');
  }
  const f = data as Partial<BackupFile>;
  if (f?.app !== 'yama-map' || f.kind !== 'tracks' || !Array.isArray(f.entries)) {
    throw new Error('やまマップの記録のファイルではありません');
  }
  if (typeof f.version !== 'number' || f.version > BACKUP_VERSION) {
    throw new Error('新しい版のやまマップで書き出したファイルです。アプリを新しくしてから読み込んでください');
  }
  for (const e of f.entries) {
    if (!e?.track?.id || !Array.isArray(e.points)) throw new Error('記録のファイルが壊れています');
  }
  return f as BackupFile;
}

/**
 * 読み込む記録を選び、保存できる形に整える：
 *  - 同じ記録（id が同じ）がもうあれば飛ばす
 *  - 記録中のまま書き出された記録は、最後の点の時刻で終えたことにする（読み込んだ端末で「続きを記録しますか」と聞かないように）
 *  - 点と写真の trackId を記録に合わせる
 */
export function entriesToImport(file: BackupFile, existingIds: Set<string>): { entries: BackupEntry[]; skipped: number } {
  const entries: BackupEntry[] = [];
  let skipped = 0;
  for (const e of file.entries) {
    if (existingIds.has(e.track.id)) {
      skipped++;
      continue;
    }
    const id = e.track.id;
    const points = e.points.map((p) => ({ ...p, trackId: id })).sort((a, b) => a.t - b.t);
    const track: Track =
      e.track.status === 'recording'
        ? { ...e.track, status: 'done', endedAt: points.at(-1)?.t ?? e.track.startedAt }
        : { ...e.track };
    entries.push({ track: { ...track, pointCount: points.length }, points, photos: e.photos?.map((ph) => ({ ...ph, trackId: id })) });
  }
  return { entries, skipped };
}
