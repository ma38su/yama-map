import { describe, expect, it } from 'vitest';
import { newOffRouteState, OFF_ROUTE, stepOffRoute } from '../src/nav/offRoute';
import { angleDiff, headingFrom, smoothHeading } from '../src/nav/heading';
import { parsePlaces } from '../src/nav/placeSearch';
import { jpegSize, parseExifTime, readExif } from '../src/track/exif';
import { placePhoto, positionAt, TIME_TOLERANCE_MS } from '../src/track/photoPlace';
import { BaroFusion, pressureAltitude } from '../src/track/baroAltitude';

describe('道迷いの判定', () => {
  const run = (offsets: number[], dt = 10_000) => {
    const s = newOffRouteState();
    return offsets.map((o, i) => stepOffRoute(s, o, i * dt));
  };
  it('ルートの近くを歩くまでは鳴らさない（登山口へ向かうあいだ）', () => {
    expect(run([500, 400, 300, 200])).toEqual([null, null, null, null]);
  });
  it('離れた点が2回続いたら知らせ、戻ったら知らせる', () => {
    expect(run([10, 20, 150, 160, 170, 30])).toEqual([null, null, null, 'off', null, 'back']);
  });
  it('1点だけの跳ねでは鳴らさない', () => {
    expect(run([10, 150, 20, 150, 20])).toEqual([null, null, null, null, null]);
  });
  it('離れたままなら5分ごとにもう一度', () => {
    const s = newOffRouteState();
    stepOffRoute(s, 0, 0);
    stepOffRoute(s, 200, 1000);
    expect(stepOffRoute(s, 200, 2000)).toBe('off');
    expect(stepOffRoute(s, 200, 2000 + OFF_ROUTE.REPEAT_MS - 1)).toBe(null);
    expect(stepOffRoute(s, 200, 2000 + OFF_ROUTE.REPEAT_MS)).toBe('still-off');
  });
  it('5km 以上離れた点は数えない', () => {
    expect(run([0, 8000, 9000, 9000])).toEqual([null, null, null, null]);
  });
});

describe('方位', () => {
  it('Android の alpha は反時計回り', () => {
    expect(headingFrom({ alpha: 90, absolute: true })).toBe(270);
    expect(headingFrom({ alpha: 0, absolute: true })).toBe(0);
  });
  it('北が分からない alpha は使わない', () => {
    expect(headingFrom({ alpha: 90, absolute: false })).toBe(null);
  });
  it('iOS の webkitCompassHeading はそのまま', () => {
    expect(headingFrom({ alpha: 10, webkitCompassHeading: 45 })).toBe(45);
  });
  it('359° と 1° のあいだを正しくならす', () => {
    expect(angleDiff(359, 1)).toBe(2);
    const h = smoothHeading(359, 1, 0.5);
    expect(h).toBeCloseTo(0);
  });
});

