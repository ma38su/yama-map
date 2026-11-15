/**
 * リプレイの録画：地図が描かれるたびに、シートに隠れていない部分と雨・雪、時刻の字幕を別の canvas に写し、
 * その canvas を MediaRecorder で webm に記録する。止めたらファイルとして保存する。
 */
import { download } from '../ui/dom';
import { map } from './mapView';

/** 動画の長いほうの辺 (px) */
const MAX_SIDE = 1280;
/** 動画のコマ数（1秒あたり） */
export const CAPTURE_FPS = 30;

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
 * sheet は下のシート（地図のうち、シートの上端より上を写す）。
 * overlay は画面の真ん中に大きく出すタイトル（経路名と日時）と、その濃さ（0〜1）。出していなければ null
 */
export function startCapture(
  name: string,
  caption: () => string[],
  sheet: HTMLElement,
  overlay: () => { lines: string[]; alpha: number } | null = () => null,
) {
  if (rec || !captureSupported()) return;
  const src = map.getCanvas();
  const rain = map.getContainer().querySelector<HTMLCanvasElement>('canvas.rain');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  // 地図の canvas の幅と、地図のうちシートに隠れていない高さ (CSS px)。毎コマ読むと、直前に書き換えた画面（時計の文字など）の
  // レイアウトをその場でやり直させるので、大きさが変わったときに読んで覚えておく
  let cssW = src.clientWidth;
  let visibleH = sheet.getBoundingClientRect().top;
  const watch = new ResizeObserver(() => {
    cssW = src.clientWidth;
    visibleH = sheet.getBoundingClientRect().top;
  });
  watch.observe(src);
  watch.observe(sheet);
  const size = () => {
    const dpr = src.width / cssW;
    const sh = Math.min(src.height, Math.round(visibleH * dpr));
    const scale = Math.min(1, MAX_SIDE / Math.max(src.width, sh));
    // 動画の縦横は偶数にする
    const w = Math.round((src.width * scale) / 2) * 2;
    const h = Math.round((sh * scale) / 2) * 2;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return { sh, w, h };
  };
  size();
  // 地図の canvas は描いた直後でないと中身を読めないので、render のたびに写す。
  // ただし動画のコマより速くは写さない（タイトルのあいだなどは地図が60コマ描かれる）。時刻はそのコマの時刻（毎コマちょうどの間隔）で比べる
  let drawnAt = -Infinity;
  const draw = () => {
    const ft = document.timeline.currentTime;
    const now = typeof ft === 'number' ? ft : performance.now();
    if (now - drawnAt < 1000 / CAPTURE_FPS - 4) return;
    drawnAt = now;
    const { sh, w, h } = size();
    ctx.drawImage(src, 0, 0, src.width, sh, 0, 0, w, h);
    if (rain && !rain.hidden && rain.width) ctx.drawImage(rain, 0, 0, rain.width, (rain.width / src.width) * sh, 0, 0, w, h);
    const fs = Math.round(h / 22);
    const maxW = w - fs * 1.6;
    const o = overlay();
    if (o && o.alpha > 0) drawTitle(ctx, o.lines, o.alpha, w, h);
    else {
      // タイトルを出しているあいだは、下の字幕は出さない
      const lines = caption();
      ctx.font = `600 ${fs}px system-ui, sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = fs / 3;
      ctx.fillStyle = '#fff';
      lines.forEach((line, i) => ctx.fillText(fit(ctx, line, maxW), fs * 0.8, h - fs * 0.6 - (lines.length - 1 - i) * fs * 1.3));
      ctx.shadowBlur = 0;
    }
    // 最初の場面を写してから記録を始める（始めの黒い画面を入れない）
    if (recorder.state === 'inactive') recorder.start(1000);
  };
  const { mime, ext } = pickType();
  const recorder = new MediaRecorder(canvas.captureStream(CAPTURE_FPS), mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  map.on('render', draw);
  map.triggerRepaint();
  const off = () => {
    map.off('render', draw);
    watch.disconnect();
  };
  rec = { recorder, chunks, canvas, off, name: `${name}.${ext}` };
}

/** 始めのタイトル：画面の真ん中に、暗い帯と大きな経路名・日時（alpha で消していく） */
function drawTitle(ctx: CanvasRenderingContext2D, lines: string[], alpha: number, w: number, h: number) {
  const big = Math.round(Math.min(w / 14, h / 10));
  const small = Math.round(big * 0.55);
  const bandH = big * 1.6 + (lines.length - 1) * small * 1.5;
  const top = h * 0.38 - bandH / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(0, top, w, bandH);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${big}px system-ui, sans-serif`;
  ctx.fillText(fit(ctx, lines[0], w - big), w / 2, top + big * 0.85);
  ctx.font = `500 ${small}px system-ui, sans-serif`;
  lines.slice(1).forEach((l, i) => ctx.fillText(fit(ctx, l, w - big), w / 2, top + big * 1.6 + small * (0.55 + i * 1.5)));
  ctx.restore();
}

/** 切り詰めた字幕（字体・幅・文字ごと）。字幕は毎コマ描くが、変わるのは時刻くらいなので、同じものは測り直さない */
const fitted = new Map<string, string>();
/** 幅に収まらない字幕は末尾を「…」にする */
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  const key = `${ctx.font}|${maxW}|${text}`;
  let out = fitted.get(key);
  if (out == null) {
    out = text;
    if (ctx.measureText(text).width > maxW) {
      let s = text;
      while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
      out = `${s}…`;
    }
    if (fitted.size >= 200) fitted.clear();
    fitted.set(key, out);
  }
  return out;
}

/** 録画を止めて保存する（save が false なら捨てる） */
export function stopCapture(save = true): Promise<void> {
  const r = rec;
  if (!r) return Promise.resolve();
  rec = null;
  r.off();
  return new Promise((resolve) => {
    // canvas の映像の流れも止める（止めないと、録画を終えても canvas を写し続ける）
    const finish = () => {
      r.recorder.stream.getTracks().forEach((t) => t.stop());
      resolve();
    };
    r.recorder.onstop = () => {
      if (save && r.chunks.length) download(r.name, new Blob(r.chunks, { type: r.recorder.mimeType || 'video/webm' }));
      finish();
    };
    // 録画のエラーでは onstop が来ないことがあるので、そのときも終える（ボタンの表示が戻らなくならないように）
    r.recorder.onerror = (e) => {
      console.warn('録画できませんでした', e);
      finish();
    };
    if (r.recorder.state === 'inactive') finish();
    else r.recorder.stop();
  });
}
