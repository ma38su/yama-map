/**
 * 記録のリプレイ：歩いた位置を時間を縮めて動かし、地図（3D）のカメラが後ろから追いかける。
 * 休憩（点と点のあいだが空いているところ）は速く送る。
 */
import { cumulativeDistances, distance, type LngLat } from '../geo';
import type { TrackPoint } from '../track/db';
import { $, fileStamp, fmtClock } from '../ui/dom';
import { lineFC, map, pointFC, replayDoneGradient, setTerrain, src, updateDaylight } from './mapView';
import { profile } from './profileView';
import { updateRecButton } from './recording';
import { captureSupported, capturing, startCapture, stopCapture } from './replayVideo';
import { saveSettings, savedOverrides, settings } from '../settings';
import { state } from './state';

/** 再生の速さ（実際の何倍か） */
const SPEEDS = [100, 300, 1000] as const;
/** 休憩とみなす点の間隔 (ms) と、そこを送る倍率 */
const REST_GAP_MS = 90_000;
const REST_BOOST = 10;
/** 空と地図の色を合わせ直す間隔（再生中の時刻で） */
const DAYLIGHT_STEP_MS = 2 * 60_000;
/** カメラの向きを合わせる先：何m先の点の方を向くか */
const LOOK_AHEAD_M = 120;
/**
 * 1コマの最短の間隔 (ms)。120Hz の画面（Pixel 8a・9 Pro など）では requestAnimationFrame が1秒に120回来るが、
 * リプレイは60コマで十分なので、それより速くは地図を動かさない（地図の描き直しが半分になる）
 */
const FRAME_MS = 1000 / 60 - 1;

let pts: TrackPoint[] = [];
/** 点ごとの累積距離 (m)。歩き終えた線をどこまで塗るかに使う */
let cumD: number[] = [];
/** 歩き終えた線を塗った割合（変わったときだけ塗り直す） */
let drawnProgress = -1;
let t = 0;
let speedIdx = 1;
let playing = false;
let raf = 0;
let lastFrame = 0;
let bearing = 0;
let lastIndex = -1;
/** リプレイを始めるたびに増やす（前のリプレイの開始待ちを無効にする） */
let session = 0;
/** リプレイを始める前に 3D だったか（終えたら元に戻す） */
let terrainBefore = false;

const bar = $('replay');
const playBtn = $<HTMLButtonElement>('replay-play');
const seek = $<HTMLInputElement>('replay-seek');
const clock = $('replay-clock');
const speedBtn = $<HTMLButtonElement>('replay-speed');

/** リプレイ中か（一時停止中も含む） */
export const replayActive = () => !bar.hidden;
/** グラフに印を付ける点の番号 */
export const replayIndex = () => (replayActive() ? lastIndex : null);

/** 時刻 t の位置：直前の点の番号と、次の点までの割合 */
function locate(time: number): { i: number; f: number } {
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= time) lo = mid;
    else hi = mid;
  }
  const span = pts[hi].t - pts[lo].t;
  return { i: lo, f: span > 0 ? Math.max(0, Math.min(1, (time - pts[lo].t) / span)) : 0 };
}

const lngLat = (p: TrackPoint): LngLat => [p.lng, p.lat];

