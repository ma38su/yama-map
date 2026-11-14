/**
 * 道迷いの判定。記録の点が増えるたびに、ルートからの距離を渡して呼ぶ。
 *  - 一度ルートの近く（ARM_M 以内）を歩くまでは何もしない（駐車場から登山口へ向かうあいだに鳴らさない）
 *  - OFF_M 以上離れた点が CONFIRM 回続いたら「離れた」。GPS の一瞬の跳ねでは鳴らさない
 *  - 離れたままなら REPEAT_MS ごとにもう一度知らせる
 *  - BACK_M 以内に戻ったら「戻った」
 *  - MAX_M 以上離れているとき（車で移動した・別の場所にいる）は数えない
 */
export const OFF_ROUTE = { ARM_M: 60, OFF_M: 100, BACK_M: 60, CONFIRM: 2, REPEAT_MS: 5 * 60_000, MAX_M: 5000 } as const;

export interface OffRouteState {
  armed: boolean;
  off: boolean;
  streak: number;
  alertedAt: number;
}
export type OffRouteEvent = 'off' | 'still-off' | 'back' | null;

export const newOffRouteState = (): OffRouteState => ({ armed: false, off: false, streak: 0, alertedAt: 0 });

/** offset：ルートからの距離 (m)、t：その点の時刻 (ms)。s を書き換えて、知らせることがあれば返す */
export function stepOffRoute(s: OffRouteState, offset: number, t: number): OffRouteEvent {
  if (offset >= OFF_ROUTE.MAX_M) return null;
  if (!s.armed) {
    if (offset <= OFF_ROUTE.ARM_M) s.armed = true;
    return null;
  }
  if (!s.off) {
    s.streak = offset >= OFF_ROUTE.OFF_M ? s.streak + 1 : 0;
    if (s.streak < OFF_ROUTE.CONFIRM) return null;
    s.off = true;
    s.alertedAt = t;
    return 'off';
  }
  if (offset <= OFF_ROUTE.BACK_M) {
    s.off = false;
    s.streak = 0;
    return 'back';
  }
  if (t - s.alertedAt >= OFF_ROUTE.REPEAT_MS) {
    s.alertedAt = t;
    return 'still-off';
  }
  return null;
}
