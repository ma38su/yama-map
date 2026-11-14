/** 現在地と記録（開始・終了、記録の線、途中で閉じた記録の再開） */
import { distance, formatDistance, type LngLat } from '../geo';
import { getPoints, listTracks, putTrack, type Track } from '../track/db';
import { backgroundCapable, type Fix } from '../track/location';
import { TrackRecorder } from '../track/recorder';
import { saveSettings, settings } from '../settings';
import { $, fmtM } from '../ui/dom';
import { dem, geolocate, lineFC, src } from './mapView';
import { refreshTrackList } from './menu';
import { setProfileSource } from './profileView';
import { replayActive, startReplay, stopReplay } from './replay';
import { sheet } from './sheetView';
import { markTrackStale, refreshNow, updateNav } from './nav';
import { state } from './state';
import { status } from './status';

// ---------- 現在地 ----------
let lastEleAt: { coords: LngLat; t: number } | null = null;
geolocate.on('geolocate', (pos) => {
  const first = !state.lastFix;
  state.lastFix = { coords: [pos.coords.longitude, pos.coords.latitude], acc: pos.coords.accuracy, t: Date.now() };
  // 測位は1秒ごとくらいに届くので、受け取るだけにして計算はまとめて行う（nav.ts の refreshNow）。
  // 初めて現在地が分かったときだけ、すぐ到着予想を出す
  if (first) void refreshNow();
});
/** 現在地の標高。20m 以上動いたか5分経ったときだけ求め直す（標高タイルを読むので） */
export async function updateCurrentEle() {
  const fix = state.lastFix;
  if (!fix || (lastEleAt && distance(lastEleAt.coords, fix.coords) <= 20 && Date.now() - lastEleAt.t < 5 * 60_000)) return;
  lastEleAt = { coords: fix.coords, t: Date.now() };
  state.currentEle = await dem.elevation(fix.coords[0], fix.coords[1]);
}
geolocate.on('error', (e) => {
  if (e.code === 1) {
    status('位置情報の利用が許可されていません。端末の設定を確認してください', true);
    return;
  }
  // TIMEOUT(3) は止まっているだけでも起きる。一時的な失敗(2)も、直近に測位できていれば気にしない
  if (e.code === 2 && (!state.lastFix || Date.now() - state.lastFix.t > 20_000)) {
    status('現在地を取得できません（GPSの電波が弱い可能性があります）', true);
  }
});
/** 直近10分以内に分かっている現在地 */
export function hereLngLat(): LngLat | null {
  const recLast = recorder.state.points.at(-1);
  const cands = [
    state.lastFix ? { c: state.lastFix.coords, t: state.lastFix.t } : null,
    recLast ? { c: [recLast.lng, recLast.lat] as LngLat, t: recLast.t } : null,
  ]
    .filter((x): x is { c: LngLat; t: number } => !!x)
    .sort((a, b) => b.t - a.t);
  return cands[0] && Date.now() - cands[0].t < 10 * 60_000 ? cands[0].c : null;
}

/** 現在地の追従をオンにする（trigger() はオン/オフの切り替えなので、オフのときだけ押す） */
function startGeolocate() {
  if (geolocate._watchState === 'OFF') geolocate.trigger();
}

/** 現在地の表示をやめる（追従を外して背景になっているときに押すと現在地へ戻ってしまうので、追従中の扱いにしてから押す） */
export function stopGeolocate() {
  if (geolocate._watchState === 'OFF') return;
  if (geolocate._watchState === 'BACKGROUND') geolocate._watchState = 'ACTIVE_LOCK';
  geolocate.trigger();
}

/**
 * アプリ版では、画面オフから戻ってもWebViewの位置取得が再開するまで数秒かかり、その間は現在地マークが止まる。
 * 記録中はネイティブ測位がバックグラウンドでも続いているので、WebView側が古いあいだはその位置でマークを動かす。
 */
function feedNativeFix(fix: Fix | null) {
  if (!backgroundCapable || !fix || document.visibilityState !== 'visible') return;
  if (geolocate._watchState === 'OFF') return; // OFF のとき _onSuccess は例外を投げる
  const known = geolocate._lastKnownPosition as GeolocationPosition | undefined;
  if (known && fix.timestamp - known.timestamp < 3000) return; // WebView側の測位が届いている
  const coords = {
    longitude: fix.lng,
    latitude: fix.lat,
    accuracy: fix.accuracy,
    altitude: fix.altitude,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  };
  geolocate._onSuccess({ coords, timestamp: fix.timestamp } as GeolocationPosition);
}
document.addEventListener('visibilitychange', () => feedNativeFix(recorder.state.lastFix));

