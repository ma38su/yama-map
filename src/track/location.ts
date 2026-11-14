/**
 * 記録用の測位の取得元。
 *  - Web(PWA): navigator.geolocation.watchPosition（画面オフ・バックグラウンドでは止まる）
 *  - Androidアプリ(Capacitor): ネイティブのバックグラウンド測位。通知を出し続けるフォアグラウンドサービスで、
 *    画面を消しても記録が続く
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
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
}

/** denied: 位置情報が許可されていない / unavailable: 一時的に取得できない */
export type FixError = 'denied' | 'unavailable';

export interface LocationWatch {
  stop(): void;
}

/** 画面オフでも記録を続けられるか（ネイティブアプリなら true） */
export const backgroundCapable = Capacitor.isNativePlatform();

type PermissionState = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale';
interface LocationPermissions {
  location: PermissionState;
}
// checkPermissions / requestPermissions は Capacitor の Plugin 基底クラスが用意している（型定義には無い）
const BackgroundGeolocation = registerPlugin<
  BackgroundGeolocationPlugin & {
    checkPermissions(): Promise<LocationPermissions>;
    requestPermissions(): Promise<LocationPermissions>;
  }
>('BackgroundGeolocation');

/**
 * 記録を始める前に、通知と位置情報の許可を1つずつ順番に求める（watchLocation の前に呼ぶ）。
 * 地図の現在地表示（WebViewの位置情報）と同時に許可を求めると、許可ダイアログが2枚重なり、
 * Androidのタップ乗っ取り対策で下のダイアログが押せなくなるため、先にここで済ませておく。
 */
export async function requestTrackingPermissions(): Promise<void> {
  if (!backgroundCapable) return;
  await requestNotificationPermission();
  try {
    const { location } = await BackgroundGeolocation.checkPermissions();
    if (location !== 'granted') await BackgroundGeolocation.requestPermissions();
  } catch (e) {
    console.error(e);
  }
}

export function watchLocation(onFix: (f: Fix) => void, onError: (e: FixError) => void): LocationWatch {
  return backgroundCapable ? watchNative(onFix, onError) : watchWeb(onFix, onError);
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

function watchNative(onFix: (f: Fix) => void, onError: (e: FixError) => void): LocationWatch {
  let stopped = false;
  const idPromise = addWatcherWithRetry(() =>
    BackgroundGeolocation.addWatcher(
      {
        // これを指定すると、バックグラウンドでも通知を出して測位を続ける
        backgroundTitle: 'やまマップで記録中',
        backgroundMessage: '画面を消しても軌跡を記録しています',
        // 許可は requestTrackingPermissions で求め済み。拒否されていれば NOT_AUTHORIZED が返る
        requestPermissions: false,
        stale: false,
        distanceFilter: 0,
      },
      (loc, err) => {
        if (err) {
          if (err.code === 'NOT_AUTHORIZED') {
            onError('denied');
            if (confirm('記録には位置情報の許可が必要です。設定を開きますか？')) {
              void BackgroundGeolocation.openSettings();
            }
          } else {
            onError('unavailable');
          }
          return;
        }
        if (!loc) return;
        onFix({
          lng: loc.longitude,
          lat: loc.latitude,
          accuracy: loc.accuracy,
          altitude: loc.altitude,
          timestamp: loc.time ?? Date.now(),
        });
      },
    ),
  );
  // 先に stop された場合も、登録が終わり次第はずす
  void idPromise
    .then(async (id) => {
      if (stopped) await BackgroundGeolocation.removeWatcher({ id });
    })
    .catch((e) => {
      console.error(e);
      onError('unavailable');
    });
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      void idPromise.then((id) => BackgroundGeolocation.removeWatcher({ id })).catch(() => undefined);
    },
  };
}

/** 起動直後はプラグインの測位サービスがまだ接続されておらず "Service not running." で失敗することがあるので、少し待って再試行する */
async function addWatcherWithRetry(add: () => Promise<string>): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await add();
    } catch (e) {
      if (i >= 5 || !String((e as Error)?.message).includes('Service not running')) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
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
