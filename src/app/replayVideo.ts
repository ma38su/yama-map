/**
 * リプレイの録画：地図が描かれるたびに、シートに隠れていない部分と雨・雪、時刻の字幕を別の canvas に写し、
 * その canvas を MediaRecorder で webm に記録する。止めたらファイルとして保存する。
 */
import { download } from '../ui/dom';
import { map } from './mapView';

/** 動画の長いほうの辺 (px) */
const MAX_SIDE = 1280;
const FPS = 30;

let rec: { recorder: MediaRecorder; chunks: Blob[]; canvas: HTMLCanvasElement; off: () => void; name: string } | null = null;

export const captureSupported = () => typeof MediaRecorder !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
export const capturing = () => !!rec;

/** 使える動画の形式（webm を優先） */
function pickType(): { mime: string; ext: string } {
  for (const mime of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm' };
  }
  return { mime: '', ext: 'webm' };
}

/**
 * 録画を始める。caption は字幕（記録の名前と再生中の時刻など）を返す関数。
 * visibleHeight は地図のうちシートに隠れていない高さ (CSS px)
 */
export function startCapture(name: string, caption: () => string[], visibleHeight: () => number) {
  if (rec || !captureSupported()) return;
  const src = map.getCanvas();
  const rain = map.getContainer().querySelector<HTMLCanvasElement>('canvas.rain');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const size = () => {
    const dpr = src.width / src.clientWidth;
    const sh = Math.min(src.height, Math.round(visibleHeight() * dpr));
    const scale = Math.min(1, MAX_SIDE / Math.max(src.width, sh));
    // 動画の縦横は偶数にする
    const w = Math.round((src.width * scale) / 2) * 2;
    const h = Math.round((sh * scale) / 2) * 2;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return { sh, w, h };
  };
  size();
  // 地図の canvas は描いた直後でないと中身を読めないので、render のたびに写す
  const draw = () => {
    const { sh, w, h } = size();
    ctx.drawImage(src, 0, 0, src.width, sh, 0, 0, w, h);
    if (rain && !rain.hidden && rain.width) ctx.drawImage(rain, 0, 0, rain.width, (rain.width / src.width) * sh, 0, 0, w, h);
    const lines = caption();
    const fs = Math.round(h / 22);
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = fs / 3;
    ctx.fillStyle = '#fff';
    const maxW = w - fs * 1.6;
    lines.forEach((line, i) => ctx.fillText(fit(ctx, line, maxW), fs * 0.8, h - fs * 0.6 - (lines.length - 1 - i) * fs * 1.3));
    ctx.shadowBlur = 0;
    // 最初の場面を写してから記録を始める（始めの黒い画面を入れない）
    if (recorder.state === 'inactive') recorder.start(1000);
  };
  const { mime, ext } = pickType();
  const recorder = new MediaRecorder(canvas.captureStream(FPS), mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  map.on('render', draw);
  map.triggerRepaint();
  rec = { recorder, chunks, canvas, off: () => map.off('render', draw), name: `${name}.${ext}` };
}

/** 幅に収まらない字幕は末尾を「…」にする */
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

/** 録画を止めて保存する（save が false なら捨てる） */
export function stopCapture(save = true): Promise<void> {
  const r = rec;
  if (!r) return Promise.resolve();
  rec = null;
  r.off();
  return new Promise((resolve) => {
    r.recorder.onstop = () => {
      if (save && r.chunks.length) download(r.name, new Blob(r.chunks, { type: r.recorder.mimeType || 'video/webm' }));
      resolve();
    };
    if (r.recorder.state === 'inactive') resolve();
    else r.recorder.stop();
  });
}
