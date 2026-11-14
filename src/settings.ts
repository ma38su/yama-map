/** 端末に保存する設定と、空や地図の色を決める時刻 */
import type { LngLat } from './geo';
import { BASE_LAYERS, type BaseLayerId } from './map/style';
import { PACE_PRESETS, type PacePreset } from './nav/eta';
import { ROUTE_PREFS, type RoutePref } from './nav/plan';

export interface Settings {
  base: BaseLayerId;
  hillshade: boolean;
  /** 空と地図の色を時刻に合わせる（夜は暗め） */
  dayTone: boolean;
  terrain: boolean;
  wakeLock: boolean;
  pace: PacePreset;
  /** ルートの探し方 */
  routePref: RoutePref;
  /** 出発時刻 "HH:MM"。null なら現在時刻に出発する想定 */
  departAt: string | null;
  view?: { center: LngLat; zoom: number; pitch: number; bearing: number };
}
const SETTINGS_KEY = 'yama-map:settings';
export const settings: Settings = { base: 'std', hillshade: true, dayTone: true, terrain: false, wakeLock: true, pace: 'normal', routePref: 'trail', departAt: null };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'));
} catch {
  /* 保存領域が使えない環境でも動かす */
}
if (!(settings.base in BASE_LAYERS)) settings.base = 'std';
if (!(settings.pace in PACE_PRESETS)) settings.pace = 'normal';
if (!(settings.routePref in ROUTE_PREFS)) settings.routePref = 'trail';
if (settings.departAt != null && !/^\d{2}:\d{2}$/.test(settings.departAt)) settings.departAt = null;
export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* noop */
  }
}

/** 空や地図の色を決める時刻。URL に ?time=18:30 を付けると、その時刻の見え方を確かめられる */
const timeOverride = /^(\d{1,2}):(\d{2})$/.exec(new URLSearchParams(location.search).get('time') ?? '');
export function daylightTime(): Date {
  const now = new Date();
  if (timeOverride) now.setHours(Number(timeOverride[1]), Number(timeOverride[2]), 0, 0);
  return now;
}
