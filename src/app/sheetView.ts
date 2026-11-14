/** 下から出るシート：カード（到着予想の要約）と、詳細のタブ（行程／標高・ペース） */
import { formatDistance, formatDuration } from '../geo';
import { PACE_PRESETS, analyzePace, estimate } from '../nav/eta';
import { routeSpan } from '../nav/plan';
import { saveSettings, settings } from '../settings';
import { $, fmtClock, fmtHM, fmtM, fmtMin, h } from '../ui/dom';
import { BottomSheet } from '../ui/sheet';
import { emptyFC, fitTo, src } from './mapView';
import { isLate, updateNav, type Nav, type Row } from './nav';
import { profile, updateProfile } from './profileView';
import { recorder } from './recording';
import { clearRoute, exportRoute, removeMark, searchAlternativesForGpx } from './route';
import { state } from './state';

function navRow(label: string, row: Row, primary: boolean, sunset: number | null): HTMLElement {
  const el = h('div', `nav-row${primary ? ' primary' : ''}${isLate(row, sunset) ? ' late' : ''}`);
  const lab = h('div', 'nav-label');
  lab.append(`${label} · `, h('b', '', row.mark.name));
  const remain = h('div', 'nav-remain');
  const clock = h('div', 'nav-clock');
  if (row.passed) {
    clock.textContent = row.time ? fmtClock(row.time) : '✓';
    remain.textContent = '到着済み';
  } else if (row.remain && row.time) {
    clock.append(fmtClock(row.time), h('small', '', '着'));
    remain.textContent = `あと ${fmtMin(row.remain.totalMin)} · ${formatDistance(row.remainM)}`;
  }
  el.append(lab, remain, clock);
  return el;
}

export function renderCard(nav: Nav | null) {
  const card = $('card');
  card.replaceChildren();
  if (nav && state.route) {
    const span = routeSpan(state.route);
    const title = h('div', 'nav-title');
    title.append(h('b', '', state.route.name), h('span', '', ` · ${state.route.label} · ${formatDistance(span.to - span.from)}`));
    card.append(title);
    const { next, dest } = nav;
    if (next && dest && next !== dest) card.append(navRow('次', next, false, nav.sunset));
    if (dest) card.append(navRow('目的地', dest, true, nav.sunset));
    const sub = h('div', 'nav-sub');
    if (!nav.onRoute && dest && !dest.passed) sub.append(h('span', '', settings.departAt && !recorder.recording ? `${settings.departAt}出発の場合` : '今出発した場合'));
    if (nav.pace && nav.pace.evidenceMin > 10) sub.append(h('span', '', `実績ペース 標準の${nav.pace.overall.toFixed(2)}倍`));
    else sub.append(h('span', '', `ペース「${PACE_PRESETS[settings.pace].label}」`));
    sub.append(h('span', '', `休憩込み`));
    if (nav.sunset) {
      const late = dest ? isLate(dest, nav.sunset) : false;
      sub.append(h('span', late ? 'warn' : '', `日没 ${fmtClock(nav.sunset)}${late ? '（要注意）' : ''}`));
    }
    card.append(sub);
    return;
  }
  if (state.shown) {
    const t = state.shown.track;
    const end = t.status === 'recording' ? Date.now() : (t.endedAt ?? Date.now());
    const tiles = h('div', 'tiles');
    for (const [label, value] of [
      ['時間', formatDuration(end - t.startedAt)],
      ['距離', formatDistance(t.distance)],
      ['登り', fmtM(t.ascent)],
      ['標高', fmtM(state.currentEle ?? state.shown.points.at(-1)?.ele)],
    ]) {
      const tile = h('div', 'tile');
      tile.append(h('span', 'label', label), h('span', 'value', value));
      tiles.append(tile);
    }
    card.append(tiles);
    return;
  }
  const empty = h('div', 'nav-empty');
  if (state.pending.some((p) => p.kind === 'dest')) {
    empty.append(h('b', '', '出発地を選んでください'), h('br'), h('span', 'hint', '地図をタップ →「出発地」。右上の ◎ で現在地を出してから目的地を選ぶと、現在地から出発します'));
  } else {
    empty.append(h('b', '', '目的地を設定しましょう'), h('br'), h('span', 'hint', '地図をタップ →「目的地」で、道沿いのルートと到着予想を表示します'));
  }
  card.append(empty);
}

