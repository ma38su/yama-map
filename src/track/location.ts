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
  /** まとめて取り込んでいる途中で、すぐ後に続きがある（保存は最後の1点でまとめて行う） */
  more?: boolean;
}

/** denied: 位置情報が許可されていない / unavailable: 一時的に取得できない */
export type FixError = 'denied' | 'unavailable';

export interface LocationWatch {
  /** 測位をやめる。アプリ版は、まだ取り込んでいない測位をすべて渡し終えてから返る */
  stop(): Promise<void> | void;
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
}
export interface TrackingStatus {
  recording: boolean;
  trackId: string | null;
  /** 通知の「停止」で止められた記録と、その時刻 */
  stoppedTrack: string | null;
  stoppedAt: number | null;
}
interface TrackingPlugin {
  start(o: { trackId: string; startedAt: number }): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<TrackingStatus>;
  getFixes(o: { trackId: string; afterId: number; limit: number }): Promise<{ fixes: StoredFix[] }>;
  clearFixes(o: { trackId: string }): Promise<void>;
  checkPermissions(): Promise<{ location: PermissionState }>;
  requestPermissions(o?: { permissions: 'location'[] }): Promise<{ location: PermissionState }>;
  /** fixes: 測位を保存した / stopped: 通知の「停止」で止めた */
  addListener(event: 'fixes' | 'stopped', fn: () => void): Promise<PluginListenerHandle>;
  batteryOptimization(): Promise<{ ignoring: boolean }>;
  openBatterySettings(): Promise<void>;
}
const Tracking = registerPlugin<TrackingPlugin>('Tracking');

/** 1回に取り込む測位の数 */
const BATCH = 500;

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
    return location === 'granted';
  } catch (e) {
    console.error(e);
    return true;
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

/** 端末に保存された測位のうち、番号が afterId より後のものを、since より後の時刻のものだけ onFix に渡す。最後の番号を返す */
async function drainFixes(trackId: string, afterId: number, since: number, onFix: (f: Fix) => void): Promise<{ afterId: number; since: number }> {
  for (;;) {
    const { fixes } = await Tracking.getFixes({ trackId, afterId, limit: BATCH });
    const fresh = fixes.filter((f) => f.t > since);
    fresh.forEach((f, i) =>
      onFix({
        lng: f.lng,
        lat: f.lat,
        accuracy: f.acc,
        altitude: f.alt,
        timestamp: f.t,
        hpa: f.hpa,
        more: i < fresh.length - 1,
      }),
    );
    if (fixes.length) afterId = fixes[fixes.length - 1].id;
    if (fresh.length) since = fresh[fresh.length - 1].t;
    if (fixes.length < BATCH) return { afterId, since };
  }
}

function watchNative(onFix: (f: Fix) => void, onError: (e: FixError) => void, opts: WatchOptions): LocationWatch {
  let cursor = { afterId: 0, since: opts.since };
  let stopped = false;
  // 取り込みは1つずつ順に行う
  let busy: Promise<void> = Promise.resolve();
  const drain = () => drainFixes(opts.trackId, cursor.afterId, cursor.since, onFix).then((c) => void (cursor = c));
  const poll = () => {
    busy = busy
      .then(async () => {
        if (stopped) return;
        await drain();
        const s = await Tracking.status();
        // 通知の「停止」で止められた
        if (!stopped && !s.recording && s.stoppedTrack === opts.trackId) opts.onEnded?.(s.stoppedAt ?? Date.now());
      })
      .catch((e) => console.error('記録の取り込みに失敗しました', e));
    return busy;
  };
  // サービスからの知らせ（WebView が止まっていて届かなかった分は、表に出たときに取り込む）
  const listeners = [Tracking.addListener('fixes', () => void poll()), Tracking.addListener('stopped', () => void poll())];
  const onVisibility = () => document.visibilityState === 'visible' && void poll();
  document.addEventListener('visibilitychange', onVisibility);
  void Tracking.start({ trackId: opts.trackId, startedAt: opts.startedAt })
    .then(poll)
    .catch((e) => {
      console.error(e);
      onError((e as { code?: string })?.code === 'NOT_AUTHORIZED' ? 'denied' : 'unavailable');
    });
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      for (const l of listeners) void l.then((h) => h.remove());
      await busy;
      // まとめて受け取る途中の測位も保存させてから、残りを取り込む
      await Tracking.stop().catch((e) => console.error(e));
      await drain().catch((e) => console.error('記録の取り込みに失敗しました', e));
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
  if (backgroundCapable) await drainFixes(trackId, 0, since, onFix);
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
