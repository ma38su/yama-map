/** 画面上部の状態表示（お知らせ・GPSの状態・ルートからの外れ・オフライン） */
import { formatDistance } from '../geo';
import { settings } from '../settings';
import { $ } from '../ui/dom';
import { backgroundCapable } from '../track/location';
import { recorder } from './recording';
import { state } from './state';

// ---------- 状態表示 ----------
let flash: { text: string; until: number; warn: boolean } | null = null;
export function status(text: string, warn = false) {
  flash = { text, until: Date.now() + 6000, warn };
  renderStatus();
  setTimeout(renderStatus, 6100);
}
export function renderStatus() {
  const el = $('status');
  let text = '';
  let warn = false;
  const rs = recorder.state;
  const nav = state.lastNav;
  if (state.progressMsg) text = state.progressMsg;
  else if (flash && flash.until > Date.now()) {
    text = flash.text;
    warn = flash.warn;
  } else if (rs.saveFailed && recorder.recording) {
    text = '記録を端末に保存できていません（空き容量を確認してください）。保存できるまで記録し続けます';
    warn = true;
  } else if (rs.error && recorder.recording) {
    text = rs.error;
    warn = true;
  } else if (recorder.recording && rs.lastFix && rs.lastFix.accuracy > 40) {
    text = `GPSの精度待ち（誤差 ${Math.round(rs.lastFix.accuracy)} m）`;
    warn = true;
  } else if (nav?.offRoute && nav.pos) {
    text = `ルートから約 ${formatDistance(nav.pos.offset)} 離れています`;
    warn = true;
  } else if (recorder.recording && !backgroundCapable && !rs.wakeLock && settings.wakeLock && 'wakeLock' in navigator) {
    text = '画面を消すと記録が止まります';
    warn = true;
  } else if (!navigator.onLine) {
    text = 'オフライン（保存済みの地図を表示中）';
  }
  el.hidden = !text;
  el.textContent = text;
  el.classList.toggle('warn', warn);
}
window.addEventListener('online', renderStatus);
window.addEventListener('offline', renderStatus);


/** 読み込み中などの進み具合を出す（空文字で消す） */
export function setProgress(msg: string) {
  state.progressMsg = msg;
  renderStatus();
}
