/**
 * 天気予報の取得と表示：行程の各地点の降水確率など（weatherFor）と、リプレイの雲（地形にかかる雲の層）と雨・雪。
 * 予報は約5kmのマス目ごとにまとめて取り、端末に保存して圏外でも直近の予報を使う。
 * 雲・雨・雪はリプレイ中だけ出し（歩いているときは出さない）、記録したときの天気（./trackWeather.ts）に合わせる。
 * 表示する時刻は今（リプレイ中は再生中の時刻）。
 */
import type { LngLat } from '../geo';
import {
  WEATHER_CELL_DEG,
  cellCenter,
  cellKey,
  fetchForecast,
  forecastHorizon,
  packWeather,
  unpackWeather,
  weatherAt,
  type HourlyWeather,
  type StoredWeather,
  type WeatherAt,
} from '../nav/weather';
import { settings } from '../settings';
import { hookDaylight, map } from './mapView';
import { updateNav } from './nav';
import { state } from './state';

const STORE_KEY = 'yama-map:weather';
/** 取り直すまでの間隔 */
const STALE_MS = 60 * 60_000;
/** 取れなかったマス目を次に試すまでの間隔（圏外で何度も問い合わせないように） */
const RETRY_MS = 5 * 60_000;
/** 端末に残しておく期間 */
const KEEP_MS = 3 * 24 * 60 * 60_000;

// ---------- 予報の取得と保存 ----------
const cache = new Map<string, { h: HourlyWeather; at: number }>();
const tried = new Map<string, number>();
const queue = new Set<string>();
let flushTimer = 0;

try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, { h: StoredWeather; at: number }>;
  for (const [k, v] of Object.entries(saved)) {
    const h = Date.now() - v.at < KEEP_MS ? unpackWeather(v.h) : null;
    if (h) cache.set(k, { h, at: v.at });
  }
} catch {
  /* 保存領域が使えない環境でも動かす */
}
/** 端末に残すマス目の数の上限（歩き回っても保存領域を使いすぎないように） */
const KEEP_CELLS = 200;
/**
 * 保存は少しまとめてから行う（localStorage への書き込みは画面の処理を止めるので、3D で動かして続けて届くたびには書かない）。
 * 裏に回るときは待たずに保存する
 */
const PERSIST_DELAY_MS = 3000;
let persistTimer = 0;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(persist, PERSIST_DELAY_MS);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && persistTimer) persist();
});
function persist() {
  clearTimeout(persistTimer);
  persistTimer = 0;
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > KEEP_MS) cache.delete(k);
  if (cache.size > KEEP_CELLS) {
    const old = [...cache].sort((a, b) => a[1].at - b[1].at).slice(0, cache.size - KEEP_CELLS);
    for (const [k] of old) cache.delete(k);
  }
  try {
    const out: Record<string, { h: StoredWeather; at: number }> = {};
    for (const [k, v] of cache) out[k] = { h: packWeather(v.h), at: v.at };
    localStorage.setItem(STORE_KEY, JSON.stringify(out));
  } catch {
    /* 容量が足りなければ保存しない */
  }
}

function request(key: string) {
  if (queue.has(key) || Date.now() - (tried.get(key) ?? 0) < RETRY_MS) return;
  queue.add(key);
  clearTimeout(flushTimer);
  // 同じ描画で頼まれたマス目をまとめて1回で問い合わせる
  flushTimer = window.setTimeout(() => void flush(), 200);
}

/**
 * 続けて取れなかった回数と、次に問い合わせてよい時刻。電波が弱い山の中では1回に15秒待って取れないことが続くので、
 * 取れないあいだは1分・2分・4分…（最大30分）と間を空け、ログにも最初の1回と5回ごとだけ書く
 */
let failStreak = 0;
let pauseUntil = 0;

