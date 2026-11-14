/** 方位（北から時計回りの度）の計算。端末の向きのセンサーの値から、画面の上が向いている方位を求める */

/** 0〜360 に収める */
export const norm360 = (deg: number) => ((deg % 360) + 360) % 360;

/** a から b へ回るときの最小の角度（-180〜180） */
export const angleDiff = (a: number, b: number) => norm360(b - a + 180) - 180;

/**
 * 画面の上が向いている方位。
 *  - iOS は webkitCompassHeading（北から時計回り）がそのまま使える
 *  - Android（deviceorientationabsolute）は alpha が反時計回りなので 360 - alpha
 * screenAngle は画面の回転（横持ちで 90 など）
 */
export function headingFrom(e: { alpha: number | null; absolute?: boolean; webkitCompassHeading?: number }, screenAngle = 0): number | null {
  if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) return norm360(e.webkitCompassHeading + screenAngle);
  if (e.alpha == null || !e.absolute) return null;
  return norm360(360 - e.alpha + screenAngle);
}

/** 方位をなめらかにする（359° と 1° の間を正しくつなぐ） */
export function smoothHeading(prev: number | null, next: number, k = 0.25): number {
  if (prev == null) return next;
  return norm360(prev + angleDiff(prev, next) * k);
}
