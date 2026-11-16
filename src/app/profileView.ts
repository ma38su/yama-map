/** 標高グラフ：ルートまたは記録の標高と、記録の区間ごとのペース・休憩 */
import type { LngLat } from '../geo';
import { defaultFactors, estimate, paceSegments } from '../nav/eta';
import { routeSpan } from '../nav/plan';
import type { TrackPoint } from '../track/db';
import { settings } from '../settings';
import { $, checkSeg, segButtons } from '../ui/dom';
import { ElevationProfile, type ProfileAxis, type ProfileSeries } from '../ui/profile';
import { pointFC, setSourceData } from './mapView';
import { departureTime, movingOf, type Nav } from './nav';
import { recorder } from './recording';
import { replayIndex } from './replay';
import { shownActual, shownActualKey } from './sheetView';
import { state } from './state';

// ---------- 標高グラフ ----------
type ProfileSource = 'route' | 'track';
let profileSource: ProfileSource = 'route';
/** グラフに出すもの（ルート／記録）を選ぶ */
export function setProfileSource(source: ProfileSource) {
  profileSource = source;
}
const profileCanvas = $<HTMLCanvasElement>('profile');
let profileCoords: LngLat[] = [];
const profilePos = $<HTMLInputElement>('profile-pos');
export const profile = new ElevationProfile(
  profileCanvas,
  (i) => setSourceData('cursor', pointFC(i == null ? null : (profileCoords[i] ?? null))),
  (view) => {
    // 拡大しているときだけ、表示位置のスライダーを出す
    const span = view.to - view.from;
    profilePos.hidden = span >= 0.999;
    profilePos.value = String(Math.round((view.from / Math.max(1e-6, 1 - span)) * 1000));
  },
);
profilePos.addEventListener('input', () => {
  const v = profile.currentView;
  profile.setPosition((Number(profilePos.value) / 1000) * (1 - (v.to - v.from)));
});
$('zoom-in').addEventListener('click', () => profile.zoom(2));
$('zoom-out').addEventListener('click', () => profile.zoom(0.5));
$('zoom-reset').addEventListener('click', () => profile.resetView());

/** 開いている記録の、通った地点（経由地・目的地）をグラフの目盛りにする（記録中は出さない） */
function actualTicks(dists: number[]): ProfileSeries['ticks'] {
  if (recorder.recording || !state.shown) return undefined;
  return shownActual()
    .filter((r) => r.kind === 'via' || r.kind === 'dest')
    .map((r) => ({ d: dists[r.index] ?? 0, kind: r.kind, label: r.name }));
}

/** 記録の点から作るグラフの系列。点が変わったときだけ作り、大きいグラフとカードの小さいグラフで使い回す */
interface TrackSeries {
  points: TrackPoint[];
  n: number;
  revision: number;
  coords: LngLat[];
  dists: number[];
  eles: (number | null)[];
  times: number[];
}
let seriesMemo: TrackSeries | null = null;
function trackSeries(points: TrackPoint[]): TrackSeries {
  const m = seriesMemo;
  if (m?.points === points && m.n === points.length && m.revision === state.revision) return m;
  seriesMemo = {
    points,
    n: points.length,
    revision: state.revision,
    coords: points.map((p): LngLat => [p.lng, p.lat]),
    // 累積距離は、ペース・実績と同じもの（movingOf で1回だけ求めてある）
    dists: Array.from(movingOf(points).cumD),
    eles: points.map((p) => p.ele),
    times: points.map((p) => p.t),
  };
  return seriesMemo;
}

/** 大きいグラフに最後に渡した系列の元（同じなら渡し直さない：30秒ごとの描き直しで、変わっていなければ描き直さない） */
let seriesFrom: unknown[] = [];
function seriesChanged(from: unknown[]): boolean {
  if (from.length === seriesFrom.length && from.every((v, i) => v === seriesFrom[i])) return false;
  seriesFrom = from;
  return true;
}

// ---------- カードの小さな標高グラフ（開いている記録・リプレイ中） ----------
/** 見るだけ（触るとシートの上げ下げになるよう、CSS で指を通さない） */
const miniCanvas = document.createElement('canvas');
miniCanvas.className = 'mini-profile';
miniCanvas.setAttribute('aria-hidden', 'true');
const miniProfile = new ElevationProfile(miniCanvas, () => undefined);
let miniKey = '';
/** カードに出す小さな標高グラフ（点が2つ未満なら null）。点が変わったときだけ作り直す */
export function miniProfileFor(points: TrackPoint[]): HTMLCanvasElement | null {
  if (points.length < 2) return null;
  // 目盛り（通った地点）は実績から作るので、実績と同じ目印で作り直す
  const key = `mini:${shownActualKey()}`;
  if (key !== miniKey) {
    miniKey = key;
    const { dists, eles, times } = trackSeries(points);
    miniProfile.setSeries({ dists, eles, times, ticks: actualTicks(dists) }, key);
  }
  miniProfile.setMarker(replayIndex());
  return miniCanvas;
}

