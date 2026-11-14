import type { Map as MlMap, SkySpecification, StyleSpecification } from 'maplibre-gl';
import type { SunPosition } from '../nav/sun';
import { TINT_LAYER } from './style';

type SkyColors = Pick<SkySpecification, 'sky-color' | 'horizon-color' | 'fog-color'>;
type Stops<T> = readonly (readonly [number, T])[];

/**
 * 太陽高度（度）ごとの空の色。間は線形に補間する。
 * 区切りは夜（航海薄明の終わり）・市民薄明・地平線の夕焼け・低い朝日・昼。
 * 地図は夜でも読めるように明るさを残すので、遠景をぼかす霧も暗くしすぎない。
 */
const SKY_STOPS: Stops<SkyColors> = [
  [-12, { 'sky-color': '#0c1630', 'horizon-color': '#2a3552', 'fog-color': '#6b7489' }],
  [-4, { 'sky-color': '#2b3f6e', 'horizon-color': '#d98f6e', 'fog-color': '#a9a3ab' }],
  [1, { 'sky-color': '#5d84c4', 'horizon-color': '#ffb27a', 'fog-color': '#e9d8c8' }],
  [12, { 'sky-color': '#79aee6', 'horizon-color': '#e6eef5', 'fog-color': '#eef1f4' }],
  [30, { 'sky-color': '#7fb8f0', 'horizon-color': '#eaf4ff', 'fog-color': '#f4f7fb' }],
];

const SKY_BLEND = {
  'sky-horizon-blend': 0.6,
  'horizon-fog-blend': 0.6,
  'fog-ground-blend': 0.85,
  'atmosphere-blend': 0,
} as const;

/** 地図の色合い。タイルの明るさ・彩度と、地図全体に重ねる色 */
export interface MapTone {
  /** raster-brightness-max（1 でそのまま） */
  brightness: number;
  /** raster-saturation（0 でそのまま、−1 で白黒） */
  saturation: number;
  tint: string;
  tintOpacity: number;
}

/**
 * 太陽高度ごとの地図の色合い。夜は暗く青みがかり、夕方は暖色に寄せる。
 * 夜道で地図を読む必要があるので、夜でも文字と登山道が読める明るさで止める。
 */
const TONE_STOPS: Stops<MapTone> = [
  [-10, { brightness: 0.62, saturation: -0.3, tint: '#0f2a78', tintOpacity: 0.25 }],
  [-3, { brightness: 0.82, saturation: -0.2, tint: '#3b3f7d', tintOpacity: 0.14 }],
  [2, { brightness: 0.96, saturation: 0.05, tint: '#ff9447', tintOpacity: 0.1 }],
  [10, { brightness: 1, saturation: 0, tint: '#ffb36b', tintOpacity: 0 }],
];

export const DAY_TONE: MapTone = TONE_STOPS[TONE_STOPS.length - 1][1];

const toRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: string, b: string, t: number) => {
  const [x, y] = [toRgb(a), toRgb(b)];
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
};

/** 区切りの間を線形に補間する（色は #rrggbb、ほかは数値） */
function interpolate<T extends object>(stops: Stops<T>, altitude: number): T {
  const i = stops.findIndex(([a]) => altitude < a);
  if (i === 0) return { ...stops[0][1] };
  if (i < 0) return { ...stops[stops.length - 1][1] };
  const [a0, from] = stops[i - 1];
  const [a1, to] = stops[i];
  const t = (altitude - a0) / (a1 - a0);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(from)) {
    const w = (to as Record<string, unknown>)[key];
    out[key] = typeof v === 'number' ? v + ((w as number) - v) * t : mix(v as string, w as string, t);
  }
  return out as T;
}

/** 太陽高度に合わせた空 */
export function skyAt(altitude: number): SkySpecification {
  return { ...interpolate(SKY_STOPS, altitude), ...SKY_BLEND };
}

/**
 * 曇りの空：雲量（0〜1）に合わせて空の色を灰色に寄せる（明るさは保つ）
 */
export function overcastSky(sky: SkySpecification, cloud: number): SkySpecification {
  if (cloud <= 0) return sky;
  const out: SkySpecification = { ...sky };
  for (const key of ['sky-color', 'horizon-color', 'fog-color'] as const) {
    const c = sky[key];
    if (typeof c !== 'string' || !c.startsWith('#')) continue;
    const [r, g, b] = toRgb(c);
    const l = 0.3 * r + 0.59 * g + 0.11 * b;
    out[key] = mix(c, toHex([l * 0.94, l * 0.97, l]), Math.min(1, cloud) * 0.75);
  }
  return out;
}

