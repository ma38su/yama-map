/**
 * 記録の始めと終わり：開いている記録の地図の「開始」「終了」の印と範囲の外の線、行程タブの「記録の始めと終わり」の欄、
 * 記録を終えたときの「止まっていた時間を除きますか？」の確認。点は消さず、記録の範囲（track.trim）だけを変える（../track/trim.ts）
 */
import { Marker } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { bisect, formatDistance, type LngLat } from '../geo';
import { putTrack, type Track, type TrackPoint } from '../track/db';
import { applyTrim, detectIdle, shownOf, suggestedRange, summarize, trackTimes, type IdleSuggestion, type TrimRange } from '../track/trim';
import { $, fmtClock, fmtM, fmtMin, h, setText } from '../ui/dom';
import { emptyFC, lineFC, map, setSourceData } from './mapView';
import { refreshTrackList } from './tracks';
import { updateNav } from './nav';
import { recorder, renderTrack, updateRecButton, viewingTrack } from './recording';
import { stopReplay } from './replay';
import { state } from './state';
import { status } from './status';

/** 調整中の範囲（全部の点の番号）。key は記録と保存した範囲（変わったら作り直す） */
let draft: { key: string; start: number; end: number; idle: IdleSuggestion | null } | null = null;

const keyOf = (t: Track, all: TrackPoint[]) => `${t.id}:${all.length}:${t.trim?.start ?? ''}:${t.trim?.end ?? ''}`;

/** 保存した範囲の、全部の点の番号（始めは範囲の始めの時刻から後の最初の点、終わりは範囲の終わりの時刻までの最後の点） */
function savedIndices(t: Track, all: TrackPoint[]): { start: number; end: number } {
  const time = (i: number) => all[i].t;
  let start = 0;
  if (t.trim?.start != null) {
    // 時刻はミリ秒の整数なので、「始めの時刻より前の最後の点」の次が、始めの時刻から後の最初の点
    const i = bisect(all.length, time, t.trim.start - 1) + 1;
    start = i < all.length ? i : 0;
  }
  const end = t.trim?.end != null ? Math.max(0, bisect(all.length, time, t.trim.end)) : all.length - 1;
  return { start, end: Math.max(start, end) };
}

/** 範囲を変えられる記録（開いている保存した記録。最初から入れてある「予定」は除く） */
function editable(): { track: Track; all: TrackPoint[] } | null {
  const shown = state.shown;
  if (!shown || !viewingTrack() || shown.track.id.startsWith('plan-') || shown.all.length < 3) return null;
  return { track: shown.track, all: shown.all };
}

/** 調整中の範囲（開いている記録が変わった・保存したら、保存した範囲から作り直す） */
function currentDraft() {
  const e = editable();
  if (!e) {
    draft = null;
    return null;
  }
  const key = keyOf(e.track, e.all);
  if (draft?.key !== key) draft = { key, ...savedIndices(e.track, e.all), idle: detectIdle(e.all, e.track.startedAt, e.track.endedAt) };
  return { ...e, d: draft };
}

// ---------- 地図 ----------
/** 範囲の始めと終わりの印。作り直さずに持ち続け、位置と札の時刻だけ変える（つまみを動かすあいだは何度も動かすため） */
interface EndMarker {
  kind: 'start' | 'end';
  marker: Marker;
  tag: HTMLElement;
  onMap: boolean;
}
function endMarker(kind: 'start' | 'end'): EndMarker {
  const el = h('div', `trk-end ${kind}`);
  const tag = h('div', 'tag');
  el.append(h('div', 'pin'), tag);
  // 札は印の右に（ルートの出発地・目的地の札は印の下なので、重ならないように）
  return { kind, marker: new Marker({ element: el, anchor: 'left', offset: [-7, 0] }), tag, onMap: false };
}
const ends = [endMarker('start'), endMarker('end')] as const;
/** 印を点 p に置く（null なら外す） */
function placeEnd(m: EndMarker, p: TrackPoint | null) {
  if (!p) {
    if (m.onMap) m.marker.remove();
    m.onMap = false;
    return;
  }
  m.marker.setLngLat([p.lng, p.lat]);
  setText(m.tag, `${m.kind === 'start' ? '開始' : '終了'} ${fmtClock(p.t)}`);
  if (!m.onMap) m.marker.addTo(map);
  m.onMap = true;
}

const coordsOf = (pts: TrackPoint[]) => pts.map((p): LngLat => [p.lng, p.lat]);

