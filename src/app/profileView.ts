/** 標高グラフ：ルートまたは記録の標高と、記録の区間ごとのペース・休憩 */
import { cumulativeDistances, type LngLat } from '../geo';
import { defaultFactors, estimate, paceSegments } from '../nav/eta';
import { routeSpan } from '../nav/plan';
import type { TrackPoint } from '../track/db';
import { settings } from '../settings';
import { $, checkSeg, segButtons } from '../ui/dom';
import { ElevationProfile, type ProfileAxis } from '../ui/profile';
import { pointFC, src } from './mapView';
import { departureTime, type Nav } from './nav';
import { recorder } from './recording';
import { replayIndex } from './replay';
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
  (i) => src('cursor')?.setData(pointFC(i == null ? null : (profileCoords[i] ?? null))),
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

/** グラフに出せる記録：記録中ならその記録、なければ地図に表示している保存した記録 */
function profileTrack(): TrackPoint[] | null {
  const pts = recorder.recording ? recorder.state.points : (state.shown?.points ?? []);
  return pts.length > 1 ? pts : null;
}

// 区間ごとのペースは点が増えたときだけ計算し直す
let paceCache: { key: string; value: ReturnType<typeof paceSegments> } | null = null;
function cachedPace(points: TrackPoint[]) {
  const key = `${points[0].trackId}:${points.length}`;
  if (paceCache?.key !== key) paceCache = { key, value: paceSegments(points) };
  return paceCache.value;
}

segButtons($('profile-source'), [['route', 'ルート'], ['track', '記録']], (id) => {
  profileSource = id as ProfileSource;
  updateProfile(state.lastNav);
});
segButtons($('profile-axis'), [['dist', '距離'], ['time', '時刻']], (id) => {
  profile.setAxis(id as ProfileAxis);
  updateProfile(state.lastNav);
});

export function updateProfile(nav: Nav | null) {
  const track = profileTrack();
  const useTrack = !!track && (!state.route || profileSource === 'track');
  $('profile-source').hidden = !(track && state.route);
  checkSeg($('profile-source'), useTrack ? 'track' : 'route');
  $('profile-empty').hidden = !!(state.route || track);
  profileCanvas.hidden = !(state.route || track);
  if (useTrack) {
    profileCoords = track.map((p) => [p.lng, p.lat]);
    profile.setSeries({
      dists: cumulativeDistances(profileCoords),
      eles: track.map((p) => p.ele),
      times: track.map((p) => p.t),
      pace: cachedPace(track),
    }, `track:${track[0].trackId}`);
    profile.setMarker(replayIndex());
  } else if (state.route && state.timeline) {
    profileCoords = state.route.coords;
    // 時刻の軸：このペースでの到着予想。歩いている途中なら、今いる位置が今の時刻になるように
    const span = routeSpan(state.route);
    const factors = nav?.factors ?? defaultFactors(settings.pace);
    const tl = state.timeline;
    const start = nav?.onRoute
      ? Date.now() - estimate(tl, span.from, nav.fromAlong, factors).totalMin * 60_000
      : departureTime();
    profile.setSeries({
      dists: state.route.dists,
      eles: state.route.eles,
      times: state.route.dists.map((d) => start + estimate(tl, span.from, Math.max(span.from, d), factors).totalMin * 60_000),
      ticks: state.route.marks.map((m) => ({ d: m.along, kind: m.kind, label: m.name })),
    }, `route:${state.route.name}:${state.route.label}:${state.route.dists.length}`);
    if (nav?.onRoute) {
      let i = 0;
      while (i < state.route.dists.length - 1 && state.route.dists[i] < nav.fromAlong) i++;
      profile.setMarker(i);
    } else profile.setMarker(null);
  }
  checkSeg($('profile-axis'), profile.currentAxis);
  $('pace-legend').hidden = !useTrack;
}
