/** 右下のメニュー：ルートの読み込み、設定（ルートの探し方・ペース・地図）、記録の一覧 */
import { distance, formatDistance, formatDuration, type LngLat } from '../geo';
import { BASE_LAYERS, TERRAIN_EXAGGERATION_RANGE, setBaseLayer, setHillshade, type BaseLayerId } from '../map/style';
import { PACE_PRESETS, type PacePreset } from '../nav/eta';
import { ROUTE_PREFS, buildGpxRoute, makePoint, type RoutePref } from '../nav/plan';
import { LockedTrackError, countPhotos, deleteTrack, getPoints, listTracks, putTrackWithPoints, type Track } from '../track/db';
import { parseGpx, toGpx } from '../track/gpx';
import { backgroundCapable } from '../track/location';
import { trackFullName, trackTitle, trackWhen } from '../track/names';
import { generateSampleTrack } from '../track/sample';
import { pointsIn, shownOf, trackTimes } from '../track/trim';
import { saveSettings, settings } from '../settings';
import { $, checkSeg, download, fileStamp, fmtM, h, segButtons } from '../ui/dom';
import { elevation, fitTo, map, setTerrainExaggeration, updateDaylight } from './mapView';
import { updateNav } from './nav';
import { refreshStorage } from './offline';
import { setProfileSource } from './profileView';
import { closeTrack, fillShownElevations, recorder, renderTrack, stopGeolocate, updateRecButton } from './recording';
import { stopReplay } from './replay';
import { refreshBattery } from './battery';
import { applyRoutePref, loadGpxText, rebuild, reverseCurrentRoute, setRoute } from './route';
import { openSheet, setTab } from './sheetView';
import { state } from './state';
import { setProgress, status } from './status';
import { nameUnnamedTracks, relabelTrack } from './trackNames';

const paceSeg = $('pace-preset');
segButtons(paceSeg, Object.entries(PACE_PRESETS).map(([id, def]) => [id, def.label] as const), (id) => {
  settings.pace = id as PacePreset;
  saveSettings();
  syncMenu();
  updateNav();
});

export const menu = $<HTMLDialogElement>('menu');
$('btn-menu').addEventListener('click', () => {
  void refreshTrackList();
  void refreshStorage();
  void refreshBattery();
  menu.showModal();
});
menu.addEventListener('click', (e) => {
  if (e.target === menu) menu.close(); // 背景タップで閉じる
});

export const PRESETS = [
  {
    file: 'routes/okukinu-teshirosawa.gpx',
    title: '女夫渕 → 手白澤温泉',
    desc: '奥鬼怒歩道・八丁の湯・加仁湯経由 約6km',
  },
  {
    file: 'routes/okukinu-teshirosawa.gpx',
    title: '手白澤温泉 → 女夫渕',
    desc: '帰り道。加仁湯・八丁の湯経由 約6km',
    reverse: true,
  },
  {
    file: 'routes/okukinu-nikkozawa.gpx',
    title: '女夫渕 → 日光澤温泉',
    desc: '奥鬼怒歩道・八丁の湯・加仁湯経由 約5km',
  },
  {
    file: 'routes/okukinu-nikkozawa.gpx',
    title: '日光澤温泉 → 女夫渕',
    desc: '帰り道。加仁湯・八丁の湯経由 約5km',
    reverse: true,
  },
];
const presetWrap = $('preset-routes');
for (const p of PRESETS) {
  const b = h('button', 'btn block');
  b.type = 'button';
  b.append(h('span', '', p.title), h('small', '', p.desc));
  b.addEventListener('click', async () => {
    menu.close();
    try {
      setProgress('ルートを読み込み中…');
      const res = await fetch(p.file);
      if (!res.ok) throw new Error('ルートを読み込めませんでした');
      const text = await res.text();
      // まずは道データからルート候補を作る（登山道優先・別ルートなどを比べられる）。
      // 圏外などで作れなければ、保存してあるGPXのルートを使う（帰り道は逆向きにする）
      const gpx = parseGpx(text);
      const pts = gpx.lines.flatMap((l) => l.points);
      const named = (i: number) => gpx.waypoints.find((w) => distance([w.lng, w.lat], [pts[i].lng, pts[i].lat]) < 100)?.name;
      const ends = [0, pts.length - 1];
      if (p.reverse) ends.reverse();
      const [from, to] = ends.map((i) => ({ lngLat: [pts[i].lng, pts[i].lat] as LngLat, name: named(i) }));
      setRoute(null);
      await rebuild([makePoint('start', from.lngLat, from.name), makePoint('dest', to.lngLat, to.name)]);
      if (!state.route) {
        await loadGpxText(text);
        if (p.reverse) reverseCurrentRoute();
      }
      openSheet();
    } catch (err) {
      status(err instanceof Error ? err.message : String(err), true);
    } finally {
      setProgress('');
    }
  });
  presetWrap.append(b);
}

$<HTMLInputElement>('gpx-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  menu.close();
  try {
    setProgress('GPXを読み込み中…');
    await loadGpxText(await file.text());
    openSheet();
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  } finally {
    setProgress('');
  }
});

