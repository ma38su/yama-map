/**
 * ポケット表示：記録中に画面を点けたままにするとき、黒い画面に時刻・経過・距離・電池・ペース・到着予想・日没だけを大きく出し、地図の描画を止める。
 * 有機ELの画面では黒い部分はほとんど電気を使わないので、画面を点けたままでも電池の減りを抑えられる（Web 版は特に）。
 * ポケットの中で触れても戻らないよう、地図に戻るのは「地図に戻る」の長押し（1秒）・戻るボタン（アプリ版）・Esc キー・記録の終了のときだけ
 */
import { SystemBars } from '@capacitor/core';
import { formatDistance } from '../geo';
import { paceSegments } from '../nav/eta';
import { log } from '../log';
import { backgroundCapable } from '../track/location';
import { $, fmtClock, fmtHM, fmtM, fmtMin, h, renderInto, setText } from '../ui/dom';
import { batteryNow } from './batteryLevel';
import { map, updateDaylight } from './mapView';
import { isLate, movingOf, paceOf, refreshNow, type Nav, type Row } from './nav';
import { pauseFollow, recorder } from './recording';
import { whileVisible } from './scheduler';
import { state } from './state';
import { updateWeatherLayers } from './weather';

/** 長押しで地図に戻るまでの時間 */
const HOLD_MS = 1000;
/** 表示を書き換える間隔（時刻と経過は分まで。書き換えるたびに画面の描き直しが起きるので、毎秒にはしない） */
const TICK_MS = 15_000;
/** ペースを計算し直す間隔の下限（点が増えていなければ計算しない） */
const PACE_MS = 60_000;
/** 「直近」のペースに使う時間 */
const RECENT_MS = 20 * 60_000;

const panel = $('pocket');
const exitBtn = $<HTMLButtonElement>('pocket-exit');
let active = false;

export const pocketActive = () => active;

export function enterPocket() {
  if (active || !recorder.recording) return;
  active = true;
  document.body.classList.add('pocket-on');
  panel.hidden = false;
  // 現在地を追いかけていると、測位のたびに地図が動いて描き直すので、追いかけるのをやめておく（現在地の印は動く。方位センサーは compass.ts が止める）
  pauseFollow('pocket', true);
  map.stop();
  log('ポケット表示にした');
  // アプリ版は上の時計・電池と下のナビゲーションも隠して、画面全体を黒にする（端から引き出せば一時的に出る）
  if (backgroundCapable) void SystemBars.hide().catch(() => undefined);
  renderPocket();
  pocketTick.on();
}

export function exitPocket() {
  if (!active) return;
  active = false;
  document.body.classList.remove('pocket-on');
  panel.hidden = true;
  pocketTick.off();
  cancelHold();
  log('ポケット表示から地図に戻った');
  if (backgroundCapable) void SystemBars.show().catch(() => undefined);
  // 追いかけていたなら追いかけ直す
  pauseFollow('pocket', false);
  // 止めていた空の色・雨と、地図を今に合わせる。描かずにいた記録の線・カード・行程もここで描く
  updateDaylight();
  updateWeatherLayers();
  map.triggerRepaint();
  void refreshNow();
}

// ---------- ペース ----------
/** 標準タイム（コースタイム相当）の何倍かかっているかを、ことばにする */
const paceWord = (r: number) => (r < 0.85 ? '速い' : r < 0.95 ? 'やや速い' : r <= 1.05 ? '標準' : r <= 1.2 ? 'やや遅い' : '遅い');

interface PaceView {
  /** 記録全体（休憩を除く歩行中）の倍率。記録が少なければ null */
  overall: number | null;
  /** 直近20分の倍率。歩いた距離が短ければ null */
  recent: number | null;
}
let paceCache: { key: string; at: number; value: PaceView } | null = null;

/** ペース。重い計算なので、点が増えたときに、多くても1分に1回だけ計算し直す */
function paceView(): PaceView {
  const pts = recorder.state.points;
  const key = `${pts[0]?.trackId}:${pts.length}`;
  const now = Date.now();
  if (paceCache && (paceCache.key === key || now - paceCache.at < PACE_MS)) return paceCache.value;
  const value: PaceView = { overall: null, recent: null };
  if (pts.length > 1) {
    const p = paceOf(pts);
    if (p.evidenceMin > 10) value.overall = p.overall;
    // 直近20分に歩いた区間の倍率を、距離で重み付けして平均する（300m 以上歩いていれば）
    let sum = 0;
    let len = 0;
    for (const s of paceSegments(pts, undefined, movingOf(pts)).segments) {
      if (s.t1 < now - RECENT_MS) continue;
      sum += s.ratio * (s.d1 - s.d0);
      len += s.d1 - s.d0;
    }
    if (len >= 300) value.recent = sum / len;
  }
  paceCache = { key, at: now, value };
  return value;
}

