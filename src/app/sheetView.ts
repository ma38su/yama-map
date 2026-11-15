/** 下から出るシート：カード（到着予想の要約）と、詳細のタブ（行程／標高・ペース） */
import { formatDistance, formatDuration, type LngLat } from '../geo';
import { PACE_PRESETS, estimate } from '../nav/eta';
import { DEPART_DATE_TIME, DEPART_TIME, routeSpan } from '../nav/plan';
import { saveSettings, settings } from '../settings';
import { $, onLongPress, fmtClock, fmtHM, fmtM, fmtMin, h } from '../ui/dom';
import { BottomSheet } from '../ui/sheet';
import { actualRows, type ActualRow } from '../track/actual';
import { trackTitle } from '../track/names';
import { trackTimes } from '../track/trim';
import { forecastHorizon, weatherLabel, type WeatherAt } from '../nav/weather';
import { emptyFC, fitTo, src } from './mapView';
import { departureTime, isLate, paceOf, updateNav, type Nav, type Row } from './nav';
import { miniProfileFor, profile, updateProfile } from './profileView';
import { recorder, replayPlan, viewingTrack } from './recording';
import { clearRoute, exportRoute, removeMark, reverseCurrentRoute, searchAlternativesForGpx } from './route';
import { state } from './state';
import { renderTrimEditor } from './trimView';
import { showingPlan, shownWeather } from './trackWeather';
import { rainRangeText } from '../track/weatherLog';
import { weatherFor } from './weather';

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

/** 出発時刻の表示：「5:00」、翌日なら「明日 5:00」 */
/** 今日から何日後か（0 = 今日、1 = 明日） */
const daysFromToday = (ms: number) => {
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  return Math.round((day(ms) - day(Date.now())) / 86_400_000);
};
/** 出発の日時の表示：今日なら「5:00」、明日なら「明日 5:00」、それより先は「11/20(金) 5:00」 */
const departLabel = (ms: number) => {
  const n = daysFromToday(ms);
  const d = new Date(ms);
  const day = n === 0 ? '' : n === 1 ? '明日 ' : `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]}) `;
  return `${day}${fmtClock(ms)}`;
};

/** 天気の一行「🌤️ 晴れ時々曇り · 降水 20% · 12℃」（head は「予報」などの見出し） */
function wxRow(w: WeatherAt, head = ''): HTMLElement {
  const { icon, label } = weatherLabel(w.code);
  const parts = [`${head ? `${head} ` : ''}${icon} ${label}`.trim()];
  if (w.pop != null) parts.push(`降水 ${Math.round(w.pop)}%`);
  else if (w.precip >= 0.1) parts.push(`${w.precip.toFixed(1)}mm/h`);
  if (w.temp != null) parts.push(`${Math.round(w.temp)}℃`);
  if (w.wind != null && w.wind >= 5) parts.push(`風 ${Math.round(w.wind)}m/s`);
  return h('div', `wx${(w.pop ?? 0) >= 50 || w.precip >= 1 ? ' wet' : ''}`, parts.filter(Boolean).join(' · '));
}

/** 地点・時刻の天気の一行（予報がまだなければ null） */
function wxLine(lngLat: LngLat, time: number): HTMLElement | null {
  const w = weatherFor(lngLat, time);
  return w ? wxRow(w) : null;
}

/**
 * 開いている記録の、その時刻の天気の一行：記録は実際の天気（雨は解析雨量、気温はアメダスを標高で補正、空の様子は解析値）、
 * 計画（予定）は端末に残っている予報
 */
function recordedWxLine(lngLat: LngLat, time: number, ele: number | null): HTMLElement | null {
  if (showingPlan()) {
    const w = wxLine(lngLat, time);
    w?.prepend('予報 ');
    return w;
  }
  const a = shownWeather()?.actual(lngLat, time, ele);
  if (!a) return null;
  const { icon, label } = weatherLabel(a.code);
  const parts = [`${icon} ${a.rainCls ? (a.snow ? '雪' : '雨') : label}`.trim()];
  if (a.rainCls != null && a.rainCls > 0) parts.push(rainRangeText(a.rainCls));
  if (a.temp != null) parts.push(`${Math.round(a.temp)}℃`);
  if (a.wind != null && a.wind >= 5) parts.push(`風 ${Math.round(a.wind)}m/s`);
  return h('div', `wx${(a.rainCls ?? 0) >= 2 ? ' wet' : ''}`, parts.join(' · '));
}

