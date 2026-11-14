import type { Map as MlMap, StyleSpecification } from 'maplibre-gl';
import { GSI_DEM_TILE_URL } from './gsiDem';

export type BaseLayerId = 'std' | 'pale' | 'photo';

interface BaseLayerDef {
  label: string;
  url: string;
  minzoom: number;
  maxzoom: number;
  attribution: string;
}

const GSI_LINK = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';

/** 国土地理院の地図タイル。標準地図は等高線・登山道（徒歩道）・山名が載っていて山歩き向き */
export const BASE_LAYERS: Record<BaseLayerId, BaseLayerDef> = {
  std: {
    label: '標準地図',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    minzoom: 5,
    maxzoom: 18,
    attribution: GSI_LINK,
  },
  pale: {
    label: '淡色地図',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    minzoom: 5,
    maxzoom: 18,
    attribution: GSI_LINK,
  },
  photo: {
    label: '航空写真',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    minzoom: 2,
    maxzoom: 18,
    attribution: `${GSI_LINK}（全国最新写真（シームレス））`,
  },
};

export const TERRAIN_EXAGGERATION = 1.3;

export function createStyle(base: BaseLayerId, hillshade: boolean): StyleSpecification {
  const sources: StyleSpecification['sources'] = {};
  for (const [id, def] of Object.entries(BASE_LAYERS)) {
    sources[`base-${id}`] = {
      type: 'raster',
      tiles: [def.url],
      tileSize: 256,
      minzoom: def.minzoom,
      maxzoom: def.maxzoom,
      attribution: def.attribution,
    };
  }
  // 3D地形用と陰影用は別ソースにする（MapLibre推奨。同一だと描画が乱れることがある）
  const dem = {
    type: 'raster-dem' as const,
    tiles: [GSI_DEM_TILE_URL],
    tileSize: 256,
    maxzoom: 14,
    encoding: 'terrarium' as const,
    attribution: `${GSI_LINK}（標高タイル）`,
  };
  sources['dem-terrain'] = dem;
  sources['dem-hillshade'] = { ...dem };

  return {
    version: 8,
    sources,
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#eef0ea' } },
      ...(Object.keys(BASE_LAYERS) as BaseLayerId[]).map((id) => ({
        id: `base-${id}`,
        type: 'raster' as const,
        source: `base-${id}`,
        layout: { visibility: id === base ? ('visible' as const) : ('none' as const) },
        paint: { 'raster-fade-duration': 0 },
      })),
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'dem-hillshade',
        layout: { visibility: hillshade ? 'visible' : 'none' },
        paint: {
          'hillshade-exaggeration': 0.35,
          'hillshade-shadow-color': '#3d3526',
          'hillshade-highlight-color': '#ffffff',
          'hillshade-accent-color': '#3d3526',
        },
      },
    ],
    sky: {
      'sky-color': '#7fb8f0',
      'horizon-color': '#eaf4ff',
      'fog-color': '#f4f7fb',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.85,
      'atmosphere-blend': 0,
    },
  };
}

export function setBaseLayer(map: MlMap, base: BaseLayerId): void {
  for (const id of Object.keys(BASE_LAYERS)) {
    map.setLayoutProperty(`base-${id}`, 'visibility', id === base ? 'visible' : 'none');
  }
}

export function setHillshade(map: MlMap, on: boolean): void {
  map.setLayoutProperty('hillshade', 'visibility', on ? 'visible' : 'none');
}

/** 2D/3D 切り替え。3D では地形を立体表示して視点を傾ける */
export function set3D(map: MlMap, on: boolean): void {
  if (on) {
    map.setTerrain({ source: 'dem-terrain', exaggeration: TERRAIN_EXAGGERATION });
    map.easeTo({ pitch: Math.max(map.getPitch(), 60), duration: 800 });
  } else {
    map.setTerrain(null);
    map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
  }
}
