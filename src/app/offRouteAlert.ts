/**
 * 道迷いアラート：記録中にルートから離れたら、振動と通知で知らせる。
 * 記録の点が増えるたび（recording.ts）に呼ぶ。アプリ版は画面を消していても測位が届くので、
 * 画面がオフでも通知チャンネルの振動で気づける。Web 版は画面が点いているあいだだけ振動する
 */
import { LocalNotifications } from '@capacitor/local-notifications';
import { formatDistance } from '../geo';
import { projectOnRoute } from '../nav/eta';
import { newOffRouteState, stepOffRoute, type OffRouteEvent } from '../nav/offRoute';
import type { ActiveRoute } from '../nav/plan';
import type { TrackPoint } from '../track/db';
import { backgroundCapable } from '../track/location';
import { settings } from '../settings';
import { state } from './state';
import { status } from './status';

const CHANNEL = 'off-route';
const NOTIFY_ID = 7001;
const VIBRATE = [400, 200, 400, 200, 400];
/**
 * 知らせるのは、最新の点がこれより新しいときだけ。アプリ版で裏で記録していた点をあとからまとめて取り込んだとき、
 * 過ぎたことで何度も鳴らさないように
 */
const FRESH_MS = 3 * 60_000;

let s = newOffRouteState();
let route: ActiveRoute | null = null;
let trackId: string | undefined;
let checked = 0;
let along: number | undefined;
/** 「離れています」を知らせて、まだ「戻った」を知らせていない */
let notified = false;
/** 通知を出す・消すは、出した順に行う（消すほうが先に届いて、通知が残らないように） */
let chain: Promise<void> = Promise.resolve();
const enqueue = (fn: () => Promise<void>) => {
  chain = chain.then(fn).catch(() => undefined);
};
function resetNotice() {
  if (notified) enqueue(clearNotice);
  notified = false;
}

let channelReady: Promise<void> | null = null;
function ensureChannel(): Promise<void> {
  // 振動するかどうかはチャンネルで決まる（一度作ると、あとから変えられない）
  channelReady ??= LocalNotifications.createChannel({
    id: CHANNEL,
    name: '道迷いアラート',
    description: '記録中にルートから離れたときのお知らせ',
    importance: 5,
    visibility: 1,
    vibration: true,
  }).catch((e) => console.warn('通知チャンネルを作れませんでした', e));
  return channelReady;
}

/** 記録の新しい点を見て、ルートから離れた・戻ったら知らせる */
export function checkOffRoute(points: TrackPoint[], recording: boolean) {
  const r = state.route;
  const id = points[0]?.trackId;
  // ルートや記録が変わったら数え直す
  if (r !== route || id !== trackId || !recording) {
    resetNotice();
    route = r;
    trackId = id;
    s = newOffRouteState();
    checked = recording ? Math.max(0, points.length - 1) : points.length;
    along = undefined;
  }
  if (!r || !recording || !settings.offRouteAlert) {
    // 離れている最中にオフにしたら、出ている通知も消す
    resetNotice();
    checked = points.length;
    return;
  }
  // まとめて取り込んだ点は状態だけ進め、最後の出来事を1回だけ知らせる
  let last: { ev: Exclude<OffRouteEvent, null>; offset: number } | null = null;
  for (; checked < points.length; checked++) {
    const p = points[checked];
    const pos = projectOnRoute(r.coords, r.dists, [p.lng, p.lat], along);
    if (!pos) continue;
    along = pos.along;
    const ev = stepOffRoute(s, pos.offset, p.t);
    if (ev) last = { ev, offset: pos.offset };
  }
  const latest = points.at(-1);
  if (!last || !latest || Date.now() - latest.t > FRESH_MS) return;
  if (last.ev === 'back') {
    if (notified) status('ルートに戻りました');
    resetNotice();
  } else {
    const { offset } = last;
    const again = notified;
    enqueue(() => notify(offset, again));
    notified = true;
  }
}

async function notify(offset: number, again: boolean) {
  const title = again ? 'まだルートから離れています' : 'ルートから離れています';
  const body = `ルートから約 ${formatDistance(offset)} 離れています。地図で道を確かめてください`;
  status(`${title}（約 ${formatDistance(offset)}）`, true);
  if (document.visibilityState === 'visible') navigator.vibrate?.(VIBRATE);
  if (!backgroundCapable) return;
  try {
    await ensureChannel();
    // isExactNotification は既定で true で、その場合プラグインは、すぐ出す通知でも「アラームとリマインダー」の許可がなければ
    // （Android 14 から新しく入れたアプリは既定で許可なし）その設定画面を開き、戻るまで通知を出さない（画面オフでは出ない）
    await LocalNotifications.schedule({ notifications: [{ id: NOTIFY_ID, title, body, channelId: CHANNEL, isExactNotification: false }] });
  } catch (e) {
    console.warn('通知を出せませんでした', e);
  }
}

async function clearNotice() {
  if (!backgroundCapable) return;
  // 出ている通知を消す（cancel は予約中の通知しか消さない）。cancel は、端末を再起動したときに出し直さないための印
  await LocalNotifications.removeDeliveredNotificationsById({ ids: [NOTIFY_ID] }).catch(() => undefined);
  await LocalNotifications.cancel({ notifications: [{ id: NOTIFY_ID }] }).catch(() => undefined);
}
