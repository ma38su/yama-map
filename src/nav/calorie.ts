/**
 * 消費エネルギーの目安（kcal）。山本正嘉の「コース定数」に体重と荷物の重さをかける見積もり：
 * （1.8×歩行時間[h] ＋ 0.3×距離[km] ＋ 10.0×登りの累積標高[km] ＋ 0.6×下りの累積標高[km]）×（体重＋荷物）[kg]
 * コース定数の歩行時間はコースタイムだが、ここでは歩いた（計画ならそのペースで歩く）歩行時間を使う（休憩は含めない）。
 * 体重と荷物は入れなくて済むよう、決まった値で求める。個人差が大きいので「約」で出す
 */

/** 体重 (kg) */
export const BODY_KG = 70;
/** 荷物 (kg) */
export const PACK_KG = 10;

/** 歩行時間（分）・距離 (m)・登りと下りの累積標高 (m) から、消費エネルギー (kcal) */
export function hikingKcal(movingMin: number, distanceM: number, ascentM: number, descentM: number): number {
  const courseConstant = 1.8 * (movingMin / 60) + 0.3 * (distanceM / 1000) + 10 * (ascentM / 1000) + 0.6 * (descentM / 1000);
  return courseConstant * (BODY_KG + PACK_KG);
}

/** 「約850kcal」（10kcal 単位） */
export const fmtKcal = (kcal: number) => `約${(Math.round(kcal / 10) * 10).toLocaleString('ja-JP')}kcal`;

/** 出している消費エネルギーの前提（画面の説明に使う） */
export const KCAL_NOTE = `消費エネルギーは、歩行時間・距離・登り下りから、体重${BODY_KG}kg・荷物${PACK_KG}kgとして求めた目安です。`;
