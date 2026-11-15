/**
 * 電池があと何分もつかの見積もり。電池の残りは 1% 刻みでしか分からないので、
 * 残りが変わった時刻を覚えておき、1% 減るのにかかった時間から減る速さを求める
 */

/** 電池の残り（%）と、それを見た時刻 */
export interface BatterySample {
  t: number;
  level: number;
  /** 残りが変わったところを見たか（最初に見ただけの点は、その残りになった時刻が分からないので、速さの計算に使わない） */
  changed: boolean;
}

/** 減る速さは、まず直近1時間で見る（今の使い方での減り方を出したいので） */
export const BATTERY_WINDOW_MS = 60 * 60_000;
/** 見積もりに要る減り（%）。1% 刻みなので、少ないとぶれが大きい */
export const BATTERY_MIN_DROP = 2;
/** 覚えておく時間（それより古い点は捨てる） */
const KEEP_MS = 6 * 60 * 60_000;

/**
 * 見た残りを足す。同じ残りが続くあいだは足さない。充電中・残りが増えたときは、減り方が変わるので最初からにする
 */
export function addBatterySample(samples: BatterySample[], level: number, charging: boolean, now: number): BatterySample[] {
  if (charging) return samples.length ? [] : samples;
  const last = samples.at(-1);
  if (last && level === last.level) return samples;
  if (!last || level > last.level) return [{ t: now, level, changed: false }];
  return [...samples.filter((s) => s.t >= now - KEEP_MS), { t: now, level, changed: true }];
}

/** あと何ミリ秒もつか。減り方がまだ分からなければ null */
export function batteryRemainingMs(samples: BatterySample[], now: number): number | null {
  const level = samples.at(-1)?.level;
  if (level == null) return null;
  const edges = samples.filter((s) => s.changed);
  // 直近1時間で減り方が分からなければ（減りがゆるいときなど）、覚えている全部で見る
  for (const set of [edges.filter((s) => s.t >= now - BATTERY_WINDOW_MS), edges]) {
    const a = set[0];
    const b = set.at(-1);
    if (!a || !b) continue;
    const drop = a.level - b.level;
    if (drop < BATTERY_MIN_DROP) continue;
    // 1% 減るのにかかった時間。今の残りになってから、それより長くたっていれば、減り方がゆるくなったとみてその分も入れる
    const perPercent = Math.max((b.t - a.t) / drop, (now - a.t) / (drop + 1));
    return level * perPercent;
  }
  return null;
}
