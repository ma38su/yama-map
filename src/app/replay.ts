/**
 * 記録のリプレイ：歩いた位置を時間を縮めて動かし、地図（3D）のカメラが追いかける。
 * 視点は、後ろから追う・少し高くから俯瞰して追う・全体を見る、の3つから選ぶ（操作バーのボタン）。
 * 今の位置は赤い丸で、歩いているあいだは進む向きの矢じりを重ねる。休憩（点と点のあいだが空いているところ）は速く送る。
 */
import { arrowPolygon, bbox, bearing as bearingTo, cumulativeDistances, distance, formatDistance, metersPerPixel, type LngLat } from '../geo';
import { angleDiff } from '../nav/heading';
import type { TrackPoint } from '../track/db';
import { trackTitle, trackWhen } from '../track/names';
import { $, fileStamp, fmtClock, h } from '../ui/dom';
import { emptyFC, lineFC, map, pointFC, replayDoneGradient, setTerrain, src, updateDaylight } from './mapView';
import { setReplayMarker } from './profileView';
import { updateRecButton } from './recording';
import { captureSupported, capturing, startCapture, stopCapture } from './replayVideo';
import { saveSettings, savedOverrides, settings, type Settings } from '../settings';
import { state } from './state';
import { recordedWeatherSource, showingPlan, weatherShort } from './trackWeather';
import { cachedForecastSource, setReplayWeather } from './weather';

/** 再生の速さ（実際の何倍か） */
const SPEEDS = [100, 300, 1000] as const;
/** 休憩とみなす点の間隔 (ms) と、そこを送る倍率 */
const REST_GAP_MS = 90_000;
const REST_BOOST = 10;
/** 空と地図の色を合わせ直す間隔（再生中の時刻で） */
const DAYLIGHT_STEP_MS = 2 * 60_000;
/** 視点ごとのカメラ：ズーム・傾き・何m先の点の方を向くか・向きを合わせる速さ（1コマで差の何割） */
type ReplayView = NonNullable<Settings['replayView']>;
const VIEWS: Record<ReplayView, { label: string; desc: string; zoom: number; pitch: number; lookAhead: number; turn: number }> = {
  chase: { label: '追う', desc: '後ろから追う', zoom: 15.5, pitch: 65, lookAhead: 120, turn: 0.06 },
  // 高めから、先の道が見えるように。向きはゆっくり変える
  bird: { label: '俯瞰', desc: '高くから俯瞰して追う', zoom: 13.6, pitch: 50, lookAhead: 400, turn: 0.02 },
  // カメラは動かさない（地図は指で動かせる）
  whole: { label: '全体', desc: '記録の全体を見る', zoom: 0, pitch: 45, lookAhead: 0, turn: 0 },
};
const VIEW_ORDER: ReplayView[] = ['chase', 'bird', 'whole'];
/** 進む向きの矢じり：何m先の点の方を向くか・丸の中に収まる大きさ (px)・向きを合わせる速さ */
const DIR_AHEAD_M = 25;
const DIR_SIZE_PX = 8;
const DIR_TURN = 0.2;
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
/** 矢じりの向き（なめらかに変える）。分からなければ null */
let dirBearing: number | null = null;
let view: ReplayView = settings.replayView ?? 'chase';
/** 視点を変えるカメラの動きが終わる時刻（それまでは追いかけない。追いかけると動きが止まるため） */
let easingUntil = 0;
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

// ---------- 始めのタイトル ----------
/** 始めにタイトル（経路名と日時）を出す時間。このあいだにカメラが出発地へ動き、終わったら再生を始める */
const TITLE_MS = 3200;
/** タイトルを消していく時間 */
const TITLE_FADE_MS = 600;
const titleEl = h('div', 'replay-title');
titleEl.hidden = true;
map.getContainer().append(titleEl);
/** 出しているタイトル（録画にも描く）と、出し始めた時刻 */
let title: { lines: string[]; at: number } | null = null;
let titleTimers: number[] = [];
let titleRaf = 0;

/** タイトルの濃さ（1 → 消していく → 0） */
function titleAlpha(now = performance.now()): number {
  if (!title) return 0;
  const left = title.at + TITLE_MS - now;
  return left <= 0 ? 0 : Math.min(1, left / TITLE_FADE_MS);
}

function hideTitle() {
  for (const id of titleTimers) clearTimeout(id);
  titleTimers = [];
  cancelAnimationFrame(titleRaf);
  title = null;
  titleEl.hidden = true;
  titleEl.classList.remove('fade');
}

/** タイトルを出す。録画中は、消えていくところも録画に入るように、そのあいだだけ地図を描き直す */
function showTitle(lines: string[]) {
  hideTitle();
  title = { lines, at: performance.now() };
  titleEl.replaceChildren(h('div', 'name', lines[0]), ...lines.slice(1).map((l) => h('div', 'sub', l)));
  // 地図のうちシートに隠れていない部分の、上から4割ほどのところに出す（録画の中と同じ位置）
  titleEl.style.top = `${Math.max(48, $('sheet').getBoundingClientRect().top * 0.38)}px`;
  titleEl.hidden = false;
  titleTimers.push(
    window.setTimeout(() => titleEl.classList.add('fade'), TITLE_MS - TITLE_FADE_MS),
    window.setTimeout(hideTitle, TITLE_MS),
  );
  const tick = () => {
    if (!title) return;
    if (capturing()) map.triggerRepaint();
    titleRaf = requestAnimationFrame(tick);
  };
  titleRaf = requestAnimationFrame(tick);
}

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

