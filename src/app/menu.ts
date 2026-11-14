/** 右下のメニュー：ルートの読み込み、設定（ルートの探し方・ペース・地図）、記録の一覧 */
import { distance, formatDistance, formatDuration } from '../geo';
import { BASE_LAYERS, setBaseLayer, setHillshade, type BaseLayerId } from '../map/style';
import { PACE_PRESETS, type PacePreset } from '../nav/eta';
import { ROUTE_PREFS, buildGpxRoute, makePoint, type RoutePref } from '../nav/plan';
import { deleteTrack, getPoints, listTracks, putTrackWithPoints, type Track } from '../track/db';
import { parseGpx, toGpx } from '../track/gpx';
import { generateSampleTrack } from '../track/sample';
import { saveSettings, settings } from '../settings';
import { $, download, fmtM, h } from '../ui/dom';
import { elevation, fitTo, map, updateDaylight } from './mapView';
import { updateNav } from './nav';
import { refreshStorage } from './offline';
import { setProfileSource } from './profileView';
import { recorder, renderTrack } from './recording';
import { applyRoutePref, loadGpxText, rebuild, setRoute } from './route';
import { openSheet, setTab } from './sheetView';
import { state } from './state';
import { setProgress, status } from './status';

const paceSeg = $('pace-preset');
for (const [id, def] of Object.entries(PACE_PRESETS) as [PacePreset, (typeof PACE_PRESETS)[PacePreset]][]) {
  const b = h('button', '', def.label);
  b.type = 'button';
  b.setAttribute('role', 'radio');
  b.dataset.id = id;
  b.addEventListener('click', () => {
    settings.pace = id;
    saveSettings();
    syncMenu();
    updateNav();
  });
  paceSeg.append(b);
}


export const menu = $<HTMLDialogElement>('menu');
$('btn-menu').addEventListener('click', () => {
  void refreshTrackList();
  void refreshStorage();
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
      // 圏外などで作れなければ、保存してあるGPXのルートを使う
      const gpx = parseGpx(text);
      const pts = gpx.lines.flatMap((l) => l.points);
      const named = (i: number) => gpx.waypoints.find((w) => distance([w.lng, w.lat], [pts[i].lng, pts[i].lat]) < 100)?.name;
      const a = pts[0];
      const b = pts[pts.length - 1];
      setRoute(null);
      await rebuild([makePoint('start', [a.lng, a.lat], named(0)), makePoint('dest', [b.lng, b.lat], named(pts.length - 1))]);
      if (!state.route) await loadGpxText(text);
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
for (const [id, def] of Object.entries(ROUTE_PREFS) as [RoutePref, (typeof ROUTE_PREFS)[RoutePref]][]) {
  const b = h('button', '', def.label);
  b.type = 'button';
  b.setAttribute('role', 'radio');
  b.dataset.id = id;
  b.addEventListener('click', () => {
    settings.routePref = id;
    saveSettings();
    syncMenu();
    applyRoutePref();
  });
  routePrefWrap.append(b);
}
const baseWrap = $('base-layers');
for (const [id, def] of Object.entries(BASE_LAYERS) as [BaseLayerId, (typeof BASE_LAYERS)[BaseLayerId]][]) {
  const b = h('button', '', def.label);
  b.type = 'button';
  b.setAttribute('role', 'radio');
  b.dataset.id = id;
  b.addEventListener('click', () => {
    settings.base = id;
    saveSettings();
    setBaseLayer(map, id);
    syncMenu();
  });
  baseWrap.append(b);
}
const hillshadeOpt = $<HTMLInputElement>('opt-hillshade');
hillshadeOpt.addEventListener('change', () => {
  settings.hillshade = hillshadeOpt.checked;
  saveSettings();
  setHillshade(map, settings.hillshade);
});
const dayToneOpt = $<HTMLInputElement>('opt-daytone');
dayToneOpt.addEventListener('change', () => {
  settings.dayTone = dayToneOpt.checked;
  saveSettings();
  updateDaylight();
});
const wakeOpt = $<HTMLInputElement>('opt-wakelock');
wakeOpt.addEventListener('change', () => {
  settings.wakeLock = wakeOpt.checked;
  saveSettings();
  void recorder.setKeepScreenOn(settings.wakeLock);
});
function syncMenu() {
  for (const b of baseWrap.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.id === settings.base));
  for (const b of paceSeg.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.id === settings.pace));
  for (const b of routePrefWrap.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.id === settings.routePref));
  $('route-pref-note').textContent = ROUTE_PREFS[settings.routePref].desc;
  hillshadeOpt.checked = settings.hillshade;
  dayToneOpt.checked = settings.dayTone;
  wakeOpt.checked = settings.wakeLock;
}
syncMenu();

