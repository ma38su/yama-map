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