/** 点 i から ahead m 先の点への方位（近すぎて分からなければ null） */
function headingAt(i: number, ahead: number): number | null {
  const a = lngLat(pts[i]);
  for (let j = i + 1; j < pts.length; j++) {
    const b = lngLat(pts[j]);
    const d = distance(a, b);
    if (d >= ahead || j === pts.length - 1) return d > 5 ? bearingTo(a, b) : null;
  }
  return null;
}

/** 時刻 t の位置 */
function positionAt(time: number): LngLat {
  const { i, f } = locate(time);
  const a = pts[i];
  const b = pts[Math.min(i + 1, pts.length - 1)];
  return [a.lng + (b.lng - a.lng) * f, a.lat + (b.lat - a.lat) * f];
}

/** 今の位置の矢じり。止まっている（休憩中・最後まで来た）ときは出さない。smooth なら向きをなめらかに変える */
function drawDirection(here: LngLat, i: number, moving: boolean, smooth: boolean) {
  const h = moving ? headingAt(i, DIR_AHEAD_M) : null;
  if (h != null) dirBearing = dirBearing == null || !smooth ? h : dirBearing + angleDiff(dirBearing, h) * DIR_TURN;
  const show = moving && dirBearing != null;
  src('replay-dir')?.setData(show ? polygonFC(arrowPolygon(here, dirBearing!, DIR_SIZE_PX * metersPerPixel(here[1], map.getZoom()))) : emptyFC);
}
const polygonFC = (ring: LngLat[]) => ({ type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [ring] } }] });

/** 視点に合わせてカメラを動かす（duration ms かけて） */
function aimCamera(duration: number) {
  if (pts.length < 2) return;
  const v = VIEWS[view];
  easingUntil = performance.now() + duration + 50;
  if (view === 'whole') {
    // 記録全体を、出発地から到着地の方を向いて斜めから見る（出発地と到着地が近い周回なら北を上）
    const [w, s, e, n] = bbox(pts.map(lngLat));
    const a = lngLat(pts[0]);
    const b = lngLat(pts[pts.length - 1]);
    bearing = distance(a, b) > 500 ? bearingTo(a, b) : 0;
    map.fitBounds([[w, s], [e, n]], { padding: 40, pitch: v.pitch, bearing, maxZoom: 16, duration });
    return;
  }
  const { i } = locate(t);
  bearing = headingAt(i, v.lookAhead) ?? map.getBearing();
  const zoom = view === 'chase' ? Math.max(map.getZoom(), v.zoom) : v.zoom;
  map.easeTo({ center: positionAt(t), bearing, pitch: v.pitch, zoom, duration });
}

/** 時刻の横に出している天気と、それを引いた時刻 */
let wxText = '';
let wxAt = -Infinity;

