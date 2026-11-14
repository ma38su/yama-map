import type { Map as MlMap, SkySpecification } from 'maplibre-gl';
import type { SunPosition } from '../nav/sun';

type SkyColors = Pick<SkySpecification, 'sky-color' | 'horizon-color' | 'fog-color'>;

/**
 * 太陽高度（度）ごとの空の色。間は線形に補間する。
 * 区切りは夜（航海薄明の終わり）・市民薄明・地平線の夕焼け・低い朝日・昼。
 * 地図タイル自体は昼の色のままなので、遠景をぼかす霧は夜でも暗くしすぎない。
 */
const SKY_STOPS: readonly (readonly [number, SkyColors])[] = [
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

const toRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: string, b: string, t: number) => {
  const [x, y] = [toRgb(a), toRgb(b)];
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
};

/** 太陽高度に合わせた空 */
export function skyAt(altitude: number): SkySpecification {
  const i = SKY_STOPS.findIndex(([a]) => altitude < a);
  if (i === 0 || i < 0) return { ...SKY_STOPS[i === 0 ? 0 : SKY_STOPS.length - 1][1], ...SKY_BLEND };
  const [a0, from] = SKY_STOPS[i - 1];
  const [a1, to] = SKY_STOPS[i];
  const t = (altitude - a0) / (a1 - a0);
  const color = (key: keyof SkyColors) => mix(from[key] as string, to[key] as string, t);
  return { 'sky-color': color('sky-color'), 'horizon-color': color('horizon-color'), 'fog-color': color('fog-color'), ...SKY_BLEND };
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

/** 空の色と陰影の光を太陽に合わせる。実際の日差しの陰影は 3D のときだけ（2D は慣習の陰影） */
export function applyDaylight(map: MlMap, sun: SunPosition, terrain: boolean): void {
  map.setSky(skyAt(sun.altitude));
  if (!map.getLayer('hillshade')) return;
  const light = terrain ? sunHillshadeLight(sun) : DEFAULT_HILLSHADE_LIGHT;
  map.setPaintProperty('hillshade', 'hillshade-method', light.method);
  map.setPaintProperty('hillshade', 'hillshade-illumination-direction', light.direction);
  map.setPaintProperty('hillshade', 'hillshade-illumination-altitude', light.altitude);
  map.setPaintProperty('hillshade', 'hillshade-illumination-anchor', light.anchor);
  map.setPaintProperty('hillshade', 'hillshade-exaggeration', light.exaggeration);
}