async function flush() {
  // 圏外・取れない日が続いているときは問い合わせない（電波を探して電池を使わないように）。つながったら頼み直される
  if (!navigator.onLine || Date.now() < pauseUntil) {
    queue.clear();
    return;
  }
  const keys = [...queue].slice(0, 100);
  for (const k of keys) {
    queue.delete(k);
    tried.set(k, Date.now());
  }
  if (!keys.length) return;
  try {
    const list = await fetchForecast(keys.map(cellCenter), AbortSignal.timeout(15_000));
    keys.forEach((k, i) => list[i] && cache.set(k, { h: list[i], at: Date.now() }));
    failStreak = 0;
    schedulePersist();
    updateNav();
    updateWeatherLayers(true);
  } catch (e) {
    failStreak++;
    pauseUntil = Date.now() + Math.min(30, 2 ** (failStreak - 1)) * 60_000;
    if (failStreak === 1 || failStreak % 5 === 0) console.warn(`天気予報を取得できませんでした（${failStreak}回続けて）`, e);
    queue.clear();
    return;
  }
  if (queue.size) void flush();
}

/** 地点のマス目の予報（なければ取りに行き、届いたら画面を描き直す） */
function forecastFor(lngLat: LngLat): HourlyWeather | null {
  if (!settings.weather) return null;
  const key = cellKey(lngLat);
  const hit = cache.get(key);
  // 古い・前の版で取った短い予報（3日分）なら取り直す
  const short = !!hit && (hit.h.t.at(-1) ?? 0) < forecastHorizon(hit.at) - 3_600_000;
  if (!hit || short || Date.now() - hit.at > STALE_MS) request(key);
  return hit?.h ?? null;
}

type WeatherSource = (lngLat: LngLat, time: number) => WeatherAt | null;
/** リプレイ中の天気の出どころ（記録は記録したときの天気、計画は端末に残っている予報）。リプレイ中でなければ null */
let replay: { source: WeatherSource } | null = null;

/** リプレイを始めた・やめたときに呼ぶ（雲・雨・雪はリプレイ中だけ、source の天気で出す。リプレイ中は取りに行かない） */
export function setReplayWeather(on: boolean, source: WeatherSource = () => null) {
  replay = on ? { source } : null;
  cloudDrawn = null;
  updateWeatherLayers(true);
}

/** 地点・時刻の天気（予報がまだ届いていない・範囲外なら null）。リプレイ中はリプレイの天気だけ（取りに行かない） */
export function weatherFor(lngLat: LngLat, time: number): WeatherAt | null {
  if (replay) return replay.source(lngLat, time);
  const h = forecastFor(lngLat);
  return h ? weatherAt(h, time) : null;
}

/** 計画のリプレイの天気：端末に残っている予報だけを使う（なければ一番近い（20km以内）マス目の予報。取りには行かない） */
export const cachedForecastSource: WeatherSource = (lngLat, time) => {
  let hit = cache.get(cellKey(lngLat));
  if (!hit) {
    let best = Infinity;
    for (const [k, v] of cache) {
      const [x, y] = cellCenter(k);
      const d = Math.hypot(x - lngLat[0], y - lngLat[1]);
      if (d < best && d < 0.2) [best, hit] = [d, v];
    }
  }
  return hit ? weatherAt(hit.h, time) : null;
};

/** 空や雲・雨を合わせる時刻：今、リプレイ中は再生中の時刻 */
const weatherTime = () => state.daylightAt ?? Date.now();

/** 地図の中心の天気（空の色に使う） */
export function centerWeather(): WeatherAt | null {
  const c = map.getCenter();
  return weatherFor([c.lng, c.lat], weatherTime());
}

// ---------- 3D の雲 ----------
/** 雲を描く範囲：地図の中心のマス目から上下左右に何マスか */
const GRID_R = 4;
const GRID_N = GRID_R * 2 + 1;
const IMG = 192;
/** 雲の模様（タイル状につながる値ノイズ）。雲量に合わせてこの模様を切り取る */
const noise = makeNoise(IMG, 7);
let cloudDrawn: { key: string; t: number } | null = null;

