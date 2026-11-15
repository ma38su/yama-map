/**
 * 記録用の測位の取得元。
 *  - Web(PWA): navigator.geolocation.watchPosition（画面オフ・バックグラウンドでは止まる）
 *  - Androidアプリ(Capacitor): アプリの中のフォアグラウンドサービス（android/…/TrackingService.java）が測位し、
 *    届いた測位をその場で端末に保存する。画面を消しても、アプリを履歴から消しても記録が続く。
 *    JS は、サービスが保存するたびに届く知らせ（最大20秒ぶんまとめて。止まっていれば届かない）と、
 *    表に出たときに、たまった測位を取り込む。WebView が止まっていた間の測位も、次に取り込まれる
 */
import type { PluginListenerHandle } from '@capacitor/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { log } from '../log';

export interface Fix {
  lng: number;
  lat: number;
  /** 水平精度 (m) */
  accuracy: number;
  /** GPSの高度 (m) */
  altitude: number | null;
  /** 測位時刻 (ms) */
  timestamp: number;
  /** 気圧 (hPa)。アプリ版で測位と一緒に残したもの（undefined ならその場で気圧計を読む） */
  hpa?: number | null;
  /** 記録を始めてからの歩数。アプリ版で歩数計があり、身体活動の許可があるときだけ */
  steps?: number | null;
  /** まとめて取り込んでいる途中で、すぐ後に続きがある（保存は最後の1点でまとめて行う） */
  more?: boolean;
}

/** denied: 位置情報が許可されていない / unavailable: 一時的に取得できない */
export type FixError = 'denied' | 'unavailable';

export interface LocationWatch {
  /**
   * 測位をやめる。アプリ版は、まだ取り込んでいない測位をすべて渡し終えてから返る。
   * 取り込みに失敗して端末側に測位が残っていれば false（そのときは端末側の測位を消さない）
   */
  stop(): Promise<boolean> | void;
}

export interface WatchOptions {
  trackId: string;
  startedAt: number;
  /** これより前の時刻 (ms) の測位は取り込み済みとして渡さない（記録の再開で同じ点を二重にしない） */
  since: number;
  /** 通知の「停止」で記録が止められたとき（アプリ版だけ）。止めた時刻 (ms) */
  onEnded?: (endedAt: number) => void;
}

/** 画面オフでも記録を続けられるか（ネイティブアプリなら true） */
export const backgroundCapable = Capacitor.isNativePlatform();

type PermissionState = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale';
interface StoredFix {
  id: number;
  t: number;
  lat: number;
  lng: number;
  acc: number;
  alt: number | null;
  hpa: number | null;
  steps?: number | null;
}
export interface TrackingStatus {
  recording: boolean;
  trackId: string | null;
  /** 通知の「停止」で止められた記録と、その時刻 */
  stoppedTrack: string | null;
  stoppedAt: number | null;
  /** 今の気圧 (hPa) とその時刻（記録中で気圧計があれば） */
  hPa: number | null;
  hPaAt: number;
}
interface TrackingPlugin {
  start(o: { trackId: string; startedAt: number }): Promise<void>;
  /** trackId を渡すと、その記録をしているときだけ止める */
  stop(o?: { trackId?: string }): Promise<void>;
  status(): Promise<TrackingStatus>;
  pendingTracks(): Promise<{ tracks: string[] }>;
  /** afterT を渡すと、その時刻より後の測位だけ（記録を続けるときの最初の取り込み。取り込み済みの点をブリッジに通さない） */
  getFixes(o: { trackId: string; afterId: number; limit: number; afterT?: number }): Promise<{ fixes: StoredFix[] }>;
  clearFixes(o: { trackId: string }): Promise<void>;
  checkPermissions(): Promise<{ location: PermissionState; activity: PermissionState }>;
  requestPermissions(o?: { permissions: ('location' | 'activity')[] }): Promise<{ location: PermissionState; activity: PermissionState }>;
  /** fixes: 測位を保存した / stopped: 通知の「停止」で止めた */
  addListener(event: 'fixes' | 'stopped', fn: () => void): Promise<PluginListenerHandle>;
  batteryOptimization(): Promise<{ ignoring: boolean }>;
  openBatterySettings(): Promise<void>;
  diagnostics(): Promise<NativeDiagnostics>;
  getLog(o: { limit: number }): Promise<{ lines: { t: number; msg: string }[] }>;
  clearLog(): Promise<void>;
  getLogcat(o: { lines: number }): Promise<{ text: string }>;
}