/** 太陽高度に合わせた地図の色合い */
export function toneAt(altitude: number): MapTone {
  return interpolate(TONE_STOPS, altitude);
}

export interface HillshadeLight {
  method: 'standard' | 'basic';
  direction: number;
  altitude: number;
  anchor: 'map' | 'viewport';
  exaggeration: number;
}

/** 地図の慣習どおりの陰影（画面の左上から光を当てる。2D で凹凸が反転して見えないように） */
export const DEFAULT_HILLSHADE_LIGHT: HillshadeLight = { method: 'standard', direction: 335, altitude: 45, anchor: 'viewport', exaggeration: 0.35 };

/** 光源がこれより低いと斜面のほとんどが真っ暗になるので、ここで止める */
const MIN_LIGHT_ALTITUDE = 8;
const SUN_EXAGGERATION = 0.2;

/**
 * 実際の太陽の向きから当てる陰影。日が出ている間だけ使い、夜は慣習の陰影に戻す。
 * 高度は basic（面の傾きと光の角度の余弦）でしか効かないので、方式も切り替える。
 */
export function sunHillshadeLight(sun: SunPosition): HillshadeLight {
  if (sun.altitude <= 0) return DEFAULT_HILLSHADE_LIGHT;
  return {
    method: 'basic',
    direction: Math.round(sun.azimuth) % 360,
    altitude: Math.max(MIN_LIGHT_ALTITUDE, Math.round(sun.altitude)),
    anchor: 'map',
    // basic は standard より影側がずっと濃く、登山道や文字が読めなくなるので薄める
    exaggeration: SUN_EXAGGERATION,
  };
}

/** 読み込み前のスタイルを、最初から今の空と地図の色にしておく（昼の色が一瞬見えないように） */
export function toneStyle(style: StyleSpecification, altitude: number): StyleSpecification {
  const t = toneAt(altitude);
  style.sky = skyAt(altitude);
  for (const layer of style.layers) {
    if (layer.type === 'raster') {
      layer.paint = { ...layer.paint, 'raster-brightness-max': t.brightness, 'raster-saturation': t.saturation };
    } else if (layer.id === TINT_LAYER && layer.type === 'fill') {
      layer.paint = { ...layer.paint, 'fill-color': t.tint, 'fill-opacity': t.tintOpacity };
    }
  }
  return style;
}

export interface DaylightOptions {
  /** 3D 表示中か。実際の日差しの陰影は 3D のときだけ（2D は慣習の陰影） */
  terrain: boolean;
  /** 空と地図の色を時刻に合わせるか。オフなら昼の色のまま */
  tone: boolean;
  /** 雲量（0〜1）。曇っているほど空を灰色にし、日差しの陰影を弱める */
  cloud?: number;
}

/** 空・地図の色と陰影の光を太陽に合わせる */
export function applyDaylight(map: MlMap, sun: SunPosition, { terrain, tone, cloud = 0 }: DaylightOptions): void {
  const colorAltitude = tone ? sun.altitude : 90;
  map.setSky(overcastSky(skyAt(colorAltitude), cloud));
  const t = toneAt(colorAltitude);
  // getStyle() はスタイル全体を作り直すので使わず、レイヤーの名前と種類だけを見る
  for (const id of map.getLayersOrder()) {
    if (map.getLayer(id)?.type !== 'raster') continue;
    map.setPaintProperty(id, 'raster-brightness-max', t.brightness);
    map.setPaintProperty(id, 'raster-saturation', t.saturation);
  }
  if (map.getLayer(TINT_LAYER)) {
    map.setPaintProperty(TINT_LAYER, 'fill-color', t.tint);
    map.setPaintProperty(TINT_LAYER, 'fill-opacity', t.tintOpacity);
  }
  if (!map.getLayer('hillshade')) return;
  const light = terrain ? sunHillshadeLight(sun) : DEFAULT_HILLSHADE_LIGHT;
  map.setPaintProperty('hillshade', 'hillshade-method', light.method);
  map.setPaintProperty('hillshade', 'hillshade-illumination-direction', light.direction);
  map.setPaintProperty('hillshade', 'hillshade-illumination-altitude', light.altitude);
  map.setPaintProperty('hillshade', 'hillshade-illumination-anchor', light.anchor);
  // 厚い雲の下では影がぼやける
  const shade = light.method === 'basic' ? 1 - 0.5 * Math.min(1, cloud) : 1;
  map.setPaintProperty('hillshade', 'hillshade-exaggeration', light.exaggeration * shade);
}