export function renderBody(nav: Nav | null) {
  const tl = $('timeline');
  tl.replaceChildren();
  const actions = $('plan-actions');
  actions.replaceChildren();
  $('sec-plan').hidden = !state.route;
  $('plan-empty').hidden = !!state.route;
  if (nav && state.route && state.timeline) {
    const items: { time: number | null; passed: boolean; el: HTMLElement }[] = [];
    for (const row of nav.rows) {
      const li = h('li', `${row.mark.kind}${row.passed ? ' passed' : ''}${isLate(row, nav.sunset) ? ' late' : ''}`);
      const time = h('div', 'time', row.time ? fmtClock(row.time) : row.passed ? '✓' : '–');
      time.append(h('small', '', row.mark.kind === 'start' ? '出発' : row.passed ? (row.time ? '到着' : '通過') : '予想'));
      const body = h('div');
      body.append(h('div', 'name', row.mark.name));
      if (row.leg) {
        const l = row.leg;
        body.append(
          h('div', 'leg', `${formatDistance(l.dist)} · ↑${Math.round(l.up)}m ↓${Math.round(l.down)}m · 標準 ${fmtHM(l.est.stdMin)} → 歩行 ${fmtHM(l.est.movingMin)}`),
        );
      } else body.append(h('div', 'leg', ''));
      const del = h('div');
      if (row.mark.kind === 'via' && !row.passed) {
        const b = h('button', 'del', '✕');
        b.type = 'button';
        b.setAttribute('aria-label', `${row.mark.name}を削除`);
        b.addEventListener('click', () => void removeMark(row.mark.id));
        del.append(b);
      }
      li.append(time, h('div', 'dot'), body, del);
      items.push({ time: row.time, passed: row.passed, el: li });
    }
    // 到着予想が日没の前後1時間にかかるなら、日没を時系列に差し込む
    const destTime = nav.dest?.time;
    if (nav.sunset && destTime && !nav.dest?.passed && destTime + 60 * 60_000 > nav.sunset) {
      const li = h('li', 'sun');
      const time = h('div', 'time', fmtClock(nav.sunset));
      time.append(h('small', '', '日没'));
      const body = h('div');
      body.append(h('div', 'name', '日没'), h('div', 'leg', '谷では日没前に暗くなります。ヘッドランプを忘れずに'));
      li.append(time, h('div', 'dot'), body, h('div'));
      let idx = items.findIndex((it) => !it.passed && it.time != null && it.time > nav.sunset!);
      if (idx < 0) idx = items.length;
      items.splice(idx, 0, { time: nav.sunset, passed: false, el: li });
    }
    tl.append(...items.map((i) => i.el));
    const span = routeSpan(state.route);
    const total = estimate(state.timeline, span.from, span.to, nav.factors);
    const sum = h('p', 'note');
    sum.textContent = `全行程 ${formatDistance(span.to - span.from)}・標準 ${fmtHM(total.stdMin)}・このペースで 歩行 ${fmtHM(total.movingMin)} ＋ 休憩 ${fmtHM(total.restMin)}${state.route.straightLegs ? '・一部直線区間あり' : ''}`;
    tl.append(sum);
    const btn = (label: string, fn: () => void, cls = '') => {
      const b = h('button', `btn ${cls}`, label);
      b.type = 'button';
      b.addEventListener('click', fn);
      actions.append(b);
    };
    if (state.route.kind === 'gpx') btn('道沿いのルート候補を探す', () => void searchAlternativesForGpx(), 'primary');
    btn('GPXで保存', exportRoute);
    btn('ルートを消す', clearRoute, 'danger');
  }
  renderDeparture();

  updateProfile(nav);

  // これまでのペース
  const grid = $('pace-grid');
  grid.replaceChildren();
  // 記録中はその記録、地図に表示中の保存した記録はその記録を、歩き終えた時点で分析する
  const p =
    nav?.pace ??
    (recorder.recording
      ? analyzePace(recorder.state.points, settings.pace)
      : state.shown && state.shown.points.length > 1
        ? analyzePace(state.shown.points, settings.pace, state.shown.points[state.shown.points.length - 1].t)
        : null);
  const tiles: [string, string][] = p
    ? [
        ['経過', formatDuration(p.elapsedMs)],
        ['歩行', formatDuration(p.movingMs)],
        ['休憩', formatDuration(p.restMs)],
        ['距離', formatDistance(p.distance)],
        ['平均(歩行中)', p.movingKmh ? `${p.movingKmh.toFixed(1)}km/h` : '–'],
        ['登りの速さ', p.climbRate ? `${Math.round(p.climbRate)}m/h` : '–'],
        ['標準比', p.evidenceMin > 10 ? `${p.overall.toFixed(2)}倍` : '–'],
        ['登/平/下', p.evidenceMin > 10 ? `${p.factors.up.toFixed(1)}/${p.factors.flat.toFixed(1)}/${p.factors.down.toFixed(1)}` : '–'],
        ['標高', fmtM(state.currentEle ?? recorder.state.points.at(-1)?.ele)],
      ]
    : [
        ['標高', fmtM(state.currentEle)],
        ['休憩見込み', `${Math.round((nav?.factors.rest ?? 1 / 6) * 60)}分/時`],
        ['ペース', PACE_PRESETS[settings.pace].label],
      ];
  for (const [label, value] of tiles) {
    const tile = h('div', 'tile');
    tile.append(h('span', 'label', label), h('span', 'value', value));
    grid.append(tile);
  }
  $('pace-title').textContent = recorder.recording || !state.shown ? 'これまでのペース' : 'この記録のペース';
  $('pace-note').textContent = p
    ? `「標準比」は地形（距離と勾配）から求めた標準タイムに対して何倍かかっているか。1より小さいほど速いペースです。登り・平坦・下りそれぞれの実績を使い、休憩は歩行1時間あたり約${Math.round(p.factors.rest * 60)}分の見込みで到着予想に含めています。`
    : '記録を開始すると、歩いた実績（登り・平坦・下りの速さ、休憩の取り方）から到着予想を自動で調整します。';
}