/** アプリ版の端末とアプリの状態（メニューの「動作の記録」） */
export interface NativeDiagnostics {
  device: string;
  android: string;
  app: string;
  webview: string;
  location: string;
  locationEnabled: boolean;
  notifications: boolean;
  batteryOptimized: boolean;
  powerSave: boolean;
  serviceRunning: boolean;
  serviceTrack: string | null;
  pendingFixes: number;
  /** 歩数計・大きな動きのセンサーがあるか、身体活動の許可があるか */
  stepCounter: boolean;
  motionSensor: boolean;
  activity: boolean;
  /** アプリが最近終了した理由（新しい順に5回。Android 11 から） */
  exits?: { t: number; reason: string; description: string | null; importance: string }[];
}
const Tracking = registerPlugin<TrackingPlugin>('Tracking');

/** 1回に取り込む測位の数 */
const BATCH = 500;
/** これより古い気圧は使わない（気圧計が止まっていた） */
const PRESSURE_STALE_MS = 2 * 60_000;

/**
 * 記録を始める前に、通知と位置情報の許可を1つずつ順番に求める（watchLocation の前に呼ぶ）。
 * 地図の現在地表示（WebViewの位置情報）と同時に許可を求めると、許可ダイアログが2枚重なり、
 * Androidのタップ乗っ取り対策で下のダイアログが押せなくなるため、先にここで済ませておく。
 * 位置情報が使えないと分かっているときだけ false（分からないときは true にして、測位のエラーに任せる）
 */
export async function requestTrackingPermissions(): Promise<boolean> {
  if (!backgroundCapable) {
    // Web はブラウザが聞くので、拒否済みかどうかだけ確かめる
    try {
      return (await navigator.permissions.query({ name: 'geolocation' })).state !== 'denied';
    } catch {
      return true;
    }
  }
  await requestNotificationPermission();
  try {
    let { location } = await Tracking.checkPermissions();
    if (location !== 'granted') ({ location } = await Tracking.requestPermissions({ permissions: ['location'] }));
    if (location === 'granted') await requestActivityPermission();
    return location === 'granted';
  } catch (e) {
    console.error(e);
    return true;
  }
}

/**
 * 歩数計の身体活動の許可を求める（記録に歩数を残し、止まっているあいだは測位を間引いて電池を節約する）。
 * 断られても記録はできる（歩数は残さず、測位も間引かない）。一度断られたら聞き直さない
 */
async function requestActivityPermission(): Promise<void> {
  try {
    const { activity } = await Tracking.checkPermissions();
    if (activity === 'prompt' || activity === 'prompt-with-rationale') await Tracking.requestPermissions({ permissions: ['activity'] });
  } catch (e) {
    console.warn('身体活動の許可を求められませんでした', e);
  }
}

export function watchLocation(onFix: (f: Fix) => void, onError: (e: FixError) => void, opts: WatchOptions): LocationWatch {
  return backgroundCapable ? watchNative(onFix, onError, opts) : watchWeb(onFix, onError);
}

