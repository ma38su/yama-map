import { describe, expect, it } from 'vitest';
import { DAY_TONE, DEFAULT_HILLSHADE_LIGHT, skyAt, sunHillshadeLight, toneAt, toneStyle } from '../src/map/daylight';
import { TINT_LAYER, createStyle } from '../src/map/style';
import { sunPosition, sunTimes } from '../src/nav/sun';

const TOKYO = { lat: 35.68, lng: 139.77 };

describe('sunPosition', () => {
  it('夏至の南中高度は 90 − 緯度 + 23.44° 付近、方位は南', () => {
    let best = { altitude: -90, azimuth: 0 };
    for (let m = 0; m < 24 * 60; m++) {
      const p = sunPosition(new Date(Date.UTC(2026, 5, 21, 0, m)), TOKYO.lat, TOKYO.lng);
      if (p.altitude > best.altitude) best = p;
    }
    expect(best.altitude).toBeCloseTo(90 - TOKYO.lat + 23.44, 0);
    expect(Math.abs(best.azimuth - 180)).toBeLessThan(3);
  });

  it('朝は東、夕方は西に出る', () => {
    const morning = sunPosition(new Date('2026-03-20T08:00:00+09:00'), TOKYO.lat, TOKYO.lng);
    const evening = sunPosition(new Date('2026-03-20T16:00:00+09:00'), TOKYO.lat, TOKYO.lng);
    expect(morning.azimuth).toBeGreaterThan(90);
    expect(morning.azimuth).toBeLessThan(135);
    expect(evening.azimuth).toBeGreaterThan(225);
    expect(evening.azimuth).toBeLessThan(270);
  });

  it('sunTimes の日の出・日の入りでは、地平線のすぐ下（−0.83°）にある', () => {
    const date = new Date('2026-11-14T12:00:00+09:00');
    const { sunrise, sunset } = sunTimes(date, TOKYO.lat, TOKYO.lng);
    for (const t of [sunrise!, sunset!]) {
      expect(sunPosition(t, TOKYO.lat, TOKYO.lng).altitude).toBeCloseTo(-0.83, 0);
    }
  });
});

describe('skyAt', () => {
  it('昼と夜は区切りの色、その間は補間する', () => {
    expect(skyAt(60)['sky-color']).toBe('#7fb8f0');
    expect(skyAt(-30)['sky-color']).toBe('#0c1630');
    expect(skyAt(21)['sky-color']).toBe('#7cb3eb');
  });
});

describe('sunHillshadeLight', () => {
  it('日中は太陽の方位から地図に固定して当てる', () => {
    expect(sunHillshadeLight({ altitude: 30.4, azimuth: 200.2 })).toEqual({
      method: 'basic',
      direction: 200,
      altitude: 30,
      anchor: 'map',
      exaggeration: 0.2,
    });
  });
  it('低い太陽は下限で止め、夜は慣習の陰影に戻す', () => {
    expect(sunHillshadeLight({ altitude: 2, azimuth: 250 }).altitude).toBe(8);
    expect(sunHillshadeLight({ altitude: -5, azimuth: 250 })).toBe(DEFAULT_HILLSHADE_LIGHT);
  });
});

describe('toneAt', () => {
  it('昼はタイルをそのまま、夜は暗く青みがかるが読める明るさで止める', () => {
    expect(toneAt(40)).toEqual(DAY_TONE);
    expect(DAY_TONE.tintOpacity).toBe(0);
    const night = toneAt(-30);
    expect(night.brightness).toBeGreaterThanOrEqual(0.6);
    expect(night.tintOpacity).toBeLessThanOrEqual(0.25);
  });
  it('区切りの間は数値も色も補間する', () => {
    const t = toneAt(6);
    expect(t.brightness).toBeCloseTo(0.98);
    expect(t.tintOpacity).toBeCloseTo(0.05);
    expect(t.tint).toBe('#ffa459');
  });
});

describe('toneStyle', () => {
  it('読み込み前のスタイルの空・タイル・重ねる色を、その時刻のものにする', () => {
    const style = toneStyle(createStyle('std', true), -30);
    const night = toneAt(-30);
    expect(style.sky?.['sky-color']).toBe('#0c1630');
    const base = style.layers.find((l) => l.id === 'base-std');
    expect(base?.type === 'raster' && base.paint?.['raster-brightness-max']).toBe(night.brightness);
    const tint = style.layers.find((l) => l.id === TINT_LAYER);
    expect(tint?.type === 'fill' && tint.paint?.['fill-opacity']).toBe(night.tintOpacity);
  });
});