/**
 * 記録の線を描く。開いている記録は、調整中の範囲を赤い線に、範囲の外を灰色の点線にして、始めと終わりに印を置く。
 * 記録中は全部の点を赤い線に
 */
export function drawTrackLine() {
  const cur = currentDraft();
  if (!cur) {
    for (const m of ends) placeEnd(m, null);
    setSourceData('track', lineFC(coordsOf(state.shown?.points ?? [])));
    // 範囲の外の線は、ふだん空のまま（記録中に30秒ごとに空を入れ直さないよう、setSourceData で）
    setSourceData('track-out', emptyFC);
    return;
  }
  const { all, d } = cur;
  setSourceData('track', lineFC(coordsOf(all.slice(d.start, d.end + 1))));
  const outside = [all.slice(0, d.start + 1), all.slice(d.end)].filter((s) => s.length > 1).map(coordsOf);
  const fc: FeatureCollection = outside.length
    ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: outside } }] }
    : emptyFC;
  setSourceData('track-out', fc);
  placeEnd(ends[0], all[d.start]);
  placeEnd(ends[1], all[d.end]);
}

// ---------- 行程タブの欄 ----------
const sec = $('sec-trim');
const startInput = $<HTMLInputElement>('trim-start');
const endInput = $<HTMLInputElement>('trim-end');
const saveBtn = $<HTMLButtonElement>('trim-save');
const autoBtn = $<HTMLButtonElement>('trim-auto');
const fullBtn = $<HTMLButtonElement>('trim-full');

/** 止まっていた時間の説明「出発前に約20分、到着後に約2時間10分」 */
function idleText(s: IdleSuggestion): string {
  const parts = [];
  if (s.start != null) parts.push(`出発前に約${fmtMin(s.startIdleMs / 60_000)}`);
  if (s.end != null) parts.push(`到着後に約${fmtMin(s.endIdleMs / 60_000)}`);
  return parts.join('、');
}

/** 範囲の要約「7:20 → 9:05・所要 1時間45分・5.89 km・登り 420m」 */
function rangeText(all: TrackPoint[], start: number, end: number, track: Track): string {
  const pts = all.slice(start, end + 1);
  const sum = summarize(pts);
  const t0 = start === 0 ? Math.min(track.startedAt, all[0].t) : all[start].t;
  const t1 = end === all.length - 1 ? Math.max(track.endedAt ?? 0, all[end].t) : all[end].t;
  return `${fmtClock(t0)} → ${fmtClock(t1)}・所要 ${fmtMin((t1 - t0) / 60_000)}・${formatDistance(sum.distance)}・登り ${fmtM(sum.ascent)}`;
}

/** 欄を今の記録・調整中の範囲に合わせる（シートを描くたび・つまみを動かすたび） */
export function renderTrimEditor() {
  const cur = currentDraft();
  sec.hidden = !cur;
  if (!cur) return;
  const { track, all, d } = cur;
  for (const input of [startInput, endInput]) input.max = String(all.length - 1);
  startInput.value = String(d.start);
  endInput.value = String(d.end);
  $('trim-start-out').textContent = fmtClock(d.start === 0 ? Math.min(track.startedAt, all[0].t) : all[d.start].t);
  $('trim-end-out').textContent = fmtClock(d.end === all.length - 1 ? Math.max(track.endedAt ?? 0, all[d.end].t) : all[d.end].t);
  const saved = savedIndices(track, all);
  const changed = saved.start !== d.start || saved.end !== d.end;
  $('trim-info').textContent = `${rangeText(all, d.start, d.end, track)}${changed ? '（まだ保存していません）' : ''}`;
  const suggest = $('trim-suggest');
  suggest.hidden = !d.idle;
  if (d.idle) suggest.textContent = `${idleText(d.idle)}、ほとんど動いていません。`;
  autoBtn.hidden = !d.idle;
  if (d.idle) {
    const r = suggestedRange(all, d.idle);
    const idx = savedIndices({ ...track, trim: r }, all);
    autoBtn.disabled = idx.start === d.start && idx.end === d.end;
  }
  fullBtn.disabled = d.start === 0 && d.end === all.length - 1;
  saveBtn.disabled = !changed;
}