/**
 * 記録のサンプルを作って保存する。おすすめルート（女夫渕 → 手白澤温泉）を、前日の8:30から
 * 標準タイムどおりに歩き、歩行30分ごとに5〜10分休んだ想定
 */
async function addSampleTrack() {
  const preset = PRESETS[0];
  try {
    setProgress('サンプルの記録を作成中…');
    const res = await fetch(preset.file);
    if (!res.ok) throw new Error('サンプルのルートを読み込めませんでした');
    const r = await buildGpxRoute(parseGpx(await res.text()), elevation);
    const start = new Date();
    start.setDate(start.getDate() - 1);
    start.setHours(8, 30, 0, 0);
    const label = `${start.getMonth() + 1}/${start.getDate()}`;
    const { track, points } = generateSampleTrack(r.coords, r.eles, {
      startMs: start.getTime(),
      name: `サンプル：${preset.title}（${label}）`,
      seed: start.getTime(),
    });
    await putTrackWithPoints(track, points);
    await refreshTrackList();
    status('サンプルの記録を追加しました。「地図に表示」で確認できます');
  } catch (err) {
    status(err instanceof Error ? err.message : String(err), true);
  } finally {
    setProgress('');
  }
}
$('btn-sample-track').addEventListener('click', () => void addSampleTrack());

export async function refreshTrackList() {
  const list = $('track-list');
  const tracks = await listTracks().catch(() => [] as Track[]);
  list.replaceChildren(
    ...tracks.map((t) => {
      const li = h('li');
      const date = new Date(t.startedAt);
      const dur = formatDuration((t.endedAt ?? Date.now()) - t.startedAt);
      li.append(
        h('div', 'title', t.name),
        h('div', 'meta', `${date.toLocaleDateString('ja-JP')}・${dur}・${formatDistance(t.distance)}・登り ${fmtM(t.ascent)}${t.status === 'recording' ? '・記録中' : ''}`),
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
      btn(
        '削除',
        async () => {
          if (!confirm(`「${t.name}」を削除しますか？`)) return;
          await deleteTrack(t.id);
          if (state.shown?.track.id === t.id) {
            recorder.clear();
            state.shown = null;
            renderTrack();
            updateNav();
          }
          await refreshTrackList();
        },
        'danger',
      ).disabled = t.status === 'recording';
      li.append(row);
      return li;
    }),
  );
}

async function showSavedTrack(t: Track) {
  if (recorder.recording) return;
  recorder.clear();
  const points = await getPoints(t.id);
  state.shown = { track: t, points };
  setProfileSource('track');
  renderTrack();
  menu.close();
  setTab('profile');
  fitTo(points.map((p) => [p.lng, p.lat]));
  updateNav();
}

async function exportTrack(t: Track) {
  const points = await getPoints(t.id);
  const gpx = toGpx(
    t.name,
    points.map((p) => ({ lng: p.lng, lat: p.lat, ele: p.ele ?? p.alt ?? undefined, time: p.t })),
  );
  const d = new Date(t.startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  download(`yama-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.gpx`, gpx);
}
