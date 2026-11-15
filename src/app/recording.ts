/** 現在地と記録（開始・終了、記録の線、途中で閉じた記録の再開） */
import { distance, formatDistance, type LngLat } from '../geo';
import { log } from '../log';
import { listTracks, type Track } from '../track/db';
import { backgroundCapable, pendingRecordedTracks, stopTrackingService, trackingStatus, type Fix } from '../track/location';
import { routeNameOf, trackTitle } from '../track/names';
import { TrackRecorder, fillMissingElevations } from '../track/recorder';
import { saveSettings, settings } from '../settings';
import { $, fmtM, onLongPress } from '../ui/dom';
import { dem, geolocate, map, mapReady } from './mapView';
import { refreshTrackList } from './tracks';
import { setProfileSource } from './profileView';
import { onReplayStopped, replayActive, startReplay, stopReplay } from './replay';
import { sheet } from './sheetView';
import { PLAN_REPLAY_ID, markTrackStale, planTrack, refreshNow, updateNav } from './nav';
import { suggestBatteryExemption } from './battery';
import { exitPocket, pocketActive } from './pocket';
import { checkOffRoute } from './offRouteAlert';
import { renderPhotos } from './photos';
import { state } from './state';
import { renderStatus, status } from './status';
import { nameFinishedTrack } from './trackNames';
import { collectFinished, collectWhileRecording } from './trackWeather';
import { drawTrackLine, offerTrim } from './trimView';

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
  // 記録中で気圧計があれば、気圧で補った標高（30秒ごとに求め直す）
  const baro = await recorder.currentAltitude();
  if (baro != null) {
    state.currentEle = baro;
    return;
  }
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
export function startGeolocate() {
  // 地図の読み込み前は、現在地ボタンの準備ができていないので、読み込んでから
  // （map.loaded() はタイルの読み込み中にも false になり、そのとき 'load' を待っても、もう来ないので使わない）
  if (!mapReady()) {
    map.once('load', startGeolocate);
    return;
  }
  if (geolocate._watchState === 'OFF') geolocate.trigger();
}

/** 現在地の表示をやめる（追従を外して背景になっているときに押すと現在地へ戻ってしまうので、追従中の扱いにしてから押す） */
export function stopGeolocate() {
  if (geolocate._watchState === 'OFF') return;
  if (geolocate._watchState === 'BACKGROUND') geolocate._watchState = 'ACTIVE_LOCK';
  geolocate.trigger();
}

/**
 * 地図が見えないあいだ（ポケット表示・シートの全画面）は、現在地を追いかけるのを一時的にやめる
 * （追いかけていると、測位のたびに地図が動いて、見えない地図を描き直すため。現在地の印は動く）。
 * 理由ごとに頼み、どれも残っていなくなったら、追いかけていたなら追いかけ直す（BACKGROUND で押すと、今の位置に戻って追いかける）
 */
