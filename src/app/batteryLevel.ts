/**
 * 電池の残りと、あと何分もつかの見積もり（ポケット表示に出す。アプリ版はポケット表示で上の電池の表示も隠すため）。
 * ブラウザ・WebView の Battery Status API で、残りが変わるたびに覚えておく（見積もりは nav/battery.ts）。
 * 画面を消しているあいだは JS が止まるので、そのあいだの減りは画面を点けたときにまとめて入る
 */
import { addBatterySample, batteryRemainingMs, type BatterySample } from '../nav/battery';

interface BatteryLike extends EventTarget {
  level: number;
  charging: boolean;
}

/** 覚えておく残り（アプリを開き直しても減り方を続けて見られるように、端末に残す） */
const KEY = 'yama-map:battery';
let samples: BatterySample[] = [];
try {
  const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
  if (Array.isArray(v)) samples = v as BatterySample[];
} catch {
  /* 保存領域が使えない環境でも動かす */
}
let battery: BatteryLike | null = null;

/** 今の残りを覚える（変わったときだけ残す） */
function note() {
  if (!battery) return;
  const next = addBatterySample(samples, Math.round(battery.level * 100), battery.charging, Date.now());
  if (next === samples) return;
  samples = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(samples));
  } catch {
    /* noop */
  }
}

const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
void nav
  .getBattery?.()
  .then((b) => {
    battery = b;
    note();
    b.addEventListener('levelchange', note);
    b.addEventListener('chargingchange', note);
  })
  .catch(() => undefined);
// 画面を消していたあいだに減った分は、点けたときにすぐ入れる（変わったという知らせを待たずに）
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && note());

export interface BatteryNow {
  /** 残り（%） */
  level: number;
  charging: boolean;
  /** あと何ミリ秒もつか。充電中・減り方がまだ分からなければ null */
  remainingMs: number | null;
}

/** 今の電池の残りと、あと何ミリ秒もつか（Battery Status API が使えなければ null） */
export function batteryNow(): BatteryNow | null {
  if (!battery) return null;
  note();
  return {
    level: Math.round(battery.level * 100),
    charging: battery.charging,
    remainingMs: battery.charging ? null : batteryRemainingMs(samples, Date.now()),
  };
}