/** これから通る地点の降水確率のうち、いちばん高いもの */
function maxPop(nav: Nav): number | null {
  let max: number | null = null;
  for (const r of nav.rows) {
    if (r.passed || !r.time) continue;
    const pop = weatherFor(r.mark.lngLat, r.time)?.pop;
    if (pop != null) max = Math.max(max ?? 0, pop);
  }
  return max;
}

/** 歩いている途中か（ルートの上にいる・ルートから離れて戻る途中）。行程の中の現在地を示すとき */
const walking = (nav: Nav | null): nav is Nav & { pos: NonNullable<Nav['pos']> } => !!state.route && !!nav?.pos && (nav.onRoute || !!nav.rejoin);

/** 行程のどこにいるか：出発地から目的地までの棒に、地点（通った地点は灰色）と現在地 */
function progressBar(nav: Nav, span: { from: number; to: number }): HTMLElement {
  const ratio = (d: number) => Math.max(0, Math.min(1, (d - span.from) / Math.max(1, span.to - span.from)));
  const left = (d: number) => `${(ratio(d) * 100).toFixed(1)}%`;
  const el = h('div', 'prog');
  const bar = h('div', 'prog-bar');
  const done = h('div', 'prog-done');
  done.style.width = left(nav.fromAlong);
  bar.append(done);
  for (const r of nav.rows) {
    const mk = h('span', `prog-mk ${r.mark.kind}${r.passed ? ' passed' : ''}${r === nav.next ? ' next' : ''}`);
    mk.style.left = left(r.mark.along);
    bar.append(mk);
  }
  const here = h('span', `prog-here${nav.rejoin ? ' off' : ''}`);
  here.style.left = left(nav.fromAlong);
  bar.append(here);
  el.append(bar, h('span', 'prog-pct', `${Math.round(ratio(nav.fromAlong) * 100)}%`));
  el.setAttribute('aria-label', `行程の${Math.round(ratio(nav.fromAlong) * 100)}%`);
  return el;
}

/** 行程表の「現在地」の行（通った地点と、次の地点のあいだに入れる） */
function hereRow(nav: Nav & { pos: NonNullable<Nav['pos']> }, span: { from: number; to: number }): HTMLElement {
  const li = h('li', `here${nav.rejoin ? ' off' : ''}`);
  const time = h('div', 'time', fmtClock(Date.now()));
  time.append(h('small', '', '現在'));
  const body = h('div');
  const name = h('div', 'name', '現在地');
  if (state.currentEle != null) name.append(h('small', '', ` 標高 ${fmtM(state.currentEle)}`));
  body.append(name);
  const walked = Math.max(0, nav.fromAlong - span.from);
  const rest = Math.max(0, span.to - nav.fromAlong) + (nav.rejoin?.distM ?? 0);
  const lines = [`${formatDistance(walked)} 歩いた · 残り ${formatDistance(rest)}`];
  if (nav.rejoin) lines.unshift(`ルートから約 ${formatDistance(nav.pos.offset)} 離れています`);
  const next = nav.next;
  if (next && !next.passed && next.remain) lines.push(`次の${next.mark.name}まで ${formatDistance(next.remainM)} · あと ${fmtMin(next.remain.totalMin)}`);
  for (const [i, text] of lines.entries()) body.append(h('div', i === lines.length - 1 ? 'leg' : 'leg tight', text));
  li.append(time, h('div', 'dot'), body, h('div'));
  return li;
}

/** 開いている記録の実績（ルートの地点を通った時刻など）。点が増えたときだけ計算し直す */
let actualCache: { key: string; rows: ActualRow[] } | null = null;
export function shownActual(): ActualRow[] {
  const shown = state.shown!;
  const key = `${shown.track.id}:${shown.points.length}:${state.revision}:${state.route?.name ?? ''}:${state.route?.marks.length ?? 0}`;
  if (actualCache?.key !== key) actualCache = { key, rows: actualRows(shown.points, state.route?.marks) };
  return actualCache.rows;
}

/** 開いている記録のカードの1行：「7:20発 女夫渕 → 手白澤温泉 9:05着」 */
function actualLine(first: ActualRow, last: ActualRow): HTMLElement {
  const el = h('div', 'nav-row primary act-line');
  const clock = (row: ActualRow, label: string) => {
    const c = h('div', 'act-clock');
    c.append(fmtClock(row.t), h('small', '', label));
    return c;
  };
  const names = h('div', 'act-names');
  names.append(h('b', '', first.name), h('span', 'act-arrow', ' → '), h('b', '', last.name));
  el.append(clock(first, '発'), names, clock(last, '着'));
  return el;
}