const routePrefWrap = $('route-pref');
segButtons(routePrefWrap, Object.entries(ROUTE_PREFS).map(([id, def]) => [id, def.label] as const), (id) => {
  settings.routePref = id as RoutePref;
  saveSettings();
  syncMenu();
  applyRoutePref();
});
const baseWrap = $('base-layers');
segButtons(baseWrap, Object.entries(BASE_LAYERS).map(([id, def]) => [id, def.label] as const), (id) => {
  settings.base = id as BaseLayerId;
  saveSettings();
  setBaseLayer(map, settings.base);
  syncMenu();
});
const hillshadeOpt = $<HTMLInputElement>('opt-hillshade');
hillshadeOpt.addEventListener('change', () => {
  settings.hillshade = hillshadeOpt.checked;
  saveSettings();
  setHillshade(map, settings.hillshade);
});
const weatherOpt = $<HTMLInputElement>('opt-weather');
weatherOpt.addEventListener('change', () => {
  settings.weather = weatherOpt.checked;
  saveSettings();
  syncMenu();
  updateDaylight();
  updateNav();
});
const weatherFxOpt = $<HTMLInputElement>('opt-weatherfx');
weatherFxOpt.addEventListener('change', () => {
  settings.weatherFx = weatherFxOpt.checked;
  saveSettings();
  updateDaylight();
});
const dayToneOpt = $<HTMLInputElement>('opt-daytone');
dayToneOpt.addEventListener('change', () => {
  settings.dayTone = dayToneOpt.checked;
  saveSettings();
  updateDaylight();
});
const terrainEx = $<HTMLInputElement>('opt-terrain-ex');
terrainEx.min = String(TERRAIN_EXAGGERATION_RANGE.min);
terrainEx.max = String(TERRAIN_EXAGGERATION_RANGE.max);
terrainEx.step = String(TERRAIN_EXAGGERATION_RANGE.step);
const showTerrainEx = () => ($('terrain-ex-value').textContent = `×${settings.terrainExaggeration.toFixed(1)}`);
terrainEx.addEventListener('input', () => {
  setTerrainExaggeration(Number(terrainEx.value));
  showTerrainEx();
});
const offRouteOpt = $<HTMLInputElement>('opt-offroute');
offRouteOpt.addEventListener('change', () => {
  settings.offRouteAlert = offRouteOpt.checked;
  saveSettings();
});
const wakeOpt = $<HTMLInputElement>('opt-wakelock');
if (backgroundCapable) {
  $('wakelock-note').textContent = 'アプリ版は画面を消しても記録が続きます。点けたままにすると電池の減りが早くなります。';
}
wakeOpt.addEventListener('change', () => {
  settings.wakeLock = wakeOpt.checked;
  saveSettings();
  void recorder.setKeepScreenOn(settings.wakeLock);
});
function syncMenu() {
  checkSeg(baseWrap, settings.base);
  checkSeg(paceSeg, settings.pace);
  checkSeg(routePrefWrap, settings.routePref);
  $('route-pref-note').textContent = ROUTE_PREFS[settings.routePref].desc;
  hillshadeOpt.checked = settings.hillshade;
  dayToneOpt.checked = settings.dayTone;
  weatherOpt.checked = settings.weather;
  weatherFxOpt.checked = settings.weatherFx;
  wakeOpt.checked = settings.wakeLock;
  offRouteOpt.checked = settings.offRouteAlert;
  terrainEx.value = String(settings.terrainExaggeration);
  showTerrainEx();
}
syncMenu();

/** 最初から入れておく「予定」の記録：おすすめルートを今日の11:30から、ゆっくりのペースで歩き、歩行30分ごとに5分休む */
const BUILTIN_PLAN = { id: 'plan-okukinu-teshirosawa', start: [11, 30], pace: 'slow', restEveryMin: 30, restMin: 5 } as const;

/**
 * 初めて起動したときに「予定」の記録を作って保存する（ルートの標高を地理院の標高タイルから取るので、
 * 圏外で作れなければ次に起動したときにもう一度試す）。以前の版の「サンプル」の記録はこれに置き換える
 */
export async function ensureBuiltinPlan() {
  if (settings.builtinPlan) return;
  const preset = PRESETS[0];
  try {
    const res = await fetch(preset.file);
    if (!res.ok) return;
    const r = await buildGpxRoute(parseGpx(await res.text()), elevation);
    const start = new Date();
    start.setHours(BUILTIN_PLAN.start[0], BUILTIN_PLAN.start[1], 0, 0);
    const pace = PACE_PRESETS[BUILTIN_PLAN.pace];
    const { track, points } = generateSampleTrack(r.coords, r.eles, {
      startMs: start.getTime(),
      name: `予定：${preset.title}（${pace.label}・${BUILTIN_PLAN.restEveryMin}分ごとに${BUILTIN_PLAN.restMin}分休憩）`,
      seed: 1130,
      pace: pace.factor,
      restEveryMin: BUILTIN_PLAN.restEveryMin,
      restMin: [BUILTIN_PLAN.restMin, BUILTIN_PLAN.restMin],
    });
    await putTrackWithPoints({ ...track, id: BUILTIN_PLAN.id, route: preset.title }, points.map((p) => ({ ...p, trackId: BUILTIN_PLAN.id })));
    for (const t of await listTracks()) if (t.id.startsWith('sample-')) await deleteTrack(t.id).catch(() => {}); // ロックしていれば残す
    settings.builtinPlan = true;
    saveSettings();
    await refreshTrackList();
  } catch (err) {
    console.warn('予定の記録を作れませんでした', err);
  }
}

export async function refreshTrackList() {
  const list = $('track-list');
  const tracks = await listTracks().catch(() => [] as Track[]);
  list.replaceChildren(...tracks.map(trackItem));
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
    h('div', 'meta', `${trackWhen(t)}・${formatDuration(times.end - times.start)}・${formatDistance(t.distance)}・登り ${fmtM(t.ascent)}${recording ? '・記録中' : ''}`),
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
    state.revision++;
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
  menu.close();
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
