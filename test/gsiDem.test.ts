import { describe, expect, it, vi } from 'vitest';

vi.mock('maplibre-gl', () => ({ addProtocol: vi.fn() }));
const { bilinear, convertGsiToTerrarium, decodeGsiHeights, gsiRgbToHeight, heightToTerrarium } = await import(
  '../src/map/gsiDem'
);

/** 地理院形式へのエンコード（テスト用） */
function encodeGsi(h: number): [number, number, number] {
  let x = Math.round(h * 100);
  if (x < 0) x += 0x1000000;
  return [(x >> 16) & 0xff, (x >> 8) & 0xff, x & 0xff];
}
const terrariumToHeight = (r: number, g: number, b: number) => r * 256 + g + b / 256 - 32768;

describe('地理院 標高PNG', () => {
  it('仕様どおりにデコードする', () => {
    expect(gsiRgbToHeight(0, 0, 0)).toBe(0);
    expect(gsiRgbToHeight(...encodeGsi(3776.24))).toBeCloseTo(3776.24, 2);
    expect(gsiRgbToHeight(...encodeGsi(-3.5))).toBeCloseTo(-3.5, 2);
    expect(gsiRgbToHeight(128, 0, 0)).toBeNull(); // 無効値
  });

  it('Terrarium へ変換しても標高が保たれる', () => {
    for (const h of [0, 12.34, 1000, 3180.5, 3776.24, -2.5]) {
      const [r, g, b] = heightToTerrarium(h);
      expect(terrariumToHeight(r, g, b)).toBeCloseTo(h, 1);
    }
  });

  it('画素配列を一括変換（無効値は0m）', () => {
    const px = new Uint8ClampedArray([...encodeGsi(2000), 255, 128, 0, 0, 255]);
    convertGsiToTerrarium(px);
    expect(terrariumToHeight(px[0], px[1], px[2])).toBeCloseTo(2000, 1);
    expect(terrariumToHeight(px[4], px[5], px[6])).toBeCloseTo(0, 1);
    expect(px[7]).toBe(255);
  });

  it('decodeGsiHeights は無効値を NaN にする', () => {
    const h = decodeGsiHeights(new Uint8ClampedArray([...encodeGsi(123.45), 255, 128, 0, 0, 255]));
    expect(h[0]).toBeCloseTo(123.45, 2);
    expect(Number.isNaN(h[1])).toBe(true);
  });
});

describe('bilinear', () => {
  const tile = new Float32Array(256 * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) tile[y * 256 + x] = x * 10 + y;

  it('画素の間を補間する', () => {
    expect(bilinear(tile, 10.5, 20)).toBeCloseTo(125, 5);
    expect(bilinear(tile, 10, 20.5)).toBeCloseTo(120.5, 5);
  });
  it('端はクランプ', () => {
    expect(bilinear(tile, -3, -3)).toBe(0);
  });
  it('無効値まじりは最寄り、全部無効なら null', () => {
    const t = new Float32Array(256 * 256).fill(Number.NaN);
    expect(bilinear(t, 5, 5)).toBeNull();
    t[5 * 256 + 5] = 42;
    expect(bilinear(t, 5.2, 5.2)).toBe(42);
  });
});
