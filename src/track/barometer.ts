/**
 * 気圧計（アプリ版の Android だけ。android/…/BarometerPlugin.java）。
 * Web にはブラウザから気圧計を読む方法がないので、いつも「なし」
 */
import { registerPlugin } from '@capacitor/core';
import { backgroundCapable } from './location';

interface BarometerPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  start(): Promise<void>;
  stop(): Promise<void>;
  read(): Promise<{ hPa: number | null; t: number }>;
}
const Barometer = registerPlugin<BarometerPlugin>('Barometer');

/** これより古い値は使わない（センサーが止まっていた） */
const STALE_MS = 2 * 60_000;

let available: Promise<boolean> | null = null;
export function barometerAvailable(): Promise<boolean> {
  available ??= backgroundCapable
    ? Barometer.isAvailable()
        .then((r) => r.available)
        .catch(() => false)
    : Promise.resolve(false);
  return available;
}

let running = false;
export async function setBarometer(on: boolean): Promise<void> {
  if (on === running || !(await barometerAvailable())) return;
  running = on;
  await (on ? Barometer.start() : Barometer.stop()).catch((e) => console.warn('気圧計', e));
}

/** 最新の気圧 (hPa)。気圧計がない・止まっている・値が古ければ null */
export async function readPressure(): Promise<number | null> {
  if (!running) return null;
  try {
    const { hPa, t } = await Barometer.read();
    return hPa != null && Date.now() - t < STALE_MS ? hPa : null;
  } catch {
    return null;
  }
}
