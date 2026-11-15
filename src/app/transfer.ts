/**
 * メニューの「記録をまとめて書き出す」「記録を読み込む」：別の端末（Pixel 8a と 9 Pro など）へ記録を移す、バックアップにする。
 * 書き出したファイルは共有シート（アプリ版）から Quick Share や Google ドライブで送り、もう一方の端末で読み込む
 */
import { log } from '../log';
import { entriesToImport, makeBackup, parseBackup, type BackupEntry, type BackupPhoto } from '../track/backup';
import { getPhotos, getPoints, listTracks, putPhoto, putTrackWithPoints } from '../track/db';
import { $, download, fileStamp } from '../ui/dom';
import { refreshTrackList } from './menu';
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
    const entries: BackupEntry[] = [];
    for (const track of tracks) {
      const photos = await getPhotos(track.id).catch(() => []);
      entries.push({
        track,
        points: await getPoints(track.id),
        photos: await Promise.all(
          photos.map(async (p): Promise<BackupPhoto> => ({ ...p, image: await toDataUrl(p.image), thumb: await toDataUrl(p.thumb) })),
        ),
      });
    }
    // 大きくなるので Blob で渡す（アプリ版は小分けにして書き出す）
    const blob = new Blob([JSON.stringify(makeBackup(entries))], { type: 'application/json' });
    log(`記録をまとめて書き出した: ${entries.length}件・${Math.round(blob.size / 1024)}KB`);
    download(`yama-map-records-${fileStamp(Date.now())}.json`, blob);
  } finally {
    setProgress('');
  }
}

async function importFile(file: File) {
  setProgress('記録を読み込んでいます…');
  try {
    const backup = parseBackup(await file.text());
    const existing = new Set((await listTracks()).map((t) => t.id));
    // 記録中の記録は読み込みで上書きしない
    if (recorder.state.track) existing.add(recorder.state.track.id);
    const { entries, skipped } = entriesToImport(backup, existing);
    let photos = 0;
    for (const e of entries) {
      await putTrackWithPoints(e.track, e.points);
      for (const p of e.photos ?? []) {
        await putPhoto({ ...p, image: await toBlob(p.image), thumb: await toBlob(p.thumb) });
        photos++;
      }
    }
    log(`記録を読み込んだ: ${entries.length}件（写真 ${photos}枚）・同じ記録があって飛ばした ${skipped}件`);
    status(`${entries.length}件の記録を読み込みました${skipped ? `（同じ記録がある ${skipped}件は飛ばしました）` : ''}`);
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
