/**
 * 下のバーの「記録」ボタンと、その画面：これまでの記録の一覧（地図に表示・GPX 書き出し・経路名・ロック・削除）。
 * 記録をまとめて書き出す・読み込む（transfer.ts）もここ
 */
import { formatDistance, formatDuration } from '../geo';
import { LockedTrackError, countPhotos, deleteTrack, getPoints, listTracks, type Track } from '../track/db';
import { toGpx } from '../track/gpx';
import { trackFullName, trackTitle, trackWhen } from '../track/names';
import { pointsIn, shownOf, trackTimes } from '../track/trim';
import { $, download, fileStamp, fmtM, h } from '../ui/dom';
import { fitTo } from './mapView';
import { updateNav } from './nav';
import { setProfileSource } from './profileView';
import { closeTrack, fillShownElevations, recorder, renderTrack, stopGeolocate, updateRecButton } from './recording';
import { stopReplay } from './replay';
import { setTab } from './sheetView';
import { state } from './state';
import { status } from './status';
import { nameUnnamedTracks, relabelTrack } from './trackNames';

const dialog = $<HTMLDialogElement>('tracks');
$('btn-tracks').addEventListener('click', () => {
  dialog.showModal();
  void refreshTrackList();
});
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close(); // 背景タップで閉じる
});

/** 記録の画面の一覧を作り直す。閉じていれば何もしない（開くときに必ず作るので。記録を終えたときなどに呼ばれる） */
export async function refreshTrackList() {
  if (!dialog.open) return;
  const list = $('track-list');
  const tracks = await listTracks().catch(() => [] as Track[]);
  list.replaceChildren(...tracks.map(trackItem));
  $('track-empty').hidden = tracks.length > 0;
  $('track-plan-note').hidden = !tracks.some((t) => t.id.startsWith('plan-'));
  // 経路名のない記録（前の版の記録など）に、近くの山小屋・温泉などの名前で経路名を付ける
  if (await nameUnnamedTracks(tracks).catch(() => false)) await refreshTrackList();
}