/** リプレイの位置を、標高グラフとカードの小さなグラフに出す */
export function setReplayMarker(i: number | null) {
  profile.setMarker(i);
  miniProfile.setMarker(i);
}

/** グラフに出せる記録：記録中ならその記録、なければ地図に表示している保存した記録 */
function profileTrack(): TrackPoint[] | null {
  const pts = recorder.recording ? recorder.state.points : (state.shown?.points ?? []);
  return pts.length > 1 ? pts : null;
}

// 区間ごとのペースは点が増えたときだけ計算し直す（同じ点の並びで、点の数と revision が同じなら使い回す）
let paceCache: { points: TrackPoint[]; key: string; value: ReturnType<typeof paceSegments> } | null = null;
function cachedPace(points: TrackPoint[]) {
  const key = `${points.length}:${state.revision}`;
  if (paceCache?.points !== points || paceCache.key !== key) paceCache = { points, key, value: paceSegments(points, undefined, movingOf(points)) };
  return paceCache.value;
}

segButtons($('profile-source'), [['route', 'ルート'], ['track', '記録']], (id) => {
  profileSource = id as ProfileSource;
  updateProfile(state.lastNav);
});
segButtons($('profile-axis'), [['dist', '距離'], ['time', '時刻']], (id) => {
  // 系列は変わらないので、軸だけ変えて描く
  profile.setAxis(id as ProfileAxis);
  checkSeg($('profile-axis'), profile.currentAxis);
});

export function updateProfile(nav: Nav | null) {
  const track = profileTrack();
  const useTrack = !!track && (!state.route || profileSource === 'track');
  $('profile-source').hidden = !(track && state.route);
  checkSeg($('profile-source'), useTrack ? 'track' : 'route');
  $('profile-empty').hidden = !!(state.route || track);
  profileCanvas.hidden = !(state.route || track);
  if (useTrack) {
    const ser = trackSeries(track);
    profileCoords = ser.coords;
    const pace = cachedPace(track);
    $('pace-legend-vehicle').hidden = !pace.segments.some((s) => s.vehicle);
    // 目盛り（通った地点）は実績と同じ目印で変わる
    const ticksKey = recorder.recording ? '' : shownActualKey();
    if (seriesChanged([ser, pace, ticksKey])) {
      profile.setSeries({ dists: ser.dists, eles: ser.eles, times: ser.times, pace, ticks: actualTicks(ser.dists) }, `track:${track[0].trackId}:${track[0].t}`);
    }
    // 記録中は最後の点（今いるところ）、リプレイ中はその位置
    if (recorder.recording) profile.setMarker(track.length - 1, '現在地');
    else profile.setMarker(replayIndex());
  } else if (state.route && state.timeline) {
    profileCoords = state.route.coords;
    // 時刻の軸：行程と同じ到着予想。歩いている途中なら、今いる位置（ルートに戻る地点）の時刻から逆算して出発地の時刻を決める
    const span = routeSpan(state.route);
    const factors = nav?.factors ?? defaultFactors(settings.pace);
    const tl = state.timeline;
    const start = nav
      ? nav.startAt + ((nav.rejoin?.totalMin ?? 0) - estimate(tl, span.from, nav.fromAlong, factors).totalMin) * 60_000
      : departureTime();
    const route = state.route;
    if (seriesChanged([route, tl, start, factors.up, factors.flat, factors.down, factors.rest])) {
      // 各点の時刻：出発地からの歩行時間 ×（1 + 休憩の割合）。点ごとに estimate を呼ばずに、累積から引く
      const moving = tl.movingMinutes(factors);
      const m0 = moving(span.from);
      profile.setSeries({
        dists: route.dists,
        eles: route.eles,
        times: route.dists.map((d) => start + (moving(Math.max(span.from, d)) - m0) * (1 + factors.rest) * 60_000),
        ticks: route.marks.map((m) => ({ d: m.along, kind: m.kind, label: m.name })),
      }, `route:${route.name}:${route.label}:${route.dists.length}`);
    }
    if (nav?.onRoute) {
      let i = 0;
      while (i < state.route.dists.length - 1 && state.route.dists[i] < nav.fromAlong) i++;
      profile.setMarker(i, '現在地');
    } else profile.setMarker(null);
  }
  checkSeg($('profile-axis'), profile.currentAxis);
  $('pace-legend').hidden = !useTrack;
}
