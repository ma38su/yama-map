/**
 * 記録の画面（tracks.ts）の「記録をまとめて書き出す」「記録を読み込む」：別の端末（Pixel 8a と 9 Pro など）へ記録を移す、バックアップにする。
 * 書き出したファイルは共有シート（アプリ版）から Quick Share や Google ドライブで送り、もう一方の端末で読み込む。
 * ファイルは1行に1つの記録・写真（track/backup.ts）。写真が多くても全体を1つの文字列にしないよう、書き出しも読み込みも1行ずつ扱う
 */
import { log } from '../log';
import { backupHeader, parseBackupHeader, parseBackupLine, prepareTrack, type BackupPhoto } from '../track/backup';
import { appendPoints, getPhotos, getPoints, getTrackWeather, listTracks, putPhoto, putTrackWeather, type Track, type TrackPoint } from '../track/db';
import type { TrackWeather } from '../track/weatherLog';
import { $, download, fileStamp } from '../ui/dom';
import { refreshTrackList } from './tracks';
import { recorder } from './recording';
import { setProgress, status } from './status';

const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
const toBlob = async (dataUrl: string) => (await fetch(dataUrl)).blob();

async function exportAll() {
  const tracks = await listTracks();
  if (!tracks.length) {
    status('書き出す記録がありません');
    return;
  }
  setProgress('記録を書き出す準備をしています…');
  try {
    // 1行ずつ部品にして Blob にまとめる（全体を1つの文字列にしない）
    const parts: string[] = [`${JSON.stringify(backupHeader())}\n`];
    let photos = 0;
    for (const track of tracks) {
      const weather = await getTrackWeather(track.id).catch(() => null);
      parts.push(`${JSON.stringify({ track, points: await getPoints(track.id), ...(weather ? { weather } : {}) })}\n`);
      for (const p of await getPhotos(track.id).catch(() => [])) {
        const photo: BackupPhoto = { ...p, image: await toDataUrl(p.image), thumb: await toDataUrl(p.thumb) };
        parts.push(`${JSON.stringify({ photo })}\n`);
        photos++;
      }
    }
    const blob = new Blob(parts, { type: 'application/json' });
    log(`記録をまとめて書き出した: ${tracks.length}件・写真 ${photos}枚・${Math.round(blob.size / 1024)}KB`);
    download(`yama-map-records-${fileStamp(Date.now())}.json`, blob);
  } finally {
    setProgress('');
  }
}

/** ファイルを1行ずつ読む */
async function* readLines(file: File): AsyncGenerator<string> {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += value;
    let nl: number;
    while ((nl = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, nl).trim();
      rest = rest.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (rest.trim()) yield rest.trim();
}

async function importFile(file: File) {
  setProgress('記録を読み込んでいます…');
  try {
    const existing = new Set((await listTracks()).map((t) => t.id));
    // 記録中の記録は読み込みで上書きしない
    if (recorder.state.track) existing.add(recorder.state.track.id);
    /** このファイルから読み込んだ記録（その記録の写真だけを読み込む） */
    const imported = new Set<string>();
    let skipped = 0;
    let photos = 0;
    const putTrack = async (track: Track, points: TrackPoint[], weather?: TrackWeather) => {
      const ready = prepareTrack(track, points, existing);
      if (!ready) {
        skipped++;
        return;
      }
      await appendPoints(ready.track, ready.points);
      if (weather) await putTrackWeather(weather).catch((e) => console.warn('記録したときの天気を読み込めませんでした', e));
      imported.add(track.id);
    };
    const putPhotoLine = async (p: BackupPhoto) => {
      if (!imported.has(p.trackId)) return;
      await putPhoto({ ...p, image: await toBlob(p.image), thumb: await toBlob(p.thumb) });
      photos++;
    };
    let first = true;
    for await (const line of readLines(file)) {
      if (first) {
        first = false;
        const header = parseBackupHeader(line);
        // 版1：1行目に記録がすべて入っている
        for (const e of header.entries ?? []) {
          await putTrack(e.track, e.points);
          for (const p of e.photos ?? []) await putPhotoLine({ ...p, trackId: e.track.id });
        }
        continue;
      }
      const l = parseBackupLine(line);
      if ('photo' in l) await putPhotoLine(l.photo);
      else await putTrack(l.track, l.points, l.weather);
    }
    if (first) throw new Error('やまマップの記録のファイルではありません（中身が空です）');
    log(`記録を読み込んだ: ${imported.size}件（写真 ${photos}枚）・同じ記録があって飛ばした ${skipped}件`);
    status(`${imported.size}件の記録を読み込みました${skipped ? `（同じ記録がある ${skipped}件は飛ばしました）` : ''}`);
    await refreshTrackList();
  } catch (e) {
    status(e instanceof Error ? e.message : String(e), true);
  } finally {
    setProgress('');
  }
}

$('btn-export-records').addEventListener('click', () => void exportAll().catch((e) => status(`書き出せませんでした: ${e}`, true)));
$<HTMLInputElement>('records-file').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) void importFile(file);
});