/** 開いている記録のカード：出発と到着を1行にまとめ、所要・ペースと、地点の入った小さな標高グラフ */
function renderActualCard(card: HTMLElement) {
  const { track, points } = state.shown!;
  const rows = shownActual();
  const first = rows[0];
  const last = rows.at(-1);
  const title = h('div', 'nav-title');
  title.append(h('b', '', trackTitle(track)), h('span', '', ` · ${new Date(track.startedAt).toLocaleDateString('ja-JP')}の${track.id.startsWith('plan-') ? '予定' : '記録'}`));
  card.append(title);
  if (first && last) card.append(actualLine(first, last));
  const p = points.length > 1 ? paceOf(points, true) : null;
  const sub = h('div', 'nav-sub');
  if (first && last) sub.append(h('span', '', `所要 ${fmtHM((last.t - first.t) / 60_000)} · ${formatDistance(track.distance)}`));
  if (p) sub.append(h('span', '', `歩行 ${fmtHM(p.movingMs / 60_000)} · 休憩 ${fmtHM(p.restMs / 60_000)}`));
  sub.append(h('span', '', `登り ${fmtM(track.ascent)} · 下り ${fmtM(track.descent)}`));
  if (track.steps) sub.append(h('span', '', `${track.steps.toLocaleString('ja-JP')}歩`));
  if (p && p.evidenceMin > 10) sub.append(h('span', '', `標準の${p.overall.toFixed(2)}倍`));
  // 記録した実際の天気のまとめ：雨の量（解析雨量）と気温（アメダスを、歩いた標高のまんなかに補正）
  const rec = showingPlan() ? null : shownWeather();
  const eles = points.map((q) => q.ele).filter((v): v is number => v != null).sort((x, y) => x - y);
  const sum = first && last ? rec?.summary(first.t, last.t, eles.length ? eles[Math.floor(eles.length / 2)] : null) : null;
  if (sum) {
    const rain = sum.rainMm == null ? '' : sum.rainMm < 0.5 ? '雨なし' : `雨 約${sum.rainMm < 1 ? 1 : Math.round(sum.rainMm)}mm`;
    const temp = sum.minTemp != null && sum.maxTemp != null ? `${Math.round(sum.minTemp)}〜${Math.round(sum.maxTemp)}℃` : '';
    const from = [sum.rainMm != null ? '解析雨量' : '', rec?.station && temp ? `アメダス${rec.station.name}` : ''].filter(Boolean).join('・');
    sub.append(h('span', '', `${[rain, temp].filter(Boolean).join(' · ')}${from ? `（${from}）` : ''}`));
  }
  card.append(sub);
  const mini = miniProfileFor(points);
  if (mini) card.append(mini);
}

/** 開いている記録の行程：出発・通った地点・休憩・到着の実績 */
function renderActualTimeline(tl: HTMLElement) {
  for (const row of shownActual()) {
    const li = h('li', row.kind);
    const time = h('div', 'time', fmtClock(row.t));
    time.append(h('small', '', row.kind === 'start' ? '出発' : row.kind === 'rest' ? '休憩' : '到着'));
    const body = h('div');
    body.append(h('div', 'name', row.kind === 'rest' ? `休憩 ${fmtMin(row.restMs! / 60_000)}` : row.name));
    const p = state.shown!.points[row.index];
    const wx = row.kind === 'rest' ? null : recordedWxLine([p.lng, p.lat], row.t, p.ele);
    if (wx) body.append(wx);
    const l = row.leg;
    body.append(
      h(
        'div',
        'leg',
        l ? `${formatDistance(l.dist)} · ↑${Math.round(l.up)}m ↓${Math.round(l.down)}m · 所要 ${fmtHM(l.ms / 60_000)}${l.restMs >= 60_000 ? `（休憩 ${fmtHM(l.restMs / 60_000)}）` : ''}` : '',
      ),
    );
    li.append(time, h('div', 'dot'), body, h('div'));
    tl.append(li);
  }
}

