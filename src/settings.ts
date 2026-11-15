/** 端末に保存する設定と、空や地図の色を決める時刻 */
import type { LngLat } from './geo';
import { BASE_LAYERS, TERRAIN_EXAGGERATION, TERRAIN_EXAGGERATION_RANGE, type BaseLayerId } from './map/style';
import { PACE_PRESETS, type PacePreset } from './nav/eta';
import { ROUTE_PREFS, type RoutePref } from './nav/plan';
import { backgroundCapable } from './track/location';

export interface Settings {
  base: BaseLayerId;
  hillshade: boolean;
  /** 空と地図の色を時刻に合わせる（夜は暗め） */
  dayTone: boolean;
  terrain: boolean;
  /** 3D の起伏の強調（1 = 実際の高さ。大きいほど勾配が急に見える） */
  terrainExaggeration: number;
  /** 天気予報を出す（行程の降水確率など） */
  weather: boolean;
  /** 天気の演出：3D の雲・雨・雪、曇りの空（weather がオンのときだけ） */
  weatherFx: boolean;
  /** 記録中は画面を点けたままにする（アプリ版は画面オフでも記録できるので初期値オフ） */
  wakeLock: boolean;
  /** 記録中にルートから離れたら振動と通知で知らせる */
  offRouteAlert: boolean;
  pace: PacePreset;
  /** ルートの探し方 */
  routePref: RoutePref;
  /** 出発時刻 "HH:MM"。null なら現在時刻に出発する想定 */
  departAt: string | null;
  view?: { center: LngLat; zoom: number; pitch: number; bearing: number };
  /** 最初から入れている「予定」の記録を入れ終えたか（消したあとに戻さないため） */
  builtinPlan?: boolean;
  /** 電池の最適化から外すか、記録を始めたときに一度聞いたか（アプリ版） */
  batteryAsked?: boolean;
  /** 地図に重ねる情報の種類ごとの表示（app/places.ts の LayerId → 出すか。ないものは初期値） */
  layers?: Partial<Record<string, boolean>>;
  /** ルート沿いのオフライン保存で、ルートの片側に保存する幅 (m) */
  offlineBufferM?: number;
  /** リプレイの視点：後ろから追う・少し高くから俯瞰して追う・全体を見る（app/replay.ts） */
  replayView?: 'chase' | 'bird' | 'whole';
}
const SETTINGS_KEY = 'yama-map:settings';
export const settings: Settings = { base: 'std', hillshade: true, dayTone: true, terrain: false, terrainExaggeration: TERRAIN_EXAGGERATION, weather: true, weatherFx: true, wakeLock: !backgroundCapable, offRouteAlert: true, pace: 'normal', routePref: 'trail', departAt: null };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'));
} catch {
  /* 保存領域が使えない環境でも動かす */
}
if (!(settings.base in BASE_LAYERS)) settings.base = 'std';
if (!(settings.terrainExaggeration >= TERRAIN_EXAGGERATION_RANGE.min && settings.terrainExaggeration <= TERRAIN_EXAGGERATION_RANGE.max)) {
  settings.terrainExaggeration = TERRAIN_EXAGGERATION;
}
if (!(settings.pace in PACE_PRESETS)) settings.pace = 'normal';
if (!(settings.routePref in ROUTE_PREFS)) settings.routePref = 'trail';
if (settings.departAt != null && !/^\d{2}:\d{2}$/.test(settings.departAt)) settings.departAt = null;
/**
 * 保存するときだけ差し替える値。リプレイで一時的に 3D にしているあいだ、元の 2D のほうを保存するのに使う
 * （途中でアプリを閉じても、次の起動が 3D にならないように）
 */
export const savedOverrides: Partial<Settings> = {};
export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, ...savedOverrides }));
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