function headingAt(i: number): number | null {
  const a = lngLat(pts[i]);
  for (let j = i + 1; j < pts.length; j++) {
    const b = lngLat(pts[j]);
    if (distance(a, b) >= LOOK_AHEAD_M || j === pts.length - 1) {
      const y = Math.sin(((b[0] - a[0]) * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180);
      const x =
        Math.cos((a[1] * Math.PI) / 180) * Math.sin((b[1] * Math.PI) / 180) -
        Math.sin((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.cos(((b[0] - a[0]) * Math.PI) / 180);
      return distance(a, b) > 5 ? (Math.atan2(y, x) * 180) / Math.PI : null;
    }
  }
  return null;
}

/** 位置・カメラ・時刻の表示を t に合わせる */
function render(follow: boolean) {
  const { i, f } = locate(t);
  const a = pts[i];
  const b = pts[Math.min(i + 1, pts.length - 1)];
  const here: LngLat = [a.lng + (b.lng - a.lng) * f, a.lat + (b.lat - a.lat) * f];
  src('replay')?.setData(pointFC(here));
  const resting = b.t - a.t > REST_GAP_MS && f > 0 && f < 1;
  clock.textContent = `${fmtClock(t)}${resting ? ` 休憩中（${Math.round((b.t - a.t) / 60_000)}分）` : ''}`;
  seek.value = String(Math.round(((t - pts[0].t) / (pts[pts.length - 1].t - pts[0].t)) * 1000));
  if (follow) {
    const h = headingAt(i);
    if (h != null) {
      // 向きはなめらかに変える（細かい曲がりで画面が揺れないように）
      const diff = ((h - bearing + 540) % 360) - 180;
      bearing += diff * 0.06;
    }
    map.jumpTo({ center: here, bearing });
  }
  // 空と地図の色は再生中の時刻に合わせる（毎フレームだと重いので、時刻が2分動いたら）
  if (state.daylightAt == null || Math.abs(t - state.daylightAt) >= DAYLIGHT_STEP_MS) {
    state.daylightAt = t;
    updateDaylight();
  }
  // 歩き終えた線は、線全体のうち歩いた距離の割合までを塗る（線を作り直さず、塗る範囲だけを変える）
  const total = cumD[cumD.length - 1];
  const progress = total > 0 ? (cumD[i] + (cumD[Math.min(i + 1, cumD.length - 1)] - cumD[i]) * f) / total : 0;
  if (Math.abs(progress - drawnProgress) >= 0.0005) {
    drawnProgress = progress;
    if (map.getLayer('replay-done')) map.setPaintProperty('replay-done', 'line-gradient', replayDoneGradient(progress));
  }
  // グラフの印は、点を一つ進んだときだけ描き直す
  if (i !== lastIndex) {
    lastIndex = i;
    profile.setMarker(i);
  }
}

function frame(now: number) {
  if (now - lastFrame < FRAME_MS) {
    raf = requestAnimationFrame(frame);
    return;
  }
  const dt = Math.min(100, now - lastFrame);
  lastFrame = now;
  const { i } = locate(t);
  const gap = pts[Math.min(i + 1, pts.length - 1)].t - pts[i].t;
  t += dt * SPEEDS[speedIdx] * (gap > REST_GAP_MS ? REST_BOOST : 1);
  const end = pts[pts.length - 1].t;
  if (t >= end) {
    t = end;
    render(true);
    pause();
    // 最後の場面が少し映ってから録画を止める
    if (capturing()) setTimeout(() => void stopRecording(), 800);
    return;
  }
  render(true);
  raf = requestAnimationFrame(frame);
}

function play() {
  if (pts.length < 2) return;
  if (t >= pts[pts.length - 1].t) t = pts[0].t;
  playing = true;
  playBtn.textContent = '❚❚';
  playBtn.setAttribute('aria-label', '一時停止');
  lastFrame = performance.now();
  raf = requestAnimationFrame(frame);
}

function pause() {
  playing = false;
  cancelAnimationFrame(raf);
  playBtn.textContent = '▶';
  playBtn.setAttribute('aria-label', '再生');
}

/** シートに隠れない部分の真ん中で追いかけるように、地図の下の余白をシートの高さに合わせる */
function fitPadding() {
  const covered = Math.max(0, window.innerHeight - $('sheet').getBoundingClientRect().top);
  map.setPadding({ top: 0, bottom: covered, left: 0, right: 0 });
}
// リプレイ中にシートを最小にしたり開いたりしたら、追いかける位置も合わせる
new ResizeObserver(() => replayActive() && fitPadding()).observe($('sheet'));

/** 開いている記録のリプレイを始める（3D にして、出発地の後ろから見る） */
export function startReplay() {
  const shown = state.shown;
  if (!shown || shown.points.length < 2) return;
  pts = shown.points;
  cumD = cumulativeDistances(pts.map(lngLat));
  t = pts[0].t;
  lastIndex = -1;
  drawnProgress = -1;
  src('replay-done')?.setData(lineFC(pts.map(lngLat)));
  bar.hidden = false;
  terrainBefore = settings.terrain;
  savedOverrides.terrain = terrainBefore;
  setTerrain(true);
  bearing = headingAt(0) ?? map.getBearing();
  const intro = 1200;
  // シートに隠れない部分の真ん中で追いかける
  fitPadding();
  map.easeTo({ center: lngLat(pts[0]), bearing, pitch: 65, zoom: Math.max(map.getZoom(), 15.5), duration: intro });
  // カメラが出発地に着いてから動かし始める
  const token = ++session;
  setTimeout(() => {
    if (replayActive() && token === session && !playing) play();
  }, intro + 100);
  render(false);
}

/** リプレイをやめる */
export function stopReplay() {
  if (!replayActive()) return;
  void stopRecording();
  pause();
  bar.hidden = true;
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  state.daylightAt = null;
  delete savedOverrides.terrain;
  // 2D から始めたリプレイなら 2D に戻す（setTerrain が空の色も合わせ直す）
  if (!terrainBefore) setTerrain(false);
  else saveSettings();
  updateDaylight();
  src('replay')?.setData(pointFC(null));
  src('replay-done')?.setData(lineFC([]));
  if (map.getLayer('replay-done')) map.setPaintProperty('replay-done', 'line-gradient', replayDoneGradient(0));
  lastIndex = -1;
  profile.setMarker(null);
}

playBtn.addEventListener('click', () => (playing ? pause() : play()));

// ---------- 録画 ----------
const recBtn = $<HTMLButtonElement>('replay-rec');
recBtn.hidden = !captureSupported();
function updateRecBtn() {
  const on = capturing();
  recBtn.classList.toggle('on', on);
  recBtn.setAttribute('aria-pressed', String(on));
  recBtn.setAttribute('aria-label', on ? '録画を止めて保存' : '録画');
}
async function stopRecording() {
  if (!capturing()) return;
  await stopCapture();
  updateRecBtn();
}
recBtn.addEventListener('click', () => {
  if (capturing()) {
    void stopRecording();
    return;
  }
  const track = state.shown?.track;
  if (!track || pts.length < 2) return;
  startCapture(
    `yama-replay-${fileStamp(track.startedAt)}`,
    () => [track.name, clock.textContent ?? ''],
    () => $('sheet').getBoundingClientRect().top,
  );
  updateRecBtn();
  // 止まっていたら再生を始める（最後まで行っていたら最初から）
  if (!playing) play();
});
$('replay-close').addEventListener('click', () => {
  stopReplay();
  updateRecButton();
});
speedBtn.addEventListener('click', () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  speedBtn.textContent = `×${SPEEDS[speedIdx]}`;
});
speedBtn.textContent = `×${SPEEDS[speedIdx]}`;
seek.addEventListener('input', () => {
  t = pts[0].t + (Number(seek.value) / 1000) * (pts[pts.length - 1].t - pts[0].t);
  render(true);
});