/** 範囲を動かしたあと、地図と欄に出すのを待っている requestAnimationFrame */
let moveRaf = 0;
/**
 * 調整中の範囲を動かして、地図と欄に出す（まだ保存しない）。つまみを動かすと input は1コマに何度も来るので、
 * 地図の線（setData）と欄の要約（範囲の点を数え直す）は1コマに1回だけ
 */
function moveDraft(start: number, end: number) {
  const cur = currentDraft();
  if (!cur) return;
  const last = cur.all.length - 1;
  cur.d.start = Math.max(0, Math.min(start, last - 1));
  cur.d.end = Math.max(cur.d.start + 1, Math.min(end, last));
  moveRaf ||= requestAnimationFrame(() => {
    moveRaf = 0;
    drawTrackLine();
    renderTrimEditor();
  });
}

startInput.addEventListener('input', () => {
  const v = Number(startInput.value);
  moveDraft(Math.min(v, Number(endInput.value) - 1), draft?.end ?? v + 1);
});
endInput.addEventListener('input', () => {
  const v = Number(endInput.value);
  moveDraft(draft?.start ?? 0, Math.max(v, Number(startInput.value) + 1));
});
autoBtn.addEventListener('click', () => {
  const cur = currentDraft();
  if (!cur?.d.idle) return;
  const idx = savedIndices({ ...cur.track, trim: suggestedRange(cur.all, cur.d.idle) }, cur.all);
  moveDraft(idx.start, idx.end);
});
fullBtn.addEventListener('click', () => {
  const cur = currentDraft();
  if (cur) moveDraft(0, cur.all.length - 1);
});
saveBtn.addEventListener('click', () => {
  const cur = currentDraft();
  if (!cur) return;
  const { all, d } = cur;
  void saveRange(cur.track, all, { start: all[d.start].t, end: all[d.end].t });
});

/** 範囲を保存して、開いている記録の表示（地図・行程・グラフ・ペース・一覧）を新しい範囲にする */
async function saveRange(track: Track, all: TrackPoint[], range: TrimRange) {
  const updated = applyTrim(track, all, range);
  try {
    await putTrack(updated);
  } catch (e) {
    console.error('記録の範囲を保存できませんでした', e);
    status('記録の範囲を保存できませんでした', true);
    return;
  }
  stopReplay();
  // 記録のルートは表示し直しても残す（下の clear で表示中の記録がいったん空になるので、先に覚えておく）
  const route = state.shown?.route;
  // 終えたばかりの記録は、記録の仕組みから離してから表示し直す（あとから古い範囲で上書きされないように）
  if (!recorder.recording && recorder.state.track?.id === updated.id) recorder.clear();
  state.shown = { ...shownOf(updated, all), route };
  state.revision++;
  draft = null;
  renderTrack();
  updateRecButton();
  updateNav();
  void refreshTrackList();
  const times = trackTimes(updated);
  status(
    updated.trim
      ? `記録の範囲を ${fmtClock(times.start)} 〜 ${fmtClock(times.end)} にしました（${formatDistance(updated.distance)}）。点は残してあります`
      : `記録の範囲を全体に戻しました（${formatDistance(updated.distance)}）`,
  );
}

/**
 * 記録を終えたとき、出発前・到着後にほとんど動いていなかった時間があれば、除くか聞く。
 * 画面が裏にあるとき（通知の「停止」で終えたとき）は聞かない（行程タブの欄でいつでも変えられる）
 */
export function offerTrim(track: Track) {
  if (document.visibilityState !== 'visible' || track.id.startsWith('plan-')) return;
  const shown = state.shown;
  if (!shown || shown.track.id !== track.id) return;
  const all = shown.all;
  // 止まっていた時間は、範囲の欄（調整中の範囲）を作ったときに求めてある
  const idle = currentDraft()?.d.idle;
  if (!idle) return;
  const range = suggestedRange(all, idle);
  const times = trackTimes({ ...track, trim: range });
  const change = [
    range.start != null ? `始めを ${fmtClock(times.start)}` : '',
    range.end != null ? `終わりを ${fmtClock(times.end)}` : '',
  ].filter(Boolean);
  // 「記録を保存しました」を出してから聞く
  setTimeout(() => {
    if (state.shown?.track.id !== track.id) return;
    const ok = confirm(
      `${idleText(idle)}、ほとんど動いていません。\n記録の${change.join('、')}にしますか？\n（点は消さずに残します。「行程」タブの下で、いつでも変えたり戻したりできます）`,
    );
    if (ok) void saveRange(state.shown.track, state.shown.all, range);
  }, 400);
}