/** 位置・カメラ・時刻の表示を t に合わせる */
function render(follow: boolean) {
  const { i, f } = locate(t);
  const a = pts[i];
  const b = pts[Math.min(i + 1, pts.length - 1)];
  const here: LngLat = [a.lng + (b.lng - a.lng) * f, a.lat + (b.lat - a.lat) * f];
  src('replay')?.setData(pointFC(here));
  const resting = b.t - a.t > REST_GAP_MS && f > 0 && f < 1;
  drawDirection(here, i, !resting && t < pts[pts.length - 1].t, follow);
  // 天気は、時刻が1分動いたら引き直す
  if (Math.abs(t - wxAt) >= 60_000) {
    wxAt = t;
    wxText = weatherShort(here, t);
  }
  clock.textContent = `${fmtClock(t)}${wxText ? ` ${wxText}` : ''}${resting ? ` 休憩中（${Math.round((b.t - a.t) / 60_000)}分）` : ''}`;
  seek.value = String(Math.round(((t - pts[0].t) / (pts[pts.length - 1].t - pts[0].t)) * 1000));
  // 視点を変えている途中と「全体」のときは、カメラを動かさない
  if (follow && view !== 'whole' && performance.now() >= easingUntil) {
    const v = VIEWS[view];
    const h = headingAt(i, v.lookAhead);
    // 向きはなめらかに変える（細かい曲がりで画面が揺れないように）
    if (h != null) bearing += angleDiff(bearing, h) * v.turn;
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
    setReplayMarker(i);
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
  // 変わっていなければ設定しない（設定するとカメラの動きが止まるため。リプレイを始めたときの視点の移動など）
  if (Math.abs((map.getPadding().bottom ?? 0) - covered) < 1) return;
  const easing = performance.now() < easingUntil;
  map.setPadding({ top: 0, bottom: covered, left: 0, right: 0 });
  // 視点を変えている途中なら、止まった動きをやり直す
  if (easing) aimCamera(500);
}
// リプレイ中にシートを最小にしたり開いたりしたら、追いかける位置も合わせる
new ResizeObserver(() => replayActive() && fitPadding()).observe($('sheet'));

/**
 * 開いている記録のリプレイを始める（3D にして、出発地の後ろから見る）。始めに経路名と日時のタイトルを出し、
 * そのあいだにカメラを出発地へ動かしてから再生する。capture なら、タイトルから録画する（リプレイボタンの長押し）
 */
export function startReplay(opts: { capture?: boolean } = {}) {
  const shown = state.shown;
  if (!shown || shown.points.length < 2) return;
  pts = shown.points;
  cumD = cumulativeDistances(pts.map(lngLat));
  t = pts[0].t;
  lastIndex = -1;
  drawnProgress = -1;
  src('replay-done')?.setData(lineFC(pts.map(lngLat)));
  bar.hidden = false;
  // 雲・雨・雪はリプレイ中だけ。記録は記録したときの天気、計画は端末に残っている予報で（リプレイ中は取りに行かない）
  wxAt = -Infinity;
  setReplayWeather(true, showingPlan() ? cachedForecastSource : recordedWeatherSource);
  terrainBefore = settings.terrain;
  savedOverrides.terrain = terrainBefore;
  setTerrain(true);
  dirBearing = null;
  const intro = 1200;
  // シートに隠れない部分の真ん中で追いかける
  fitPadding();
  // 録画するなら、タイトルとカメラの動きから入れる
  if (opts.capture) beginCapture();
  const track = shown.track;
  showTitle([trackTitle(track), `${trackWhen(track)} · ${formatDistance(track.distance)}`]);
  aimCamera(intro);
  // タイトルを出し終えてから（カメラは出発地に着いている）動かし始める
  const token = ++session;
  setTimeout(() => {
    if (replayActive() && token === session && !playing) play();
  }, TITLE_MS);
  render(false);
}

let stoppedHandler: (() => void) | null = null;
/** リプレイをやめたときに呼ぶ処理（計画のリプレイなら計画の画面に戻す：recording.ts） */
export function onReplayStopped(fn: () => void) {
  stoppedHandler = fn;
}

/** リプレイをやめる */
export function stopReplay() {
  if (!replayActive()) return;
  void stopRecording();
  pause();
  bar.hidden = true;
  hideTitle();
  setReplayWeather(false);
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  state.daylightAt = null;
  delete savedOverrides.terrain;
  // 2D から始めたリプレイなら 2D に戻す（setTerrain が空の色も合わせ直す）
  if (!terrainBefore) setTerrain(false);
  else saveSettings();
  updateDaylight();
  src('replay')?.setData(pointFC(null));
  src('replay-dir')?.setData(emptyFC);
  src('replay-done')?.setData(lineFC([]));
  if (map.getLayer('replay-done')) map.setPaintProperty('replay-done', 'line-gradient', replayDoneGradient(0));
  lastIndex = -1;
  setReplayMarker(null);
  stoppedHandler?.();
}

playBtn.addEventListener('click', () => {
  if (playing) pause();
  else {
    // タイトルの途中で再生を押したら、すぐ始める
    hideTitle();
    play();
  }
});

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
/** 録画を始める（字幕は経路名と日付・時刻、始めのタイトルも録画に描く） */
function beginCapture() {
  const track = state.shown?.track;
  if (!track || pts.length < 2 || capturing()) return;
  startCapture(
    `yama-replay-${fileStamp(track.startedAt)}`,
    () => [trackTitle(track), `${track.route ? `${new Date(track.startedAt).toLocaleDateString('ja-JP')} ` : ''}${clock.textContent ?? ''}`],
    () => $('sheet').getBoundingClientRect().top,
    () => (title ? { lines: title.lines, alpha: titleAlpha() } : null),
  );
  updateRecBtn();
}
recBtn.addEventListener('click', () => {
  if (capturing()) {
    void stopRecording();
    return;
  }
  beginCapture();
  // 止まっていたら再生を始める（最後まで行っていたら最初から）
  if (!playing) {
    hideTitle();
    play();
  }
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
const viewBtn = $<HTMLButtonElement>('replay-view');
function updateViewBtn() {
  viewBtn.textContent = VIEWS[view].label;
  viewBtn.setAttribute('aria-label', `視点：${VIEWS[view].desc}（押すと切り替え）`);
}
viewBtn.addEventListener('click', () => {
  view = VIEW_ORDER[(VIEW_ORDER.indexOf(view) + 1) % VIEW_ORDER.length];
  settings.replayView = view;
  saveSettings();
  updateViewBtn();
  if (replayActive()) aimCamera(700);
});
updateViewBtn();
// 止めているあいだに拡大・縮小したら、矢じりの大きさを丸に合わせ直す
map.on('zoom', () => replayActive() && !playing && pts.length > 1 && render(false));
seek.addEventListener('input', () => {
  t = pts[0].t + (Number(seek.value) / 1000) * (pts[pts.length - 1].t - pts[0].t);
  render(true);
});
