/** 右下のメニュー：ルートの読み込み、設定（ルートの探し方・ペース・地図・記録中の動き）。記録の一覧は tracks.ts の「記録」の画面 */
import { distance, type LngLat } from '../geo';
import { BASE_LAYERS, TERRAIN_EXAGGERATION_RANGE, setBaseLayer, setHillshade, type BaseLayerId } from '../map/style';
import { PACE_PRESETS, type PacePreset } from '../nav/eta';
import { ROUTE_PREFS, buildGpxRoute, makePoint, routeSnapshot, type RoutePref } from '../nav/plan';
import { appendPoints, deleteTrack, listTracks, putTrackRoute } from '../track/db';
import { parseGpx } from '../track/gpx';
import { backgroundCapable } from '../track/location';
import { generateSampleTrack } from '../track/sample';
import { saveSettings, settings } from '../settings';
import { $, checkSeg, h, segButtons } from '../ui/dom';
import { elevation, map, setTerrainExaggeration, updateDaylight } from './mapView';
import { updateNav } from './nav';
import { refreshStorage } from './offline';
import { recorder } from './recording';
import { refreshBattery } from './battery';
import { TESHIROSAWA_GPX, applyRoutePref, loadGpxText, rebuild, reverseCurrentRoute, setRoute } from './route';
import { openSheet } from './sheetView';
import { state } from './state';
import { setProgress, status } from './status';
import { refreshTrackList } from './tracks';

const paceSeg = $('pace-preset');
segButtons(paceSeg, Object.entries(PACE_PRESETS).map(([id, def]) => [id, def.label] as const), (id) => {
  settings.pace = id as PacePreset;
  saveSettings();
  syncMenu();
  updateNav();
});

export const menu = $<HTMLDialogElement>('menu');
$('btn-menu').addEventListener('click', () => {
  void refreshStorage();
  void refreshBattery();
  menu.showModal();
});
menu.addEventListener('click', (e) => {
  if (e.target === menu) menu.close(); // 背景タップで閉じる
});

/** 那須岳まわりの地点（出発地・経由地・目的地に選べる）。座標は地理院の注記・道の分岐から取ったもの */
export const NASU_PLACES: { name: string; lngLat: LngLat }[] = [
  { name: '峠の茶屋駐車場', lngLat: [139.97815, 37.12787] },
  { name: 'ロープウェイ山麓駅', lngLat: [139.97939, 37.12503] },
  { name: 'ロープウェイ山頂駅', lngLat: [139.97085, 37.1239] },
  { name: '峰の茶屋', lngLat: [139.9658, 37.13] },
  { name: '茶臼岳', lngLat: [139.96313, 37.12484] },
  { name: '朝日岳', lngLat: [139.9683, 37.1367] },
  { name: '熊見曽根', lngLat: [139.96066, 37.13962] },
  { name: '隠居倉', lngLat: [139.95666, 37.1377] },
  { name: '三斗小屋温泉', lngLat: [139.94605, 37.13826] },
  { name: '牛ヶ首', lngLat: [139.95977, 37.12284] },
  { name: '日の出平', lngLat: [139.95362, 37.11774] },
  { name: '南月山', lngLat: [139.95824, 37.1097] },
];
const nasuPoint = (name: string) => NASU_PLACES.find((p) => p.name === name)!;

interface Preset {
  file: string;
  title: string;
  desc: string;
  reverse?: boolean;
  /** 那須岳まわりの地点の名前（出発地・経由地…・目的地）。あれば GPX の端ではなくこの順に通るルートを作る */
  places?: string[];
}