export function renderCard(nav: Nav | null) {
  const card = $('card');
  card.replaceChildren();
  if (viewingTrack()) {
    renderActualCard(card);
    return;
  }
  if (nav && state.route) {
    const span = routeSpan(state.route);
    const title = h('div', 'nav-title');
    title.append(h('b', '', state.route.name), h('span', '', ` · ${state.route.label} · ${formatDistance(span.to - span.from)}`));
    card.append(title);
    if (walking(nav)) card.append(progressBar(nav, span));
    const { next, dest } = nav;
    if (next && dest && next !== dest) card.append(navRow('次', next, false, nav.sunset));
    if (dest) card.append(navRow('目的地', dest, true, nav.sunset));
    const sub = h('div', 'nav-sub');
    if (nav.rejoin && dest && !dest.passed) sub.append(h('span', '', `ルートに戻るまで約${fmtMin(nav.rejoin.totalMin)}を含む`));
    else if (!nav.onRoute && dest && !dest.passed) sub.append(h('span', '', settings.departAt && !recorder.recording ? `${departLabel(nav.startAt)}出発の場合` : '今出発した場合'));
    if (nav.pace && nav.pace.evidenceMin > 10) sub.append(h('span', '', `実績ペース 標準の${nav.pace.overall.toFixed(2)}倍`));
    else sub.append(h('span', '', `ペース「${PACE_PRESETS[settings.pace].label}」`));
    sub.append(h('span', '', `休憩込み`));
    const pop = maxPop(nav);
    if (pop != null) sub.append(h('span', pop >= 50 ? 'warn' : '', `降水確率 最大${Math.round(pop)}%`));
    if (nav.sunset) {
      const late = dest ? isLate(dest, nav.sunset) : false;
      sub.append(h('span', late ? 'warn' : '', `日没 ${fmtClock(nav.sunset)}${late ? '（要注意）' : ''}`));
    }
    card.append(sub);
    return;
  }
  if (state.shown) {
    const t = state.shown.track;
    const times = trackTimes(t);
    const tiles = h('div', 'tiles');
    for (const [label, value] of [
      ['時間', formatDuration((t.status === 'recording' ? Date.now() : times.end) - times.start)],
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

/** 次に行程表を描くとき、現在地の行まで送る（シートを開いたとき） */
let scrollToHere = false;

export function renderBody(nav: Nav | null) {
  const tl = $('timeline');
  tl.replaceChildren();
  const actions = $('plan-actions');
  actions.replaceChildren();
  const viewing = viewingTrack();
  $('sec-plan').hidden = !state.route && !viewing;
  $('plan-empty').hidden = !!state.route || viewing;
  $('depart-field').hidden = viewing;
  if (viewing) renderActualTimeline(tl);
  else if (nav && state.route && state.timeline) {
    const items: { time: number | null; passed: boolean; el: HTMLElement }[] = [];
    for (const row of nav.rows) {
      const li = h('li', `${row.mark.kind}${row.passed ? ' passed' : ''}${isLate(row, nav.sunset) ? ' late' : ''}`);
      const time = h('div', 'time', row.time ? fmtClock(row.time) : row.passed ? '✓' : '–');
      time.append(h('small', '', row.mark.kind === 'start' ? '出発' : row.passed ? (row.time ? '到着' : '通過') : '予想'));
      const body = h('div');
      body.append(h('div', 'name', row.mark.name));
      const wx = row.time ? wxLine(row.mark.lngLat, row.time) : null;
      if (wx) body.append(wx);
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
    const span = routeSpan(state.route);
    if (walking(nav)) {
      const at = items.findIndex((it) => !it.passed);
      items.splice(at < 0 ? items.length : at, 0, { time: Date.now(), passed: true, el: hereRow(nav, span) });
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
    if (scrollToHere) {
      // シートを開いたときは、現在地の行が見えるところまで送る
      const here = tl.querySelector('li.here');
      if (here) requestAnimationFrame(() => here.scrollIntoView({ block: 'center' }));
    }
    const total = estimate(state.timeline, span.from, span.to, nav.factors);
    const sum = h('p', 'note');
    sum.textContent = `全行程 ${formatDistance(span.to - span.from)}・標準 ${fmtHM(total.stdMin)}・このペースで 歩行 ${fmtHM(total.movingMin)} ＋ 休憩 ${fmtHM(total.restMin)}${state.route.straightLegs ? '・一部直線区間あり' : ''}`;
    tl.append(sum);
    const btn = (label: string, fn: () => void, cls = '') => {
      const b = h('button', `btn ${cls}`, label);
      b.type = 'button';
      b.addEventListener('click', fn);
      actions.append(b);
      return b;
    };
    if (state.route.kind === 'gpx') btn('道沿いのルート候補を探す', () => void searchAlternativesForGpx(), 'primary');
    // 記録中は行程の向きを変えない（歩いた分の到着予想が崩れるため）
    if (!recorder.recording) btn('逆向き（帰り道）にする', reverseCurrentRoute);
    // 出発時刻・ペースの到着予想どおりに歩くリプレイ（予報の雨・雲も出す）。長押しで録画しながら
    if (!recorder.recording) onLongPress(btn('計画をリプレイ', () => replayPlan()), () => replayPlan({ capture: true }));
    btn('GPXで保存', exportRoute);
    btn('ルートを消す', clearRoute, 'danger');
  }
  renderDeparture();
  renderTrimEditor();

  updateProfile(nav);

  // これまでのペース
  const grid = $('pace-grid');
  grid.replaceChildren();
  // 記録中はその記録、地図に表示中の保存した記録はその記録を、歩き終えた時点で分析する
  const p =
    nav?.pace ??
    (recorder.recording
      ? paceOf(recorder.state.points)
      : state.shown && state.shown.points.length > 1
        ? paceOf(state.shown.points, true)
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

const pad2 = (n: number) => String(n).padStart(2, '0');
/** "HH:MM" */
const hhmm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
/** "YYYY-MM-DD"（端末の日付） */
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** 日付を選んだ出発か（時刻だけなら日付は自動） */
const dateChosen = () => !!settings.departAt && DEPART_DATE_TIME.test(settings.departAt);

/**
 * 行程の「出発」：「今すぐ」なら日付・時刻の欄は今。時刻を変えると「今すぐ」が外れる（日付は自動：今より6時間以上前なら明日）。
 * 日付を選ぶと、その日の出発にする
 */
function renderDeparture() {
  const now = !settings.departAt || recorder.recording;
  const btn = $<HTMLButtonElement>('depart-now');
  btn.setAttribute('aria-pressed', String(now));
  btn.disabled = recorder.recording;
  const dep = new Date(now ? Date.now() : departureTime());
  const date = $<HTMLInputElement>('depart-date');
  date.disabled = recorder.recording;
  date.min = ymd(new Date());
  if (document.activeElement !== date) date.value = ymd(dep);
  const input = $<HTMLInputElement>('depart-time');
  input.disabled = recorder.recording;
  if (document.activeElement !== input) input.value = hhmm(dep);
  $('depart-note').textContent = recorder.recording
    ? '記録中は現在時刻から到着予想を出します'
    : !now && !dateChosen() && daysFromToday(dep.getTime()) === 1
      ? '今より前の時刻なので、明日の出発として予想しています'
      : !now && settings.weather
        ? forecastNote(dep.getTime(), state.lastNav?.dest?.time ?? dep.getTime())
        : '';
}

/** 選んだ出発の天気予報の注意：予報が切れている（1週間より先）・途中で切れる・先の日で確かさが下がる */
function forecastNote(depart: number, arrive: number): string {
  const horizon = forecastHorizon();
  if (depart > horizon) return `天気予報は${departLabel(horizon)}までなので、この日の天気は出ません`;
  if (arrive > horizon) return `天気予報は${departLabel(horizon)}までなので、それより後の地点の天気は出ません`;
  if (depart - Date.now() > 3 * 86_400_000) return '3日より先の天気予報は、確かさが下がります';
  return '';
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
  if (open) {
    scrollToHere = true;
    renderBody(state.lastNav);
    scrollToHere = false;
  } else src('cursor')?.setData(emptyFC);
});
export function openSheet() {
  if (!sheet.isOpen) sheet.setOpen(true);
}
$('btn-fit').addEventListener('click', () => {
  if (viewingTrack()) fitTo(state.shown!.points.map((p): LngLat => [p.lng, p.lat]));
  else if (state.route) fitTo(state.route.coords);
});
$('depart-now').addEventListener('click', () => {
  // 外すときは、時刻欄に出ている時刻を出発時刻にする
  settings.departAt = settings.departAt ? null : $<HTMLInputElement>('depart-time').value || hhmm(new Date());
  saveSettings();
  updateNav();
});
$<HTMLInputElement>('depart-time').addEventListener('change', (e) => {
  const v = (e.target as HTMLInputElement).value;
  if (!DEPART_TIME.test(v)) return;
  // 日付を選んでいればその日のまま、そうでなければ時刻だけ（日付は自動）
  settings.departAt = dateChosen() ? `${settings.departAt!.slice(0, 10)}T${v}` : v;
  saveSettings();
  updateNav();
});
$<HTMLInputElement>('depart-date').addEventListener('change', (e) => {
  const v = (e.target as HTMLInputElement).value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
  const time = $<HTMLInputElement>('depart-time').value;
  settings.departAt = `${v}T${DEPART_TIME.test(time) ? time : hhmm(new Date())}`;
  saveSettings();
  updateNav();
});