/** "HH:MM" */
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** 行程の「出発」：「今すぐ」なら時刻欄は現在時刻、時刻を変えると「今すぐ」が外れる */
function renderDeparture() {
  const now = !settings.departAt || recorder.recording;
  const btn = $<HTMLButtonElement>('depart-now');
  btn.setAttribute('aria-pressed', String(now));
  btn.disabled = recorder.recording;
  const input = $<HTMLInputElement>('depart-time');
  input.disabled = recorder.recording;
  if (document.activeElement !== input) input.value = now ? hhmm(new Date()) : settings.departAt!;
  $('depart-note').textContent = recorder.recording ? '記録中は現在時刻から到着予想を出します' : '';
}

// ---------- 詳細のタブ ----------
type SheetTab = 'plan' | 'profile';
let sheetTab: SheetTab = 'plan';
export function setTab(tab: SheetTab) {
  sheetTab = tab;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs [role="tab"]')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('panel-plan').hidden = tab !== 'plan';
  $('panel-profile').hidden = tab !== 'profile';
  // 表示されてから大きさが決まるので、切り替えたら描き直す
  if (tab === 'profile') profile.draw();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs [role="tab"]')) {
  b.addEventListener('click', () => setTab(b.dataset.tab as SheetTab));
}
setTab(sheetTab);

// ---------- ボトムシート ----------
export const sheet = new BottomSheet($('sheet-handle'), [$('card')], $('sheet-body'), (open) => {
  if (open) renderBody(state.lastNav);
  else src('cursor')?.setData(emptyFC);
});
export function openSheet() {
  if (!sheet.isOpen) sheet.setOpen(true);
}
$('btn-fit').addEventListener('click', () => state.route && fitTo(state.route.coords));
$('depart-now').addEventListener('click', () => {
  // 外すときは、時刻欄に出ている時刻を出発時刻にする
  settings.departAt = settings.departAt ? null : $<HTMLInputElement>('depart-time').value || hhmm(new Date());
  saveSettings();
  updateNav();
});
$<HTMLInputElement>('depart-time').addEventListener('change', (e) => {
  const v = (e.target as HTMLInputElement).value;
  if (!/^\d{2}:\d{2}$/.test(v)) return;
  settings.departAt = v;
  saveSettings();
  updateNav();
});
