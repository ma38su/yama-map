/** 画面を組み立てる小さな道具と、数値の表示の形 */
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};
export const fmtM = (m: number | null | undefined) => (m == null ? '–' : `${Math.round(m).toLocaleString('ja-JP')} m`);
export const fmtClock = (ms: number) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};
/** 分 → 「1時間05分」「38分」 */
export const fmtMin = (min: number) => {
  const m = Math.max(0, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)}時間${String(m % 60).padStart(2, '0')}分` : `${m}分`;
};
export const fmtHM = (min: number) => {
  const m = Math.max(0, Math.round(min));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};
/** ファイル名に付ける日時「20261115-0930」 */
export const fileStamp = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};


export function segButtons(wrap: HTMLElement, items: readonly (readonly [string, string])[], onPick: (id: string) => void) {
  for (const [id, label] of items) {
    const b = h('button', '', label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.id = id;
    b.addEventListener('click', () => onPick(id));
    wrap.append(b);
  }
}
export const checkSeg = (wrap: HTMLElement, id: string) => {
  for (const b of wrap.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(b.dataset.id === id));
};

/**
 * テキストや動画をファイルとして保存させる。
 * アプリ版のWebViewは <a download> でのダウンロードに対応していないので、
 * 一時ファイルに書いてから共有シート（保存先・送り先を選ぶ画面）を開く。
 */
export function download(filename: string, data: string | Blob, type = 'application/gpx+xml') {
  if (Capacitor.isNativePlatform()) {
    void shareFile(filename, data).catch((e) => {
      // 共有シートを閉じただけでも reject されるので、それ以外だけ知らせる
      if (!String((e as Error)?.message).includes('cancel')) alert(`ファイルを書き出せませんでした: ${(e as Error)?.message ?? e}`);
    });
    return;
  }
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** 動画などを書き出すときの1回分の大きさ。全体を一度に base64 にすると、長い動画でメモリが足りなくなる */
const WRITE_CHUNK = 3 * 1024 * 1024;

async function shareFile(filename: string, data: string | Blob): Promise<void> {
  const file = { path: filename, directory: Directory.Cache };
  let uri: string;
  if (typeof data === 'string') {
    ({ uri } = await Filesystem.writeFile({ ...file, data, encoding: Encoding.UTF8 }));
  } else {
    // 動画などは小分けにして base64 で書き足す（ネイティブ側で1回分ずつ戻して追記される）
    ({ uri } = await Filesystem.writeFile({ ...file, data: await blobToBase64(data.slice(0, WRITE_CHUNK)) }));
    for (let at = WRITE_CHUNK; at < data.size; at += WRITE_CHUNK) {
      await Filesystem.appendFile({ ...file, data: await blobToBase64(data.slice(at, at + WRITE_CHUNK)) });
    }
  }
  await Share.share({ title: filename, files: [uri] });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