// ---------- 記録 ----------
let lastRecState = '';
let lastPointCount = 0;
export const recorder = new TrackRecorder(dem, (s) => {
  feedNativeFix(s.lastFix);
  if (s.track) state.shown = { track: s.track, points: s.points };
  else if (state.shown && !recorder.recording) state.shown = null;
  // 開始・終了・エラーなどはすぐ画面に出す。点が増えただけなら、次にまとめて描き直す
  // （記録中は測位のたびに呼ばれ、アプリ版では画面を消していても届くため）
  const recState = `${s.track?.id}:${s.track?.status}:${s.error}:${s.wakeLock}`;
  if (recState !== lastRecState) {
    lastRecState = recState;
    renderTrack();
    updateRecButton();
    updateNav();
  } else if (s.points.length !== lastPointCount) markTrackStale();
  lastPointCount = s.points.length;
});
recorder.keepScreenOn = settings.wakeLock;

const recBtn = $<HTMLButtonElement>('btn-rec');
recBtn.addEventListener('click', async () => {
  if (!recorder.recording) {
    if (!('geolocation' in navigator)) {
      alert('この端末・ブラウザでは位置情報が使えません');
      return;
    }
    await recorder.start();
    // 記録を始めたら、出発時刻は現在時刻に
    if (settings.departAt) {
      settings.departAt = null;
      saveSettings();
    }
    startGeolocate();
    status('記録を開始しました。歩いた実績から到着予想を調整します');
  } else {
    if (!confirm('記録を終了しますか？')) return;
    const t = await recorder.stop();
    if (t) {
      // 歩き終えた記録をそのまま開いて、実績を見られるように
      stopGeolocate();
      status(`記録を保存しました：${formatDistance(t.distance)}・登り ${fmtM(t.ascent)}`);
    }
  }
  void refreshTrackList();
});

export function updateRecButton() {
  const rec = recorder.recording;
  recBtn.classList.toggle('recording', rec);
  recBtn.querySelector('.text')!.textContent = rec ? '記録終了' : '記録開始';
  // 保存した記録を開いているあいだは記録できない（リプレイと閉じるボタンにする）
  const viewing = viewingTrack();
  recBtn.hidden = viewing;
  $('view-actions').hidden = !viewing;
  const replay = $('btn-replay');
  replay.querySelector('span:first-child')!.textContent = replayActive() ? '■' : '▶';
  replay.querySelector('span:last-child')!.textContent = replayActive() ? '終了' : 'リプレイ';
}

/** 保存した記録（または歩き終えた記録）を開いているか */
export const viewingTrack = () => !recorder.recording && !!state.shown;

/** 開いている記録を閉じる */
export function closeTrack() {
  stopReplay();
  recorder.clear();
  state.shown = null;
  setProfileSource('route');
  renderTrack();
  updateRecButton();
  updateNav();
}
$('btn-close-track').addEventListener('click', closeTrack);
$('btn-replay').addEventListener('click', () => {
  if (replayActive()) stopReplay();
  else {
    // 地図が見えるように、シートは半分まで下げる
    if (sheet.isOpen) sheet.setState('half');
    startReplay();
  }
  updateRecButton();
});

export function renderTrack() {
  src('track')?.setData(lineFC((state.shown?.points ?? []).map((p): LngLat => [p.lng, p.lat])));
}


/** 前回、記録中のままアプリが閉じられていたら再開を確認する */
export async function checkUnfinished() {
  const tracks = await listTracks().catch(() => [] as Track[]);
  const open = tracks.find((t) => t.status === 'recording');
  if (!open) return;
  if (confirm(`「${open.name}」の記録が途中です。続きを記録しますか？\n（キャンセルするとここまでで保存します）`)) {
    await recorder.resume(open);
    startGeolocate();
  } else {
    const points = await getPoints(open.id);
    await putTrack({ ...open, status: 'done', endedAt: points[points.length - 1]?.t ?? open.startedAt });
  }
}