function makeNoise(size: number, seed: number): Float32Array {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  for (const cells of [4, 8, 16, 32]) {
    const g = Array.from({ length: cells * cells }, rand);
    const at = (x: number, y: number) => g[(((y % cells) + cells) % cells) * cells + (((x % cells) + cells) % cells)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const fy = (y / size) * cells;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const sx = (fx - ix) * (fx - ix) * (3 - 2 * (fx - ix));
        const sy = (fy - iy) * (fy - iy) * (3 - 2 * (fy - iy));
        const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
        const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
        out[y * size + x] += (top + (bottom - top) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** 格子の値の双線形補間 */
function bilinear(v: number[], ix: number, iy: number, fx: number, fy: number): number {
  const at = (x: number, y: number) => v[y * GRID_N + x];
  return (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
}

/** 雲の層の画像を描く。マス目ごとの雲量を補間し、風下へ流れる模様で切り取る */
function drawClouds(center: [number, number], t: number): { url: string; coords: [[number, number], [number, number], [number, number], [number, number]] } | null {
  const grid: WeatherAt[] = [];
  for (let dy = GRID_R; dy >= -GRID_R; dy--) {
    for (let dx = -GRID_R; dx <= GRID_R; dx++) {
      const w = weatherFor([(center[0] + dx) * WEATHER_CELL_DEG, (center[1] + dy) * WEATHER_CELL_DEG], t);
      if (!w) return null;
      grid.push(w);
    }
  }
  const mid = grid[GRID_R * GRID_N + GRID_R];
  // 模様は風に流す（地上の風は上空より弱いので3倍にする）。風向は吹いてくる方位なので、流れる向きは逆
  const speed = (mid.wind ?? 3) * 3;
  const rad = (((mid.dir ?? 270) + 180) * Math.PI) / 180;
  const kmPerPx = (GRID_N * WEATHER_CELL_DEG * 111) / IMG;
  const hours = t / 3_600_000;
  const ox = (Math.sin(rad) * speed * 3.6 * hours) / kmPerPx;
  const oy = (-Math.cos(rad) * speed * 3.6 * hours) / kmPerPx;
  const cloudGrid = grid.map((w) => w.cloud);
  const precipGrid = grid.map((w) => w.precip);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = IMG;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(IMG, IMG);
  for (let y = 0; y < IMG; y++) {
    const gy = Math.max(0, Math.min(GRID_N - 1.001, (y / IMG) * GRID_N - 0.5));
    const iy = Math.floor(gy);
    const fy = gy - iy;
    for (let x = 0; x < IMG; x++) {
      const gx = Math.max(0, Math.min(GRID_N - 1.001, (x / IMG) * GRID_N - 0.5));
      const ix = Math.floor(gx);
      const fx = gx - ix;
      const c = bilinear(cloudGrid, ix, iy, fx, fy) / 100;
      const nx = (((Math.round(x - ox) % IMG) + IMG) % IMG);
      const ny = (((Math.round(y - oy) % IMG) + IMG) % IMG);
      const n = noise[ny * IMG + nx];
      // 雲量が多いほど模様の多くを雲にする
      const density = smooth(1 - c - 0.12, 1 - c + 0.18, n);
      const grey = 250 - Math.min(1, bilinear(precipGrid, ix, iy, fx, fy) / 3) * 90;
      const o = (y * IMG + x) * 4;
      img.data[o] = grey;
      img.data[o + 1] = grey;
      img.data[o + 2] = grey + 4;
      img.data[o + 3] = density * 160 * Math.min(1, c * 2);
    }
  }
  ctx.putImageData(img, 0, 0);
  const half = (GRID_R + 0.5) * WEATHER_CELL_DEG;
  const [cx, cy] = [center[0] * WEATHER_CELL_DEG, center[1] * WEATHER_CELL_DEG];
  return {
    url: canvas.toDataURL(),
    coords: [
      [cx - half, cy + half],
      [cx + half, cy + half],
      [cx + half, cy - half],
      [cx - half, cy - half],
    ],
  };
}

/** 雲の層を地図に加える（地図の読み込み後に一度だけ）。ルートの線より下に置く */
export function addWeatherLayers(before?: string) {
  const blank =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  map.addSource('weather-cloud', {
    type: 'image',
    url: blank,
    coordinates: [
      [0, 0.001],
      [0.001, 0.001],
      [0.001, 0],
      [0, 0],
    ],
  });
  map.addLayer(
    { id: 'weather-cloud', type: 'raster', source: 'weather-cloud', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0, 'raster-opacity': 0.9 } },
    before,
  );
}

/**
 * 雲の層と雨・雪を、今（リプレイ中は再生中の時刻）の予報に合わせる。
 * 雲の画像は時刻が10分動くか、表示範囲のマス目が変わったときだけ描き直す
 */
/** 雲・雨・雪を出すか：リプレイ中だけ（歩いているときは、電池と見やすさのために出さない） */
const fxOn = () => settings.weatherFx && replay != null;

export function updateWeatherLayers(force = false) {
  const show = fxOn();
  const layerOn = !!map.getLayer('weather-cloud');
  if (layerOn) map.setLayoutProperty('weather-cloud', 'visibility', show ? 'visible' : 'none');
  updateRain(show);
  if (!show || !layerOn) return;
  const c = map.getCenter();
  const center: [number, number] = [Math.round(c.lng / WEATHER_CELL_DEG), Math.round(c.lat / WEATHER_CELL_DEG)];
  const key = center.join(',');
  const t = weatherTime();
  if (!force && cloudDrawn && cloudDrawn.key === key && Math.abs(cloudDrawn.t - t) < 10 * 60_000) return;
  const drawn = drawClouds(center, t);
  if (!drawn) return;
  cloudDrawn = { key, t };
  (map.getSource('weather-cloud') as import('maplibre-gl').ImageSource | undefined)?.updateImage({ url: drawn.url, coordinates: drawn.coords });
}
map.on('moveend', () => updateWeatherLayers());
hookDaylight({
  cloud: () => (fxOn() ? (centerWeather()?.cloud ?? 0) / 100 : 0),
  after: () => updateWeatherLayers(),
});

// ---------- 雨・雪 ----------
const rainCanvas = document.createElement('canvas');
rainCanvas.className = 'rain';
map.getContainer().append(rainCanvas);
/** 画面を区切るマスの数。マスごとに、その場所の予報で降るかどうかを決める */
const FIELD_X = 6;
const FIELD_Y = 10;
/** 画面のマスごとの降水量 (mm/h) と雪かどうか */
let field: { precip: number; snow: boolean }[] = [];
let rainRaf = 0;
let drops: { x: number; y: number; v: number; len: number; r: number }[] = [];
let slant = 0;
let maxCount = 0;

const isSnow = (w: WeatherAt) => !!w.code && ((w.code >= 71 && w.code <= 77) || w.code === 85 || w.code === 86);
const dropsFor = (precip: number) => (precip < 0.1 ? 0 : Math.min(500, 40 + precip * 120));

/**
 * 予報で降っている場所にだけ雨粒（雪なら雪片）を降らせる。画面をマスに区切り、
 * マスの真ん中が地図のどこに当たるかを求めて、その場所の降水量で降らせる量を決める
 */
function updateRain(show: boolean) {
  const w0 = rainCanvas.clientWidth || window.innerWidth;
  const h0 = rainCanvas.clientHeight || window.innerHeight;
  const t = weatherTime();
  field = [];
  let max = 0;
  if (show) {
    for (let gy = 0; gy < FIELD_Y; gy++) {
      for (let gx = 0; gx < FIELD_X; gx++) {
        const p = map.unproject([((gx + 0.5) / FIELD_X) * w0, ((gy + 0.5) / FIELD_Y) * h0]);
        const w = weatherFor([p.lng, p.lat], t);
        const cell = { precip: w?.precip ?? 0, snow: !!w && isSnow(w) };
        field.push(cell);
        max = Math.max(max, cell.precip);
      }
    }
  }
  maxCount = Math.round(dropsFor(max));
  if (maxCount === 0) {
    drops = [];
    cancelAnimationFrame(rainRaf);
    rainRaf = 0;
    rainCanvas.hidden = true;
    return;
  }
  // 風で斜めに降る（画面の向きに合わせる）
  const w = centerWeather();
  const windDir = (((w?.dir ?? 0) + 180 - map.getBearing()) * Math.PI) / 180;
  slant = Math.sin(windDir) * Math.min(1, (w?.wind ?? 0) / 8) * 0.5;
  rainCanvas.hidden = false;
  while (drops.length < maxCount) {
    drops.push({ x: Math.random() * w0, y: Math.random() * h0, v: 0.6 + Math.random() * 0.6, len: 8 + Math.random() * 10, r: Math.random() });
  }
  drops.length = maxCount;
  if (!rainRaf) rainRaf = requestAnimationFrame(rainFrame);
}
// 地図を動かしたら、画面のどこで降っているかを数えなおす（動かしている間は間引く）
let rainMoveAt = 0;
map.on('move', () => {
  if (!fxOn() || performance.now() - rainMoveAt < 300) return;
  rainMoveAt = performance.now();
  updateRain(true);
});

/** 雨は30コマ/秒で十分なので、それより速くは描かない */
const RAIN_FRAME_MS = 33;
let rainLast = 0;
function rainFrame(now: number) {
  // 裏に回っているとき・ポケット表示のあいだは止める（戻ったら updateWeatherLayers で再開する）
  rainRaf = drops.length && document.visibilityState === 'visible' && !document.body.classList.contains('pocket-on') ? requestAnimationFrame(rainFrame) : 0;
  if (now - rainLast < RAIN_FRAME_MS) return;
  const step = Math.min(3, (now - rainLast) / 16.7);
  rainLast = now;
  // シートを全画面に広げて地図が見えないあいだは描かない
  if (document.body.classList.contains('sheet-full')) return;
  const dpr = window.devicePixelRatio || 1;
  const w = rainCanvas.clientWidth;
  const h = rainCanvas.clientHeight;
  if (rainCanvas.width !== Math.round(w * dpr)) rainCanvas.width = Math.round(w * dpr);
  if (rainCanvas.height !== Math.round(h * dpr)) rainCanvas.height = Math.round(h * dpr);
  const ctx = rainCanvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(215, 228, 245, 0.75)';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1.5;
  const rain = new Path2D();
  const snow = new Path2D();
  for (const d of drops) {
    const cell = field[Math.min(FIELD_Y - 1, Math.max(0, Math.floor((d.y / h) * FIELD_Y))) * FIELD_X + Math.min(FIELD_X - 1, Math.max(0, Math.floor((d.x / w) * FIELD_X)))];
    const speed = (cell?.snow ? d.v * 2 : d.v * 18) * step;
    d.y += speed;
    d.x += slant * speed + (cell?.snow ? Math.sin(d.y / 30) * 0.6 : 0);
    if (d.y > h) {
      d.y = -20;
      d.x = Math.random() * w;
    }
    if (d.x > w) d.x -= w;
    if (d.x < 0) d.x += w;
    // そのマスの降水量に見合う割合の粒だけ描く（降っていないマスでは描かない）
    if (!cell || d.r >= dropsFor(cell.precip) / maxCount) continue;
    if (cell.snow) {
      snow.moveTo(d.x + 2, d.y);
      snow.arc(d.x, d.y, 2, 0, Math.PI * 2);
    } else {
      rain.moveTo(d.x, d.y);
      rain.lineTo(d.x - slant * d.len, d.y - d.len);
    }
  }
  ctx.stroke(rain);
  ctx.fill(snow);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && drops.length && !rainRaf) rainRaf = requestAnimationFrame(rainFrame);
});