function watchWeb(onFix: (f: Fix) => void, onError: (e: FixError) => void): LocationWatch {
  const id = navigator.geolocation.watchPosition(
    (pos) =>
      onFix({
        lng: pos.coords.longitude,
        lat: pos.coords.latitude,
        accuracy: pos.coords.accuracy,
        altitude: pos.coords.altitude,
        timestamp: pos.timestamp,
      }),
    (err) => {
      // TIMEOUT は立ち止まっているだけでも起きうるので無視（timeout 未指定なら通常は発生しない）
      if (err.code === err.TIMEOUT) return;
      onError(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
    },
    { enableHighAccuracy: true, maximumAge: 0 },
  );
  return { stop: () => navigator.geolocation.clearWatch(id) };
}

/**
 * 端末に保存された測位のうち、番号が afterId より後のものを onFix に渡す。最後の番号と渡した数を返す。
 * since より前の時刻の測位は、もう IndexedDB にある（記録を続けるときの最初の取り込み）ので渡さない。
 * 2回目からは番号だけで重ならないので、since は -Infinity にする（端末の時計が戻されても点を捨てないように）
 */
async function drainFixes(
  trackId: string,
  afterId: number,
  since: number,
  onFix: (f: Fix) => void,
): Promise<{ afterId: number; count: number }> {
  let count = 0;
  // 取り込み済みの点（since より前）は、端末の側ではじく（記録を続けるたびに、記録の全部の測位をブリッジに通して捨てないように）
  const afterT = Number.isFinite(since) ? { afterT: since } : {};
  for (;;) {
    const { fixes } = await Tracking.getFixes({ trackId, afterId, limit: BATCH, ...afterT });
    // 番号が進まなければ（同じ測位が返ってくる）、同じものを何度も取り込まないようやめる
    if (fixes.length && fixes[0].id <= afterId) throw new Error(`記録の測位の取り込みが進みません（${afterId}）`);
    const fresh = fixes.filter((f) => f.t > since);
    fresh.forEach((f, i) =>
      onFix({
        lng: f.lng,
        lat: f.lat,
        accuracy: f.acc,
        altitude: f.alt,
        timestamp: f.t,
        hpa: f.hpa,
        steps: f.steps ?? null,
        more: i < fresh.length - 1,
      }),
    );
    if (fixes.length) afterId = fixes[fixes.length - 1].id;
    count += fresh.length;
    if (fixes.length < BATCH) return { afterId, count };
  }
}

function watchNative(onFix: (f: Fix) => void, onError: (e: FixError) => void, opts: WatchOptions): LocationWatch {
  let afterId = 0;
  /** 最初の取り込みだけ、時刻で取り込み済みの点をはじく */
  let since = opts.since;
  let stopped = false;
  // 取り込みは1つずつ順に行う
  let busy: Promise<void> = Promise.resolve();
  /** reason はログ用。サービスからの知らせのたびの取り込みは、多いときだけログに残す */
  const drain = async (reason: string) => {
    const c = await drainFixes(opts.trackId, afterId, since, onFix);
    afterId = c.afterId;
    since = -Infinity;
    if (c.count && (reason !== '知らせ' || c.count >= 30)) log(`記録の測位を取り込んだ: ${c.count}件（${reason}）`);
  };
  /** checkStatus：通知の「停止」で止められていないか確かめる（停止の知らせ・表に戻ったとき・開始のときだけ） */
  const poll = (reason: string, checkStatus = true) => {
    busy = busy
      .then(async () => {
        if (stopped) return;
        await drain(reason);
        if (!checkStatus) return;
        const s = await Tracking.status();
        if (!stopped && !s.recording && s.stoppedTrack === opts.trackId) {
          log('通知の「停止」で止められたので、記録を締める');
          opts.onEnded?.(s.stoppedAt ?? Date.now());
        }
      })
      .catch((e) => console.error('記録の取り込みに失敗しました', e));
    return busy;
  };
  // サービスからの知らせ（WebView が止まっていて届かなかった分は、表に出たときに取り込む）
  const listeners = [Tracking.addListener('fixes', () => void poll('知らせ', false)), Tracking.addListener('stopped', () => void poll('停止の知らせ'))];
  const onVisibility = () => document.visibilityState === 'visible' && void poll('表に戻った');
  document.addEventListener('visibilitychange', onVisibility);
  void Tracking.start({ trackId: opts.trackId, startedAt: opts.startedAt })
    .then(() => poll('開始'))
    .catch((e) => {
      console.error(e);
      onError((e as { code?: string })?.code === 'NOT_AUTHORIZED' ? 'denied' : 'unavailable');
    });
  return {
    async stop() {
      if (stopped) return true;
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      for (const l of listeners) void l.then((h) => h.remove());
      await busy;
      // まとめて受け取る途中の測位も保存させてから、残りを取り込む（この記録をしているときだけ止める）
      await Tracking.stop({ trackId: opts.trackId }).catch((e) => console.error(e));
      try {
        await drain('終了');
        return true;
      } catch (e) {
        console.error('記録の取り込みに失敗しました（端末に残し、次に開いたときに取り込みます）', e);
        return false;
      }
    },
  };
}

/** アプリ版の記録の状態（Web では null） */
export async function trackingStatus(): Promise<TrackingStatus | null> {
  if (!backgroundCapable) return null;
  return Tracking.status().catch(() => null);
}

/** 端末に残っている、記録の測位をすべて取り込む（記録を締めるとき。Web では何もしない） */
export async function readRecordedFixes(trackId: string, since: number, onFix: (f: Fix) => void): Promise<void> {
  if (!backgroundCapable) return;
  const { count } = await drainFixes(trackId, 0, since, onFix);
  log(`途中で閉じた記録の測位を取り込んだ: ${count}件`);
}

/** まだ取り込まれていない測位が端末に残っている記録の id（Web では空） */
export async function pendingRecordedTracks(): Promise<string[]> {
  if (!backgroundCapable) return [];
  return (await Tracking.pendingTracks().catch(() => ({ tracks: [] as string[] }))).tracks;
}

/** 記録のサービスを止める（持ち主の記録がないまま動いているとき。Web では何もしない） */
export async function stopTrackingService(trackId: string): Promise<void> {
  if (backgroundCapable) await Tracking.stop({ trackId }).catch((e) => console.error(e));
}

/** 今の気圧 (hPa)。アプリ版で記録中、気圧計があり、値が新しいときだけ（ほかは null） */
export async function currentPressure(): Promise<number | null> {
  if (!backgroundCapable) return null;
  const s = await Tracking.status().catch(() => null);
  return s?.hPa != null && Date.now() - s.hPaAt < PRESSURE_STALE_MS ? s.hPa : null;
}

/** アプリ版の端末とアプリの状態・記録のサービスのログ・logcat（メニューの「動作の記録」。Web では null） */
export async function nativeReport(): Promise<{ diag: NativeDiagnostics; log: string[]; logcat: string } | null> {
  if (!backgroundCapable) return null;
  const [diag, nlog, logcat] = await Promise.all([
    Tracking.diagnostics(),
    Tracking.getLog({ limit: 300 }).catch(() => ({ lines: [] })),
    Tracking.getLogcat({ lines: 400 }).catch((e) => ({ text: `logcat を読めませんでした: ${e}` })),
  ]);
  return { diag, log: nlog.lines.reverse().map((l) => `${new Date(l.t).toLocaleString('ja-JP')} ${l.msg}`), logcat: logcat.text };
}

export async function clearNativeLog(): Promise<void> {
  if (backgroundCapable) await Tracking.clearLog().catch(() => undefined);
}

/** IndexedDB に保存し終えた記録の測位を、端末から消す（Web では何もしない） */
export async function clearRecordedFixes(trackId: string): Promise<void> {
  if (backgroundCapable) await Tracking.clearFixes({ trackId }).catch((e) => console.error(e));
}

/** 電池の最適化の対象か（アプリ版だけ。Web・分からないときは null） */
export async function batteryOptimized(): Promise<boolean | null> {
  if (!backgroundCapable) return null;
  return Tracking.batteryOptimization()
    .then((r) => !r.ignoring)
    .catch(() => null);
}

/** 電池の最適化から外す画面を開く（アプリ版だけ） */
export async function openBatterySettings(): Promise<void> {
  if (backgroundCapable) await Tracking.openBatterySettings().catch((e) => console.error(e));
}

/** Android 13+ では記録中の通知を出すのに通知の許可が要る（拒否されても測位自体は続く） */
async function requestNotificationPermission(): Promise<void> {
  try {
    const { display } = await LocalNotifications.checkPermissions();
    if (display === 'prompt' || display === 'prompt-with-rationale') await LocalNotifications.requestPermissions();
  } catch {
    // 通知が出せなくても記録はできるので無視
  }
}