/** 時刻と位置情報だけを入れた、最小の JPEG（Exif 付き）を作る */
function jpegWithExif(opts: { time?: string; zone?: string; lat?: [number, number, number]; lng?: [number, number, number]; le?: boolean }): ArrayBuffer {
  const le = opts.le ?? true;
  const bytes: number[] = [];
  const u16 = (v: number) => (le ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v: number) => (le ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  // TIFF：ヘッダ(8) → IFD0 → ExifIFD → GPSIFD → データ
  const tiff: number[] = [];
  const data: number[] = [];
  const ifd0Entries = 2;
  const exifEntries = opts.zone ? 2 : 1;
  const gpsEntries = 4;
  const ifd0At = 8;
  const exifAt = ifd0At + 2 + ifd0Entries * 12 + 4;
  const gpsAt = exifAt + 2 + exifEntries * 12 + 4;
  const dataAt = gpsAt + 2 + gpsEntries * 12 + 4;
  const put = (arr: number[]) => {
    const at = dataAt + data.length;
    data.push(...arr);
    return at;
  };
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0)).concat(0);
  const entry = (tag: number, type: number, count: number, valueOrOffset: number[]) => [...u16(tag), ...u16(type), ...u32(count), ...valueOrOffset];
  const rational3 = (v: [number, number, number]) => v.flatMap((x) => [...u32(Math.round(x * 100)), ...u32(100)]);
  tiff.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(ifd0At));
  tiff.push(...u16(ifd0Entries), ...entry(0x8769, 4, 1, u32(exifAt)), ...entry(0x8825, 4, 1, u32(gpsAt)), ...u32(0));
  const timeStr = ascii(opts.time ?? '2026:11:15 10:32:05');
  tiff.push(...u16(exifEntries), ...entry(0x9003, 2, timeStr.length, u32(put(timeStr))));
  if (opts.zone) {
    const z = ascii(opts.zone);
    tiff.push(...entry(0x9011, 2, z.length, u32(put(z))));
  }
  tiff.push(...u32(0));
  const lat = opts.lat ?? [0, 0, 0];
  const lng = opts.lng ?? [0, 0, 0];
  tiff.push(
    ...u16(gpsEntries),
    ...entry(1, 2, 2, [0x4e, 0, 0, 0]),
    ...entry(2, 5, 3, u32(put(rational3(lat)))),
    ...entry(3, 2, 2, [0x45, 0, 0, 0]),
    ...entry(4, 5, 3, u32(put(rational3(lng)))),
    ...u32(0),
  );
  tiff.push(...data);
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  bytes.push(0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 0xff, ...app1, 0xff, 0xd9);
  return new Uint8Array(bytes).buffer;
}

describe('写真の Exif', () => {
  it('撮った時刻と時差を読む', () => {
    const m = readExif(jpegWithExif({ zone: '+09:00' }));
    expect(m.time).toBe(Date.UTC(2026, 10, 15, 1, 32, 5));
    expect(m.lat).toBeUndefined(); // 0,0 は位置情報なし
  });
  it('位置情報を読む（ビッグエンディアンでも）', () => {
    for (const le of [true, false]) {
      const m = readExif(jpegWithExif({ lat: [36, 52, 13.5], lng: [139, 24, 6], le }));
      expect(m.lat).toBeCloseTo(36 + 52 / 60 + 13.5 / 3600, 6);
      expect(m.lng).toBeCloseTo(139 + 24 / 60 + 6 / 3600, 6);
    }
  });
  it('JPEG でなければ空', () => {
    expect(readExif(new Uint8Array([1, 2, 3, 4]).buffer)).toEqual({});
  });
  it('時差がなければ端末のタイムゾーン', () => {
    expect(parseExifTime('2026:11:15 10:32:05')).toBe(new Date(2026, 10, 15, 10, 32, 5).getTime());
    expect(parseExifTime('0000:00:00 00:00:00')).toBeUndefined();
  });
});

describe('写真を軌跡に置く', () => {
  const pts = [
    { t: 0, lng: 139.0, lat: 36.0 },
    { t: 60_000, lng: 139.01, lat: 36.0 },
    { t: 120_000, lng: 139.01, lat: 36.01 },
  ];
  it('時刻から前後の点の間を補う', () => {
    expect(positionAt(pts, 30_000)).toEqual([139.005, 36.0]);
    expect(positionAt(pts, 90_000)![1]).toBeCloseTo(36.005);
  });
  it('位置情報があればそれを使う', () => {
    expect(placePhoto({ time: 30_000, lng: 140, lat: 35 }, 0, pts, null)).toEqual({ t: 30_000, lngLat: [140, 35], located: 'gps' });
  });
  it('Exif に時刻がなければファイルの時刻', () => {
    expect(placePhoto({}, 60_000, pts, null)?.lngLat).toEqual([139.01, 36.0]);
  });
  it('記録の前後から外れた時刻は置けない', () => {
    expect(placePhoto({ time: 120_000 + TIME_TOLERANCE_MS + 1 }, 0, pts, null)).toBe(null);
    expect(placePhoto({ time: 120_000 + 60_000 }, 0, pts, null)?.located).toBe('time');
  });
  it('記録中に今撮った写真は今の現在地', () => {
    const here = { lngLat: [139.02, 36.02] as [number, number], t: 200_000 };
    expect(placePhoto({ time: 199_000 }, 0, pts, here)).toEqual({ t: 199_000, lngLat: [139.02, 36.02], located: 'here' });
  });
});