export const PRESETS: Preset[] = [
  {
    file: TESHIROSAWA_GPX,
    title: '女夫渕 → 手白澤温泉',
    desc: '奥鬼怒歩道・八丁の湯・加仁湯経由 約6km',
  },
  {
    file: TESHIROSAWA_GPX,
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
  {
    file: 'routes/nasu-chausudake.gpx',
    title: '峠の茶屋駐車場 → 茶臼岳',
    desc: '那須岳。峰の茶屋経由 約2.7km',
    places: ['峠の茶屋駐車場', '峰の茶屋', '茶臼岳'],
  },
  {
    file: 'routes/nasu-asahidake.gpx',
    title: '峠の茶屋駐車場 → 朝日岳',
    desc: '那須岳。峰の茶屋経由 約2.8km',
    places: ['峠の茶屋駐車場', '峰の茶屋', '朝日岳'],
  },
  {
    file: 'routes/nasu-sandogoya.gpx',
    title: '峠の茶屋駐車場 → 三斗小屋温泉',
    desc: '那須岳。峰の茶屋経由 約4.3km',
    places: ['峠の茶屋駐車場', '峰の茶屋', '三斗小屋温泉'],
  },
  {
    file: 'routes/nasu-ropeway-chausudake.gpx',
    title: 'ロープウェイ山頂駅 → 茶臼岳',
    desc: '那須岳。山頂駅から山頂へ 約0.9km',
    places: ['ロープウェイ山頂駅', '茶臼岳'],
  },
];

/** 地点を順に通るルートを道データから作る（作れなければ fallback の GPX を使う） */
async function buildFromPlaces(places: { name?: string; lngLat: LngLat }[], fallback?: () => Promise<void>) {
  setRoute(null);
  const last = places.length - 1;
  await rebuild(places.map((p, i) => makePoint(i === 0 ? 'start' : i === last ? 'dest' : 'via', p.lngLat, p.name)));
  if (!state.route && fallback) await fallback();
}

async function fetchText(file: string) {
  const res = await fetch(file);
  if (!res.ok) throw new Error('ルートを読み込めませんでした');
  return res.text();
}

async function loadPreset(p: Preset) {
  // まずは道データからルート候補を作る（登山道優先・別ルートなどを比べられる）。
  // 圏外などで作れなければ、保存してあるGPXのルートを使う（帰り道は逆向きにする）
  let text: string | undefined;
  const fallback = async () => {
    await loadGpxText((text ??= await fetchText(p.file)));
    if (p.reverse) reverseCurrentRoute();
  };
  // 地点の決まっているルートは、GPX を読まずに作る（GPX は作れなかったときだけ読む）
  if (p.places) return buildFromPlaces(p.places.map(nasuPoint), fallback);
  text = await fetchText(p.file);
  const gpx = parseGpx(text);
  const pts = gpx.lines.flatMap((l) => l.points);
  const named = (i: number) => gpx.waypoints.find((w) => distance([w.lng, w.lat], [pts[i].lng, pts[i].lat]) < 100)?.name;
  const ends = [0, pts.length - 1];
  if (p.reverse) ends.reverse();
  await buildFromPlaces(ends.map((i) => ({ lngLat: [pts[i].lng, pts[i].lat] as LngLat, name: named(i) })), fallback);
}

async function runRouteTask(task: () => Promise<void>) {
  menu.close();
  try {
    setProgress('ルートを読み込み中…');
    await task();
    if (state.route) openSheet();
  } catch (err) {
    status(err instanceof Error ? err.message : String(err), true);
  } finally {
    setProgress('');
  }
}

const presetWrap = $('preset-routes');
for (const p of PRESETS) {
  const b = h('button', 'btn block');
  b.type = 'button';
  b.append(h('span', '', p.title), h('small', '', p.desc));
  b.addEventListener('click', () => void runRouteTask(() => loadPreset(p)));
  presetWrap.append(b);
}

// 那須岳まわり：出発地・経由地（2つまで）・目的地を選んでルートを作る
const NONE = '';
const placeSelects = (['nasu-from', 'nasu-via1', 'nasu-via2', 'nasu-to'] as const).map((id, i) => {
  const sel = $<HTMLSelectElement>(id);
  const optional = id.startsWith('nasu-via');
  if (optional) sel.append(new Option('（なし）', NONE));
  for (const p of NASU_PLACES) sel.append(new Option(p.name, p.name));
  sel.value = ['峠の茶屋駐車場', '峰の茶屋', NONE, '茶臼岳'][i];
  return sel;
});
$('nasu-build').addEventListener('click', () => {
  // 続けて同じ地点を選んだときは1つにまとめる（長さ0の区間を作らない）
  const names: string[] = [];
  for (const { value } of placeSelects) if (value !== NONE && value !== names.at(-1)) names.push(value);
  if (names.length < 2) {
    status('出発地と目的地に違う地点を選んでください', true);
    return;
  }
  void runRouteTask(() => buildFromPlaces(names.map(nasuPoint)));
});

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
    const tracks = await listTracks();
    // 入れ終えたのに印だけ保存できていなかったとき（設定の保存に失敗した・設定だけ消えた）は、作り直さない（点は追記になり、二重になるため）
    if (tracks.some((t) => t.id === BUILTIN_PLAN.id)) {
      settings.builtinPlan = true;
      saveSettings();
      return;
    }
    const res = await fetch(preset.file);
    if (!res.ok) return;
    const r = await buildGpxRoute(parseGpx(await res.text()), elevation);
    const start = new Date();
    start.setHours(BUILTIN_PLAN.start[0], BUILTIN_PLAN.start[1], 0, 0);
    const pace = PACE_PRESETS[BUILTIN_PLAN.pace];
    const { track, points } = generateSampleTrack(r.coords, r.eles, {
      id: BUILTIN_PLAN.id,
      startMs: start.getTime(),
      name: `予定：${preset.title}（${pace.label}・${BUILTIN_PLAN.restEveryMin}分ごとに${BUILTIN_PLAN.restMin}分休憩）`,
      seed: 1130,
      pace: pace.factor,
      restEveryMin: BUILTIN_PLAN.restEveryMin,
      restMin: [BUILTIN_PLAN.restMin, BUILTIN_PLAN.restMin],
    });
    await appendPoints({ ...track, route: preset.title }, points);
    // 元にしたルートを記録と一緒に保存する（記録を開いたとき、行程の地点名やリプレイの地点の印に使う）
    await putTrackRoute({ trackId: BUILTIN_PLAN.id, route: routeSnapshot({ ...r, name: preset.title }) }).catch((e) => console.warn('予定の記録のルートを保存できませんでした', e));
    for (const t of tracks) if (t.id.startsWith('sample-')) await deleteTrack(t.id).catch(() => {}); // ロックしていれば残す
    settings.builtinPlan = true;
    saveSettings();
    await refreshTrackList();
  } catch (err) {
    console.warn('予定の記録を作れませんでした', err);
  }
}