/** ペースの一行：ことばは直近を優先し、倍率は両方 */
function paceLine(): HTMLElement {
  const { overall, recent } = paceView();
  const el = h('div', 'pocket-pace');
  el.append(h('span', 'label', 'ペース（標準タイムと比べて）'));
  const r = recent ?? overall;
  if (r == null) {
    el.append(h('span', 'value muted', '歩き始めて10分ほどで分かります'));
    return el;
  }
  el.append(h('span', `value ${r < 0.95 ? 'fast' : r > 1.05 ? 'slow' : ''}`, paceWord(r)));
  const parts = [];
  if (recent != null) parts.push(`直近20分 ${recent.toFixed(2)}倍`);
  if (overall != null) parts.push(`全体 ${overall.toFixed(2)}倍`);
  el.append(h('small', '', parts.join(' · ')));
  return el;
}

// ---------- 電池 ----------
/** これより少なければ、電池の残りを注意の色にする（%） */
const LOW_BATTERY = 20;
/** もつ時間の丸め：1時間より先は10分、それまでは5分ごと（1% 刻みからの見積もりなので細かく出さない） */
const roundMin = (min: number) => (min >= 60 ? Math.round(min / 10) * 10 : Math.max(5, Math.round(min / 5) * 5));

/**
 * 電池の残りと、あと何分もつか（アプリ版はポケット表示で上の電池の表示も隠すので、ここに出す）。
 * 目的地に着くより前に切れそうなら、注意の色で知らせる
 */
function batteryStats(nav: Nav | null): HTMLElement[] {
  const b = batteryNow();
  if (!b) return [];
  const level = statTile('電池', `${b.level}%`);
  level.classList.toggle('late', !b.charging && b.level <= LOW_BATTERY);
  if (b.charging) return [level, statTile('電池がもつ時間', '充電中', 'muted')];
  if (b.remainingMs == null) return [level, statTile('電池がもつ時間', '計算中', 'muted', '2%ほど減ると分かります')];
  const now = Date.now();
  const empty = now + b.remainingMs;
  const dest = nav?.dest;
  const short = !!dest && !dest.passed && dest.time != null && empty < dest.time;
  // 半日より先は、何時ごろかは出さない（日付が変わって分かりにくいので）
  const note = short ? '目的地に着く前に切れそう' : b.remainingMs < 12 * 3_600_000 ? `${fmtClock(empty)}ごろまで（目安）` : '目安';
  const tile = statTile('電池がもつ時間', `約${fmtHM(roundMin(b.remainingMs / 60_000))}`, '', note);
  tile.classList.toggle('late', short);
  return [level, tile];
}

/** 上の数字の1マス（cls は値の見た目、note は値の下の小さな説明） */
function statTile(label: string, value: string, cls = '', note = ''): HTMLElement {
  const tile = h('div', 'pocket-stat');
  tile.append(h('span', 'label', label), h('span', `value ${cls}`.trim(), value));
  if (note) tile.append(h('small', '', note));
  return tile;
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

/** 表示を今に合わせる。組み立てたものが前と同じなら書き換えない（時刻と経過は分までなので、15秒ごとの多くは同じ） */
function renderPocket() {
  const { track, error, saveFailed } = recorder.state;
  const now = Date.now();
  setText($('pocket-clock'), fmtClock(now));
  const nav = state.lastNav;
  renderInto($('pocket-stats'), (stats) => {
    if (track) {
      for (const [label, value] of [
        ['経過', fmtHM((now - track.startedAt) / 60_000)],
        ['距離', formatDistance(track.distance)],
        ['登り', fmtM(track.ascent)],
        ['標高', fmtM(state.currentEle ?? recorder.state.points.at(-1)?.ele)],
      ]) {
        stats.append(statTile(label, value));
      }
    }
    stats.append(...batteryStats(nav));
  });
  renderInto($('pocket-rows'), (rows) => {
    rows.append(paceLine());
    if (nav) {
      if (nav.next && nav.next !== nav.dest) rows.append(rowLine('次', nav.next, nav.sunset));
      if (nav.dest) rows.append(rowLine('目的地', nav.dest, nav.sunset));
      if (nav.sunset) {
        const late = !!nav.dest && isLate(nav.dest, nav.sunset);
        rows.append(h('div', `pocket-sun${late ? ' late' : ''}`, `日没 ${fmtClock(nav.sunset)}${late ? '（到着が日没に近い）' : ''}`));
      }
    }
  });
  // 気をつけること（ルートから離れた・測位できない・保存できない）
  const warn = saveFailed
    ? '記録を端末に保存できていません'
    : error ?? (nav?.offRoute && nav.pos ? `ルートから約 ${formatDistance(nav.pos.offset)} 離れています` : '');
  const warnEl = $('pocket-warn');
  warnEl.hidden = !warn;
  setText(warnEl, warn);
}
// 15秒ごと（時刻と経過は分まで）。動かすのはポケット表示のあいだだけ
const pocketTick = whileVisible(TICK_MS, renderPocket);
pocketTick.off();

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