const followPausedBy = new Set<string>();
let followWasOn = false;
export function pauseFollow(reason: string, pause: boolean) {
  if (pause) {
    if (followPausedBy.has(reason)) return;
    if (!followPausedBy.size) {
      followWasOn = geolocate._watchState === 'ACTIVE_LOCK';
      if (followWasOn) geolocate._watchState = 'BACKGROUND';
    }
    followPausedBy.add(reason);
  } else if (followPausedBy.delete(reason) && !followPausedBy.size) {
    if (followWasOn && geolocate._watchState === 'BACKGROUND') geolocate.trigger();
    followWasOn = false;
  }
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
/** 前に知らせを受けたときの、記録（id と状態）と、エラー・保存の失敗・画面点灯の印 */
let lastTrackKey = '';
let lastFlags = '';
let lastPointCount = 0;
let wasRecording = false;
export const recorder = new TrackRecorder(dem, (s) => {
  feedNativeFix(s.lastFix);
  // 記録を終えたとき（「記録終了」ボタン、またはアプリ版の通知の「停止」）
  const ended = wasRecording && !recorder.recording && s.track?.status === 'done';
  wasRecording = recorder.recording;
  if (s.track) state.shown = { track: s.track, points: s.points, all: s.points };
  else if (state.shown && !recorder.recording) state.shown = null;
  // 開始・終了はすぐ全部描き直す。エラー・保存の失敗・画面点灯が変わっただけなら、上の状態表示だけ（GPS が途切れがちだと
  // エラーが出たり消えたりするので、そのたびに記録の線全体を描き直さない）。点が増えただけなら、次にまとめて描き直す
  // （記録中は測位のたびに呼ばれ、アプリ版では画面を消していても届くため）
  const trackKey = `${s.track?.id}:${s.track?.status}`;
  const flags = `${s.error}:${s.saveFailed}:${s.wakeLock}`;
  const trackChanged = trackKey !== lastTrackKey;
  if (trackChanged) {
    // 記録していないときの clear()（記録を閉じた・別の記録を開いた・範囲を保存した）は、呼んだ側がこのあと描き直すので、ここでは描かない
    if (s.track || recorder.recording) {
      renderTrack();
      updateRecButton();
      updateNav();
    }
  } else {
    if (flags !== lastFlags) renderStatus();
    if (s.points.length !== lastPointCount) markTrackStale();
  }
  // 道迷いの判定は点が届いたらすぐ（画面を消していても知らせるため）
  if (s.points.length !== lastPointCount || trackChanged) checkOffRoute(s.points, recorder.recording);
  // 記録中は、電波があれば30分ごとに、そこまでの歩いた場所の雨（実際の天気）を残す
  if (recorder.recording && s.points.length !== lastPointCount) collectWhileRecording(s.track, s.points);
  lastTrackKey = trackKey;
  lastFlags = flags;
  lastPointCount = s.points.length;
  if (ended) onRecordingEnded(s.track!);
});

/** 記録を終えたら、その記録を開いたまま実績を見られるようにする */
function onRecordingEnded(t: Track) {
  exitPocket();
  stopGeolocate();
  status(`記録を保存しました：${formatDistance(t.distance)}・登り ${fmtM(t.ascent)}`);
  offerTrim(t);
  void fillShownElevations();
  void refreshTrackList();
  // 実際の天気（雨・空の様子・アメダスの気温と風）を取って残す（圏外なら、電波が戻ったとき・次にアプリを開いたときに）
  collectFinished(t, recorder.state.points);
  // 経路名がなければ付ける（今のルートの名前、なければ近くの山小屋・温泉などの名前）
  void nameFinishedTrack(t, recorder.state.points)
    .then((named) => {
      if (!named) return;
      // 描き直すだけ（点で決まる覚えは経路名を使わないので、revision は上げない）
      updateNav();
      void refreshTrackList();
    })
    .catch((e) => console.warn('経路名を付けられませんでした', e));
}
recorder.keepScreenOn = settings.wakeLock;

const recBtn = $<HTMLButtonElement>('btn-rec');
/** 押したあとの処理の途中（続けて押しても二重に始め・終えないように） */
let recBtnBusy = false;
recBtn.addEventListener('click', async () => {
  if (recBtnBusy) return;
  recBtnBusy = true;
  try {
    await onRecButton();
  } finally {
    recBtnBusy = false;
  }
});
async function onRecButton() {
  const wasRecording = recorder.recording;
  // 前回の途中の記録を確かめ終わるまで待つ（裏で続いていた記録を、新しい記録と取り違えないように）
  await unfinishedChecked;
  if (recorder.recording !== wasRecording) return; // 確かめているあいだに、裏の記録を続けた
  if (!recorder.recording) {
    if (!('geolocation' in navigator)) {
      alert('この端末・ブラウザでは位置情報が使えません');
      return;
    }
    if (!(await recorder.start(routeNameOf(state.route?.name) ?? undefined))) {
      log('位置情報が許可されていないため、記録を始められなかった');
      status('位置情報が許可されていないため、記録を始められません。端末の設定で許可してください', true);
      return;
    }
    // 記録を始めたら、出発時刻は現在時刻に
    if (settings.departAt) {
      settings.departAt = null;
      saveSettings();
    }
    startGeolocate();
    status('記録を開始しました。歩いた実績から到着予想を調整します');
    void suggestBatteryExemption();
  } else {
    if (!confirm('記録を終了しますか？')) return;
    await recorder.stop();
  }
  void refreshTrackList();
}

export function updateRecButton() {
  const rec = recorder.recording;
  recBtn.classList.toggle('recording', rec);
  recBtn.querySelector('.text')!.textContent = rec ? '記録終了' : '記録開始';
  // 保存した記録を開いているあいだは記録できない（リプレイと閉じるボタンにする）
  const viewing = viewingTrack();
  recBtn.hidden = viewing;
  $('view-actions').hidden = !viewing;
  // 記録中・記録を開いているときは写真、それ以外（計画）は地名の検索と記録の画面のボタンを同じ場所に出す
  $('btn-photo').hidden = !rec && !viewing;
  // ポケット表示は記録中だけ
  $('btn-pocket').hidden = !rec;
  $('btn-search').hidden = rec || viewing;
  $('btn-tracks').hidden = rec || viewing;
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

/**
 * 計画をリプレイする：今のルートを出発時刻・ペースの到着予想どおりに歩いたとして、予報の雲・雨・雪とともに見る
 * （途中から雨になるかなどが分かる）。リプレイを終えたら計画の画面に戻る
 */
export function replayPlan(opts: { capture?: boolean } = {}) {
  const plan = planTrack();
  if (!plan || recorder.recording) return;
  stopReplay();
  state.shown = { track: plan.track, points: plan.points, all: plan.points };
  setProfileSource('track');
  stopGeolocate();
  renderTrack();
  updateRecButton();
  updateNav();
  // 地図が見えるように、シートは半分まで（録画するなら一番下まで）下げる
  if (opts.capture) sheet.setState('mini');
  else if (sheet.isOpen) sheet.setState('half');
  startReplay(opts);
  updateRecButton();
}
// 計画のリプレイを終えたら、計画の画面に戻る
onReplayStopped(() => {
  if (state.shown?.track.id === PLAN_REPLAY_ID) closeTrack();
});
// 長押しで、録画しながらリプレイ（始めのタイトルから録画する）
onLongPress($('btn-replay'), () => {
  if (replayActive()) return;
  // 録画は地図の見えている部分を写すので、シートは一番下まで下げる
  sheet.setState('mini');
  startReplay({ capture: true });
  updateRecButton();
  status('録画しながらリプレイします（● か ✕ で止めると保存します）');
});
$('btn-replay').addEventListener('click', () => {
  if (replayActive()) stopReplay();
  else {
    // 地図が見えるように、シートは半分まで下げる
    if (sheet.isOpen) sheet.setState('half');
    startReplay();
  }
  updateRecButton();
});

/** 開いている記録のうち、標高が取れていない点（圏外だったときなど）を標高タイルから埋める */
export async function fillShownElevations() {
  const shown = state.shown;
  if (!shown || recorder.recording) return;
  const updated = await fillMissingElevations(shown.track, shown.all, (lng, lat) => dem.elevation(lng, lat)).catch((e) => {
    console.warn('標高を埋められませんでした', e);
    return null;
  });
  if (!updated || state.shown?.track.id !== updated.id) return;
  // 変わったのは登り・下りだけ（範囲や経路名は、埋めているあいだに変えたものを残す）
  state.shown = { ...state.shown, track: { ...state.shown.track, ascent: updated.ascent, descent: updated.descent } };
  state.revision++;
  updateNav();
  void refreshTrackList();
}

export function renderTrack() {
  // ポケット表示のあいだは地図を隠しているので描かない（隠れていても地図は描き直すため）。戻ったときに refreshNow で描く
  if (pocketActive()) {
    markTrackStale();
    return;
  }
  drawTrackLine();
  void renderPhotos();
}


/**
 * 前回、記録中のままアプリが閉じられていたら：
 *  - アプリ版で、裏で記録が続いていれば、そのまま続ける（履歴から消した・画面が止められたあと）
 *  - アプリ版で、通知の「停止」で止められていれば、そこまでで締める
 *  - それ以外（端末の再起動・Web 版で閉じた）は、続きを記録するか聞く
 * アプリ版は、裏で記録した測位を取り込んでから続ける・締める
 */
/** 前回の途中の記録を確かめ終わったら解決する（それまで「記録開始」は待つ） */
let unfinishedChecked: Promise<void> = Promise.resolve();
export function checkUnfinished(): Promise<void> {
  unfinishedChecked = resolveUnfinished().catch((e) => console.error('途中の記録を確かめられませんでした', e));
  return unfinishedChecked;
}

async function resolveUnfinished() {
  const tracks = await listTracks().catch(() => [] as Track[]);
  const native = await trackingStatus();
  // 記録のサービスが、IndexedDB にない（記録中でない）記録をしていたら止める（持ち主のいない記録）
  if (native?.recording && native.trackId && !tracks.some((t) => t.id === native.trackId && t.status === 'recording')) {
    log(`持ち主のいない記録のサービスを止めた（${native.trackId.slice(0, 8)}）`);
    await stopTrackingService(native.trackId);
  }
  const open = tracks.find((t) => t.status === 'recording');
  if (open) await resumeOrFinish(open, native);
  // 終えた記録で、端末に測位が残っているもの（終えるときに取り込めなかった）を取り込む
  for (const id of await pendingRecordedTracks()) {
    if (id === open?.id) continue;
    const done = tracks.find((t) => t.id === id && t.status === 'done');
    if (!done) continue;
    log(`終えた記録の、端末に残っていた測位を取り込む（${id.slice(0, 8)}）`);
    // 表示中の記録を変えないよう、別の TrackRecorder で取り込む
    await new TrackRecorder(dem, () => undefined).finish(done, done.endedAt);
    void refreshTrackList();
  }
}

async function resumeOrFinish(open: Track, native: Awaited<ReturnType<typeof trackingStatus>>) {
  log(`途中の記録がある（${open.id.slice(0, 8)}）: ${native?.recording && native.trackId === open.id ? '裏で記録が続いている' : native?.stoppedTrack === open.id ? '通知で止められていた' : '止まっていた'}`);
  if (native?.recording && native.trackId === open.id) {
    await recorder.resume(open);
    startGeolocate();
    status('裏で続けていた記録を取り込みました');
  } else if (native && native.stoppedTrack === open.id) {
    await recorder.finish(open, native.stoppedAt ?? undefined);
    void refreshTrackList();
  } else if (confirm(`「${trackTitle(open)}」の記録が途中です。続きを記録しますか？\n（キャンセルするとここまでで保存します）`)) {
    await recorder.resume(open);
    startGeolocate();
  } else {
    await recorder.finish(open);
    void refreshTrackList();
  }
}