/** 一覧の1件：経路名とロック、日時・所要・距離、ボタン */
function trackItem(t: Track): HTMLElement {
  const li = h('li', t.locked ? 'locked' : '');
  const recording = t.status === 'recording';
  const times = trackTimes(t);
  const head = h('div', 'trk-head');
  const lock = h('button', 'lock-btn', t.locked ? '🔒 ロック中' : '🔓 ロック');
  lock.type = 'button';
  lock.setAttribute('aria-pressed', String(!!t.locked));
  lock.title = t.locked ? 'ロックを外す' : 'ロックする（削除できなくする）';
  lock.addEventListener('click', () => void setLocked(t, !t.locked));
  head.append(h('div', 'title', trackTitle(t)), lock);
  li.append(
    head,
    h(
      'div',
      'meta',
      `${trackWhen(t)}・${formatDuration(times.end - times.start)}・${formatDistance(t.distance)}・登り ${fmtM(t.ascent)}${t.steps ? `・${t.steps.toLocaleString('ja-JP')}歩` : ''}${recording ? '・記録中' : ''}`,
    ),
  );
  const row = h('div', 'row');
  const btn = (label: string, fn: () => void, cls = '') => {
    const b = h('button', `btn ${cls}`, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    row.append(b);
    return b;
  };
  btn('地図に表示', () => void showSavedTrack(t)).disabled = recorder.recording;
  btn('GPX書き出し', () => void exportTrack(t));
  btn('経路名', () => editRoute(li, t));
  const del = btn('削除', () => void removeTrack(t), 'danger');
  del.disabled = recording || !!t.locked;
  if (t.locked) del.title = 'ロック中は削除できません';
  li.append(row);
  return li;
}

/** ロックする・外す */
async function setLocked(t: Track, locked: boolean) {
  try {
    await relabelTrack(t.id, { locked });
  } catch (e) {
    console.error('ロックを保存できませんでした', e);
    status('ロックを保存できませんでした', true);
  }
  await refreshTrackList();
}

/**
 * 経路名をその場で変える（題の代わりに入力欄を出す。空にして保存すると経路名なし＝記録の名前を出す）。
 * prompt() はアプリ版で今の名前が入らない（Capacitor が初めの値を使わない）ので使わない
 */
function editRoute(li: HTMLElement, t: Track) {
  if (li.querySelector('.trk-rename')) return;
  const form = h('form', 'trk-rename');
  const input = h('input', 'search-q');
  input.type = 'text';
  input.value = t.route ?? '';
  input.placeholder = '例：女夫渕 → 手白澤温泉';
  input.maxLength = 80;
  input.enterKeyHint = 'done';
  input.setAttribute('aria-label', '経路名');
  const save = h('button', 'btn primary', '保存');
  save.type = 'submit';
  const cancel = h('button', 'btn', 'やめる');
  cancel.type = 'button';
  const row = h('div', 'row');
  row.append(save, cancel);
  form.append(input, h('div', 'note', '空にして保存すると経路名なし（記録の名前を出す）'), row);
  const head = li.querySelector('.trk-head')!;
  head.after(form);
  head.setAttribute('hidden', '');
  cancel.addEventListener('click', () => {
    form.remove();
    head.removeAttribute('hidden');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void renameTrack(t, input.value.trim());
  });
  input.focus();
  input.select();
}

/** 経路名を保存する */
async function renameTrack(t: Track, route: string) {
  if (route !== (t.route ?? '')) {
    try {
      await relabelTrack(t.id, { route });
    } catch (e) {
      console.error('経路名を保存できませんでした', e);
      status('経路名を保存できませんでした', true);
      return;
    }
    // 描き直すだけ（点で決まるペース・実績・グラフの覚えは経路名を使わないので、revision は上げない）
    updateNav();
  }
  await refreshTrackList();
}

/** 記録を削除する（何を消すかを見せて確かめてから。ロック中は消さない） */
async function removeTrack(t: Track) {
  if (t.locked || t.status === 'recording') return;
  const photos = await countPhotos(t.id).catch(() => 0);
  const what = `「${trackTitle(t)}」\n${trackWhen(t)}・${formatDistance(t.distance)}${photos ? `・写真 ${photos}枚` : ''}`;
  if (!confirm(`${what}\n\nこの記録を削除しますか？\n点${photos ? 'と写真' : ''}もいっしょに消え、元に戻せません。`)) return;
  try {
    await deleteTrack(t.id);
  } catch (e) {
    console.error('記録を削除できませんでした', e);
    status(e instanceof LockedTrackError ? e.message : '記録を削除できませんでした', true);
    await refreshTrackList();
    return;
  }
  if (state.shown?.track.id === t.id) closeTrack();
  status(`「${trackTitle(t)}」を削除しました`);
  await refreshTrackList();
}

async function showSavedTrack(t: Track) {
  if (recorder.recording) return;
  stopReplay();
  recorder.clear();
  const all = await getPoints(t.id);
  state.shown = shownOf(t, all);
  const points = state.shown.points;
  setProfileSource('track');
  stopGeolocate();
  renderTrack();
  updateRecButton();
  dialog.close();
  setTab('profile');
  fitTo(points.map((p) => [p.lng, p.lat]));
  updateNav();
  void fillShownElevations();
}

/** 記録を GPX で書き出す（記録の範囲を変えていれば、その中だけ） */
async function exportTrack(t: Track) {
  const points = pointsIn(await getPoints(t.id), t.trim);
  const gpx = toGpx(
    trackFullName(t),
    points.map((p) => ({ lng: p.lng, lat: p.lat, ele: p.ele ?? p.alt ?? undefined, time: p.t })),
  );
  download(`yama-${fileStamp(t.startedAt)}.gpx`, gpx);
}
