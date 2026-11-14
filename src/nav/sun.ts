/**
 * 日の出・日の入り（NOAA の簡易式）。精度は数分程度。
 * 谷や山の東西斜面では、地平線が高いぶん実際の日没より早く暗くなる点に注意。
 */
const RAD = Math.PI / 180;
const J2000 = 2451545;
const msToJulian = (ms: number) => ms / 86_400_000 + 2440587.5;
const julianToMs = (j: number) => (j - 2440587.5) * 86_400_000;

export interface SunTimes {
  sunrise: Date | null;
  sunset: Date | null;
}

/** date の日（その場所の正午付近を含む日）の日の出・日の入り */
export function sunTimes(date: Date, lat: number, lng: number): SunTimes {
  const lw = -lng; // 西経を正
  const jd = msToJulian(date.getTime());
  const n = Math.round(jd - J2000 - 0.0009 - lw / 360);
  const jStar = J2000 + 0.0009 + lw / 360 + n;
  const M = (357.5291 + 0.98560028 * (jStar - J2000)) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const jTransit = jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const decl = Math.asin(Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD));
  const cosW = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * Math.sin(decl)) / (Math.cos(lat * RAD) * Math.cos(decl));
  if (cosW < -1 || cosW > 1) return { sunrise: null, sunset: null }; // 白夜・極夜
  const w = Math.acos(cosW) / RAD;
  return {
    sunrise: new Date(julianToMs(jTransit - w / 360)),
    sunset: new Date(julianToMs(jTransit + w / 360)),
  };
}

export interface SunPosition {
  /** 高度（度）。地平線が0、大気差は含めない */
  altitude: number;
  /** 方位（度）。北0・東90 の時計回り */
  azimuth: number;
}

/** その時刻・地点の太陽の高度と方位（NOAA General Solar Position の簡易式。誤差は0.1°程度） */
export function sunPosition(date: Date, lat: number, lng: number): SunPosition {
  const year = date.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const days = (Date.UTC(year + 1, 0, 1) - yearStart) / 86_400_000;
  const utcHours = (date.getTime() - Date.UTC(year, date.getUTCMonth(), date.getUTCDate())) / 3_600_000;
  const doy = Math.floor((date.getTime() - yearStart) / 86_400_000) + 1;
  const g = ((2 * Math.PI) / days) * (doy - 1 + (utcHours - 12) / 24);
  const eqTime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const hourAngle = ((utcHours * 60 + eqTime + 4 * lng) / 4 - 180) * RAD;
  const phi = lat * RAD;
  const up = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(hourAngle);
  const east = -Math.cos(decl) * Math.sin(hourAngle);
  const north = Math.cos(phi) * Math.sin(decl) - Math.sin(phi) * Math.cos(decl) * Math.cos(hourAngle);
  return {
    altitude: Math.asin(Math.max(-1, Math.min(1, up))) / RAD,
    azimuth: (Math.atan2(east, north) / RAD + 360) % 360,
  };
}
