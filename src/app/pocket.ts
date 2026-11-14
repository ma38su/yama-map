/**
 * ポケット表示：記録中に画面を点けたままにするとき、黒い画面に時刻・経過・距離・到着予想・日没だけを大きく出し、地図の描画を止める。
 * 有機ELの画面では黒い部分はほとんど電気を使わないので、画面を点けたままでも電池の減りを抑えられる（Web 版は特に）。
 * ポケットの中で触れても戻らないよう、地図に戻るのは「地図に戻る」の長押し（1秒）・戻るボタン（アプリ版）・Esc キー・記録の終了のときだけ
 */
import { SystemBars } from '@capacitor/core';
import { formatDistance, formatDuration } from '../geo';
import { backgroundCapable } from '../track/location';
import { $, fmtClock, fmtM, fmtMin, h } from '../ui/dom';
import { geolocate, map, updateDaylight } from './mapView';
import { isLate, type Row } from './nav';
import { recorder } from './recording';
import { whileVisible } from './scheduler';
import { state } from './state';
import { updateWeatherLayers } from './weather';

/** 長押しで地図に戻るまでの時間 */
const HOLD_MS = 1000;

const panel = $('pocket');
const exitBtn = $<HTMLButtonElement>('pocket-exit');
let active = false;
/** ポケット表示にする前に、現在地を追いかけていたか（戻ったら追いかけ直す） */
let wasFollowing = false;

export const pocketActive = () => active;

export function enterPocket() {
  if (active || !recorder.recording) return;
  active = true;
  document.body.classList.add('pocket-on');
  panel.hidden = false;
  // 現在地を追いかけていると、測位のたびに地図が動いて描き直すので、追いかけるのをやめておく（現在地の印は動く）
  wasFollowing = geolocate._watchState === 'ACTIVE_LOCK';
  if (wasFollowing) geolocate._watchState = 'BACKGROUND';
  map.stop();
  // アプリ版は上の時計・電池と下のナビゲーションも隠して、画面全体を黒にする（端から引き出せば一時的に出る）
  if (backgroundCapable) void SystemBars.hide().catch(() => undefined);
  renderPocket();
}

export function exitPocket() {
  if (!active) return;
  active = false;
  document.body.classList.remove('pocket-on');
  panel.hidden = true;
  cancelHold();
  if (backgroundCapable) void SystemBars.show().catch(() => undefined);
  // 追いかけていたなら追いかけ直す（BACKGROUND で押すと、今の位置に戻って追いかける）
  if (wasFollowing && geolocate._watchState === 'BACKGROUND') geolocate.trigger();
  // 止めていた空の色・雨と、地図を今に合わせる
  updateDaylight();
  updateWeatherLayers();
  map.triggerRepaint();
}

/** 次の地点・目的地の一行 */
function rowLine(label: string, row: Row, sunset: number | null): HTMLElement {
  const el = h('div', `pocket-row${isLate(row, sunset) ? ' late' : ''}`);
  el.append(h('span', 'label', `${label} ${row.mark.name}`));
  const time = h('span', 'time');
  if (row.passed) time.textContent = '到着済み';
  else if (row.time && row.remain) {
    time.textContent = `${fmtClock(row.time)}着`;
    time.append(h('small', '', `あと ${fmtMin(row.remain.totalMin)} · ${formatDistance(row.remainM)}`));
  }
  el.append(time);
  return el;
}

function renderPocket() {
  const { track, error, saveFailed } = recorder.state;
  const now = Date.now();
  $('pocket-clock').textContent = fmtClock(now);
  const stats = $('pocket-stats');
  stats.replaceChildren();
  if (track) {
    for (const [label, value] of [
      ['経過', formatDuration(now - track.startedAt)],
      ['距離', formatDistance(track.distance)],
      ['登り', fmtM(track.ascent)],
      ['標高', fmtM(state.currentEle ?? recorder.state.points.at(-1)?.ele)],
    ]) {
      const tile = h('div', 'pocket-stat');
      tile.append(h('span', 'label', label), h('span', 'value', value));
      stats.append(tile);
    }
  }
  const rows = $('pocket-rows');
  rows.replaceChildren();
  const nav = state.lastNav;
  if (nav) {
    if (nav.next && nav.next !== nav.dest) rows.append(rowLine('次', nav.next, nav.sunset));
    if (nav.dest) rows.append(rowLine('目的地', nav.dest, nav.sunset));
    if (nav.sunset) {
      const late = !!nav.dest && isLate(nav.dest, nav.sunset);
      rows.append(h('div', `pocket-sun${late ? ' late' : ''}`, `日没 ${fmtClock(nav.sunset)}${late ? '（到着が日没に近い）' : ''}`));
    }
  }
  // 気をつけること（ルートから離れた・測位できない・保存できない）
  const warn = saveFailed
    ? '記録を端末に保存できていません'
    : error ?? (nav?.offRoute && nav.pos ? `ルートから約 ${formatDistance(nav.pos.offset)} 離れています` : '');
  const warnEl = $('pocket-warn');
  warnEl.hidden = !warn;
  warnEl.textContent = warn;
}
// 表示しているあいだは毎秒（時刻と経過時間）
whileVisible(1000, () => active && renderPocket());

// ---------- 地図に戻る（長押し） ----------
let holdTimer = 0;
function cancelHold() {
  clearTimeout(holdTimer);
  holdTimer = 0;
  exitBtn.classList.remove('holding');
}
exitBtn.addEventListener('pointerdown', (e) => {
  // 指がボタンの外へずれても長押しを続ける（捕まえられなくても長押しはできる）
  try {
    exitBtn.setPointerCapture(e.pointerId);
  } catch {
    /* noop */
  }
  cancelHold();
  exitBtn.classList.add('holding');
  holdTimer = window.setTimeout(exitPocket, HOLD_MS);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) exitBtn.addEventListener(type, cancelHold);
// キーボード・読み上げソフトから押したとき（指で触れたのではない）は、すぐ戻る
exitBtn.addEventListener('click', (e) => e.detail === 0 && exitPocket());
document.addEventListener('keydown', (e) => e.key === 'Escape' && exitPocket());
$('btn-pocket').addEventListener('click', enterPocket);