describe('気圧で標高を補う', () => {
  it('気圧高度：1013.25hPa で 0m、899hPa でおよそ 1000m', () => {
    expect(pressureAltitude(1013.25)).toBeCloseTo(0);
    expect(pressureAltitude(898.75)).toBeGreaterThan(990);
    expect(pressureAltitude(898.75)).toBeLessThan(1010);
  });
  it('標高タイルの揺れ（±15m）をならし、登りの細かい変化は気圧で追う', () => {
    const f = new BaroFusion();
    // 1分ごとに 5m ずつ登る。標高タイルは ±15m 揺れる
    const out: number[] = [];
    for (let i = 0; i < 60; i++) {
      const truth = 1000 + i * 5;
      const hpa = 1013.25 * Math.pow(1 - (truth + 40) / 44330, 5.255); // 気圧高度は 40m ずれている
      const dem = truth + (i % 2 ? 15 : -15);
      out.push(f.push(i * 60_000, hpa, dem)! - truth);
    }
    // 最初の数点の平均で合わせたあとは、真の標高から数m 以内
    for (const err of out.slice(5)) expect(Math.abs(err)).toBeLessThan(8);
    // 隣の点との差は 5m（気圧の変化どおり）に近い
    expect(out[40] - out[39]).toBeLessThan(3);
  });
  it('気圧がなければ標高タイルのまま', () => {
    expect(new BaroFusion().push(0, null, 1234)).toBe(1234);
  });
});

describe('地名の検索', () => {
  const json = [
    { geometry: { coordinates: [139.96, 36.15] }, properties: { title: '茨城県下妻市鬼怒' } },
    { geometry: { coordinates: [139.3633, 36.8749] }, properties: { title: '鬼怒沼', dataSource: '4' } },
    { geometry: { coordinates: [139.3716, 36.8826] }, properties: { title: '鬼怒沼山', dataSource: '4' } },
    { geometry: { coordinates: [139.3634, 36.875] }, properties: { title: '鬼怒沼', dataSource: '1' } },
    { geometry: {}, properties: { title: '壊れた項目' } },
  ];
  it('地図の地名を住所より先に、近い順。近すぎる同名は1つに', () => {
    const r = parsePlaces(json, [139.37, 36.88]);
    expect(r.map((p) => p.name)).toEqual(['鬼怒沼山', '鬼怒沼', '茨城県下妻市鬼怒']);
    expect(r[2].kind).toBe('address');
  });
  it('配列でなければ空', () => {
    expect(parsePlaces({ error: 1 }, [0, 0])).toEqual([]);
  });
});

describe('jpegSize', () => {
  it('SOF の印から幅と高さを読む（JPEG でなければ null）', () => {
    // FFD8, APP0(長さ4), SOF0: 長さ17・精度8・高さ 6144・幅 8160
    const bytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x18, 0x00, 0x1f, 0xe0, 0x03];
    expect(jpegSize(new Uint8Array(bytes).buffer)).toEqual({ width: 8160, height: 6144 });
    expect(jpegSize(new Uint8Array([1, 2, 3, 4]).buffer)).toBeNull();
  });
});

describe('placePhoto（位置情報がある写真の時刻）', () => {
  const pts = [
    { t: 0, lng: 139, lat: 36 },
    { t: 120_000, lng: 139.02, lat: 36.02 },
  ];
  it('撮った時刻が記録の時間から外れていれば、位置情報があっても置かない', () => {
    expect(placePhoto({ time: 120_000 + TIME_TOLERANCE_MS + 1, lng: 140, lat: 35 }, 0, pts, null)).toBeNull();
    expect(placePhoto({ lng: 140, lat: 35 }, 999_999_999, pts, null)?.located).toBe('gps');
  });
});
