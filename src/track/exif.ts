/**
 * JPEG の Exif から、撮った時刻と位置情報だけを読む（写真を記録の軌跡に置くため）。
 * Android の写真の選択画面は位置情報を消して渡すことが多いので、時刻だけでも置けるようにしている（./photoPlace.ts）
 */

export interface PhotoMeta {
  /** 撮った時刻 (ms)。時差の情報がなければ端末のタイムゾーンとみなす */
  time?: number;
  lng?: number;
  lat?: number;
}

const TAG = {
  dateTime: 0x0132,
  exifIfd: 0x8769,
  gpsIfd: 0x8825,
  dateTimeOriginal: 0x9003,
  offsetTimeOriginal: 0x9011,
  gpsLatRef: 0x0001,
  gpsLat: 0x0002,
  gpsLngRef: 0x0003,
  gpsLng: 0x0004,
} as const;

/** JPEG のバイト列から読む。JPEG でない・Exif がないときは空 */
export function readExif(buf: ArrayBuffer): PhotoMeta {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return {};
  let off = 2;
  while (off + 4 <= v.byteLength) {
    const marker = v.getUint16(off);
    if ((marker & 0xff00) !== 0xff00) return {};
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && off + 10 <= v.byteLength && v.getUint32(off + 4) === 0x45786966 /* Exif */) {
      try {
        return readTiff(v, off + 10);
      } catch {
        return {};
      }
    }
    if (marker === 0xffda) return {}; // 画像の本体が始まった
    off += 2 + len;
  }
  return {};
}

/**
 * JPEG の画像の幅と高さ（向きを直す前）。SOF の印を探して読む。見つからなければ null。
 * 大きな写真を、元の大きさのまま読み込まずに縮めて読むために使う
 */
export function jpegSize(buf: ArrayBuffer): { width: number; height: number } | null {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let off = 2;
  while (off + 9 <= v.byteLength) {
    const marker = v.getUint16(off);
    if ((marker & 0xff00) !== 0xff00) return null;
    // SOF0〜SOF15（DHT・JPG・DAC の C4・C8・CC を除く）
    if (marker >= 0xffc0 && marker <= 0xffcf && marker !== 0xffc4 && marker !== 0xffc8 && marker !== 0xffcc) {
      return { height: v.getUint16(off + 5), width: v.getUint16(off + 7) };
    }
    if (marker === 0xffda) return null;
    off += 2 + v.getUint16(off + 2);
  }
  return null;
}

function readTiff(v: DataView, base: number): PhotoMeta {
  const le = v.getUint16(base) === 0x4949; // "II"
  const u16 = (o: number) => v.getUint16(base + o, le);
  const u32 = (o: number) => v.getUint32(base + o, le);
  /** IFD のタグ → 値の場所（4バイトに収まれば項目の中、そうでなければ先の位置） */
  const ifd = (o: number) => {
    const map = new Map<number, { type: number; count: number; at: number }>();
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type] ?? 1;
      map.set(u16(e), { type, count, at: size * count > 4 ? u32(e + 8) : e + 8 });
    }
    return map;
  };
  const ascii = (m: Map<number, { count: number; at: number }>, tag: number) => {
    const t = m.get(tag);
    if (!t) return undefined;
    let s = '';
    for (let i = 0; i < t.count; i++) {
      const c = v.getUint8(base + t.at + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const rationals = (m: Map<number, { count: number; at: number }>, tag: number) => {
    const t = m.get(tag);
    if (!t) return undefined;
    const out: number[] = [];
    for (let i = 0; i < t.count; i++) {
      const d = u32(t.at + i * 8 + 4);
      out.push(d ? u32(t.at + i * 8) / d : 0);
    }
    return out;
  };

  const ifd0 = ifd(u32(4));
  const meta: PhotoMeta = {};
  let when = ascii(ifd0, TAG.dateTime);
  let zone: string | undefined;
  const exifPtr = ifd0.get(TAG.exifIfd);
  if (exifPtr) {
    const ex = ifd(u32(exifPtr.at));
    when = ascii(ex, TAG.dateTimeOriginal) ?? when;
    zone = ascii(ex, TAG.offsetTimeOriginal);
  }
  const time = when ? parseExifTime(when, zone) : undefined;
  if (time != null) meta.time = time;

  const gpsPtr = ifd0.get(TAG.gpsIfd);
  if (gpsPtr) {
    const g = ifd(u32(gpsPtr.at));
    const lat = rationals(g, TAG.gpsLat);
    const lng = rationals(g, TAG.gpsLng);
    if (lat?.length === 3 && lng?.length === 3) {
      const dms = (a: number[]) => a[0] + a[1] / 60 + a[2] / 3600;
      const la = dms(lat) * (ascii(g, TAG.gpsLatRef) === 'S' ? -1 : 1);
      const ln = dms(lng) * (ascii(g, TAG.gpsLngRef) === 'W' ? -1 : 1);
      // 位置情報を消した写真は 0,0 が入っていることがある
      if ((la !== 0 || ln !== 0) && Math.abs(la) <= 90 && Math.abs(ln) <= 180) {
        meta.lat = la;
        meta.lng = ln;
      }
    }
  }
  return meta;
}

/** "2026:11:15 10:32:05" と時差 "+09:00" → ms。時差がなければ端末のタイムゾーン */
export function parseExifTime(s: string, zone?: string): number | undefined {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return undefined;
  const [y, mo, d, hh, mm, ss] = m.slice(1).map(Number);
  if (!y) return undefined;
  const z = zone && /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  if (z) {
    const sign = z[1] === '-' ? -1 : 1;
    return Date.UTC(y, mo - 1, d, hh, mm, ss) - sign * (Number(z[2]) * 60 + Number(z[3])) * 60_000;
  }
  return new Date(y, mo - 1, d, hh, mm, ss).getTime();
}
