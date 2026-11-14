/**
 * 道迷いアラート：記録中にルートから離れたら、振動と通知で知らせる。
 * 記録の点が増えるたび（recording.ts）に呼ぶ。アプリ版は画面を消していても測位が届くので、
 * 画面がオフでも通知チャンネルの振動で気づける。Web 版は画面が点いているあいだだけ振動する
 */
import { LocalNotifications } from '@capacitor/local-notifications';
import { formatDistance } from '../geo';
import { projectOnRoute } from '../nav/eta';
import { newOffRouteState, stepOffRoute } from '../nav/offRoute';
import type { ActiveRoute } from '../nav/plan';
import type { TrackPoint } from '../track/db';
import { backgroundCapable } from '../track/location';
import { settings } from '../settings';
import { state } from './state';
import { status } from './status';

const CHANNEL = 'off-route';
const NOTIFY_ID = 7001;
const VIBRATE = [400, 200, 400, 200, 400];

let s = newOffRouteState();
let route: ActiveRoute | null = null;
let trackId: string | undefined;
let checked = 0;
let along: number | undefined;

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
    if (s.off) void clearNotice();
    route = r;
    trackId = id;
    s = newOffRouteState();
    checked = recording ? Math.max(0, points.length - 1) : points.length;
    along = undefined;
  }
  if (!r || !recording || !settings.offRouteAlert) {
    checked = points.length;
    return;
  }
  for (; checked < points.length; checked++) {
    const p = points[checked];
    const pos = projectOnRoute(r.coords, r.dists, [p.lng, p.lat], along);
    if (!pos) continue;
    along = pos.along;
    const ev = stepOffRoute(s, pos.offset, p.t);
    if (ev === 'off' || ev === 'still-off') void notify(pos.offset, ev === 'still-off');
    else if (ev === 'back') {
      void clearNotice();
      status('ルートに戻りました');
    }
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
    await LocalNotifications.schedule({ notifications: [{ id: NOTIFY_ID, title, body, channelId: CHANNEL }] });
  } catch (e) {
    console.warn('通知を出せませんでした', e);
  }
}

async function clearNotice() {
  if (!backgroundCapable) return;
  await LocalNotifications.cancel({ notifications: [{ id: NOTIFY_ID }] }).catch(() => undefined);
}
