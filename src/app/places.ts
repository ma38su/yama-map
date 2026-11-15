/**
 * 地図に重ねる場所の情報（山小屋・水場・トイレ・写真・生きもの・読み込んだ場所など）。
 * 種類ごとに色とアイコンの違う吹き出しで出し、タップで詳しく見る（吹き出しの中身は placeContent、出すのは mapTap.ts）。
 * 公開データはマス目ごとに端末（IndexedDB）に残し、圏外でも出す。ネットに聞くのはズーム12以上で、30日以上前に取ったマス目だけ
 */
import type { PointLike } from 'maplibre-gl';
import type { Feature, FeatureCollection, Point } from 'geojson';
import { viewBounds } from '../geo';
import { log } from '../log';
import { fetchCells } from '../places/load';
import {
  OSM_QUERY_VERSION,
  PLACE_CATS,
  PLACE_CAT_IDS,
  REMOTE_SOURCES,
  fromGeoJson,
  fromWaypoints,
  placeCellsIn,
  type PlaceCat,
  type PlaceItem,
  type RemoteSource,
} from '../places/sources';
import { saveSettings, settings } from '../settings';
import { deleteImport, getPlaceCells, listAreas, listImports, placeKey, prunePlaceCells, putImport, putPlaceCell, type PlaceCell, type PlaceImport } from '../track/db';
import { parseGpx } from '../track/gpx';
import { $, h } from '../ui/dom';
import { emptyFC, fitTo, map, src } from './mapView';
import { pocketActive } from './pocket';
import { TRAIL_LAYERS, updateTrailLayers, type TrailLayerId } from './trails';

export const PLACES_LAYER = 'places';
/** これより縮小しているときは出さない（遠くから見ると吹き出しで地図が埋まるため） */
const MIN_ZOOM = 11;
/** ネットに聞くのはこのズームから（1回に聞くマス目が多くなりすぎないように） */
const FETCH_ZOOM = 12;
/** 一度に扱うマス目の数（中心に近いものから） */
const VIEW_CELLS = 16;
/** 取り直すまでの日数 */
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** 名前と種類だけのマス目（OpenFreeMap の地図データから出したもの）を、Overpass から取り直すまでの時間 */
const PARTIAL_AGE_MS = 6 * 60 * 60_000;
const stale = (c: PlaceCell | undefined, maxAge = MAX_AGE_MS) =>
  !c ||
  Date.now() - c.fetchedAt > (c.partial ? Math.min(maxAge, PARTIAL_AGE_MS) : maxAge) ||
  // 取る種類を増やす前に取った OpenStreetMap のマス目（宿・山頂・バス停などがない）
  (c.source === 'osm' && (c.v ?? 1) < OSM_QUERY_VERSION);
/** 覚えておくマス目の数（地図を動かしても、遠くのマス目は少しずつ忘れる） */
const MEMORY_CELLS = 150;
export const PLACES_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>・<a href="https://commons.wikimedia.org/" target="_blank" rel="noopener">Commons</a>・<a href="https://www.inaturalist.org/" target="_blank" rel="noopener">iNaturalist</a>';

// ---------- 表示・非表示 ----------
export type LayerId = PlaceCat | 'saved' | TrailLayerId;
/** 最初は隠しておく種類（写真・生きものは数が多く地図が埋まるので、見たいときに出す。保存した範囲も） */
const OFF_BY_DEFAULT = new Set<LayerId>(['saved', 'photo', 'life']);
/** その種類を出すか（切り替えていなければ、OFF_BY_DEFAULT 以外は出す） */
export const layerOn = (id: LayerId) => settings.layers?.[id] ?? !OFF_BY_DEFAULT.has(id);

const placesFilter = () => ['in', ['get', 'cat'], ['literal', PLACE_CAT_IDS.filter(layerOn)]] as ['in', unknown, unknown];

export function setLayer(id: LayerId, on: boolean) {
  settings.layers = { ...settings.layers, [id]: on };
  saveSettings();
  if (id === 'saved') return; // 保存した範囲は savedAreas.ts
  if (id in TRAIL_LAYERS) {
    updateTrailLayers();
    return;
  }
  if (map.getLayer(PLACES_LAYER)) map.setFilter(PLACES_LAYER, placesFilter() as never);
  if (on) scheduleRefresh();
}

/** 出す種類のうち、ネットから取るものの出どころ */
const wantedSources = (): RemoteSource[] => REMOTE_SOURCES.filter((s) => PLACE_CAT_IDS.some((c) => PLACE_CATS[c].source === s && layerOn(c)));

// ---------- アイコン ----------
/** 種類ごとの吹き出しのアイコン（色の付いた丸に絵文字、下に向いた先） */
function drawIcon(cat: PlaceCat): ImageData {
  const k = 2; // 高精細の画面向けに2倍で描く
  const w = 30 * k;
  const hgt = 38 * k;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext('2d')!;
  const r = 13 * k;
  const cx = w / 2;
  const cy = r + 2 * k;
  ctx.beginPath();
  ctx.moveTo(cx - 6 * k, cy + r - 3 * k);
  ctx.lineTo(cx, hgt - 1.5 * k);
  ctx.lineTo(cx + 6 * k, cy + r - 3 * k);
  ctx.arc(cx, cy, r, Math.PI * 0.32, Math.PI * 0.68, true);
  ctx.closePath();
  ctx.fillStyle = PLACE_CATS[cat].color;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5 * k;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fill();
  ctx.font = `${15 * k}px "Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(PLACE_CATS[cat].icon, cx, cy + 1 * k);
  return ctx.getImageData(0, 0, w, hgt);
}

// ---------- 地図の層 ----------
/** 地図の読み込み後に一度だけ。before の層より下に置く */
export function addPlaceLayers(before?: string) {
  for (const cat of PLACE_CAT_IDS) map.addImage(`place-${cat}`, drawIcon(cat), { pixelRatio: 2 });
  map.addSource(PLACES_LAYER, { type: 'geojson', data: emptyFC, attribution: PLACES_ATTRIBUTION });
  map.addLayer(
    {
      id: PLACES_LAYER,
      type: 'symbol',
      source: PLACES_LAYER,
      minzoom: MIN_ZOOM,
      filter: placesFilter() as never,
      layout: {
        'icon-image': ['concat', 'place-', ['get', 'cat']],
        'icon-anchor': 'bottom',
        'icon-size': ['interpolate', ['linear'], ['zoom'], MIN_ZOOM, 0.65, 14, 0.9, 16, 1],
        // 重なるときは、山小屋・水場などを写真より優先して出す（隠れたものは拡大すると出る）
        'symbol-sort-key': ['get', 'prio'],
        'icon-padding': 1,
      },
    },
    before,
  );
  render();
  scheduleRefresh();
}

/** タップした位置の吹き出しの場所（指で押しやすいよう、少し広めに探す） */
export function placeAt(p: { x: number; y: number }): PlaceItem | null {
  if (!map.getLayer(PLACES_LAYER)) return null;
  const box: [PointLike, PointLike] = [
    [p.x - 8, p.y - 8],
    [p.x + 8, p.y + 8],
  ];
  const f = map.queryRenderedFeatures(box, { layers: [PLACES_LAYER] })[0];
  return f ? (items.get(String(f.properties?.id)) ?? null) : null;
}

// ---------- 中身（覚えているマス目と、読み込んだファイル） ----------
const cells = new Map<string, PlaceCell>();
let imports: PlaceImport[] = [];
const items = new Map<string, PlaceItem>();
let renderTimer = 0;

function remember(c: PlaceCell) {
  cells.delete(c.key);
  cells.set(c.key, c);
  while (cells.size > MEMORY_CELLS) cells.delete(cells.keys().next().value!);
}

function render() {
  renderTimer = 0;
  items.clear();
  const features: Feature<Point>[] = [];
  const add = (it: PlaceItem) => {
    if (items.has(it.id)) return;
    items.set(it.id, it);
    features.push({ type: 'Feature', properties: { id: it.id, cat: it.cat, prio: PLACE_CATS[it.cat].prio }, geometry: { type: 'Point', coordinates: it.lngLat } });
  };
  for (const imp of imports) imp.items.forEach(add);
  for (const c of cells.values()) c.items.forEach(add);
  src(PLACES_LAYER)?.setData({ type: 'FeatureCollection', features } as FeatureCollection);
}
const scheduleRender = () => (renderTimer ||= window.setTimeout(render, 150));

// ---------- 読み込み ----------
let refreshTimer = 0;
const scheduleRefresh = () => {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refresh(), 500);
};
map.on('moveend', scheduleRefresh);

/** 出どころごとの、ネットに聞いている途中の仕事（1つずつ） */
const jobs = new Map<RemoteSource, Promise<void>>();
/** 聞いているあいだに地図が動いたら、終わってから聞き直す */
let movedDuringJob = false;
const failedOnce = new Set<RemoteSource>();

function viewCells(): string[] {
  const c = map.getCenter();
  const canvas = map.getCanvas();
  return placeCellsIn(viewBounds([c.lng, c.lat], map.getZoom(), canvas.clientWidth, canvas.clientHeight), VIEW_CELLS);
}

async function refresh() {
  if (!map.getLayer(PLACES_LAYER) || document.hidden || pocketActive()) return;
  const sources = wantedSources();
  if (!sources.length || map.getZoom() < MIN_ZOOM) return;
  const inView = viewCells();
  // 1. 端末に残してあるもの
  const missing = sources.flatMap((s) => inView.map((c) => placeKey(s, c))).filter((k) => !cells.has(k));
  if (missing.length) {
    const got = await getPlaceCells(missing).catch(() => []);
    for (const c of got) if (c) remember(c);
    if (got.some(Boolean)) scheduleRender();
  }
  // 2. ネットから（足りない・古いマス目）
  if (map.getZoom() < FETCH_ZOOM || !navigator.onLine) return;
  for (const s of sources) {
    if (jobs.has(s)) {
      movedDuringJob = true;
      continue;
    }
    const need = inView.filter((c) => stale(cells.get(placeKey(s, c))));
    if (!need.length) continue;
    const job = fetchCells(s, need, (c, list, partial) => store(s, c, list, partial), { keep: (c) => viewCells().includes(c) })
      .then(() => void failedOnce.delete(s))
      .catch((e) => {
        if (!failedOnce.has(s)) log(`場所の情報を取れなかった（${s}）: ${e instanceof Error ? e.message : e}`);
        failedOnce.add(s);
      })
      .finally(() => {
        jobs.delete(s);
        if (movedDuringJob && !jobs.size) {
          movedDuringJob = false;
          scheduleRefresh();
        }
      });
    jobs.set(s, job);
  }
}

async function store(source: RemoteSource, cell: string, list: PlaceItem[], partial?: boolean) {
  // 名前と種類だけのものは、前に取った詳しいものがあれば、そちらを残す
  const old = cells.get(placeKey(source, cell));
  if (partial && old && !old.partial) return;
  const c: PlaceCell = {
    key: placeKey(source, cell),
    source,
    cell,
    fetchedAt: Date.now(),
    items: list,
    partial: partial || undefined,
    ...(source === 'osm' ? { v: OSM_QUERY_VERSION } : {}),
  };
  remember(c);
  scheduleRender();
  await putPlaceCell(c).catch((e) => console.warn('場所の情報を保存できませんでした', e));
}

/**
 * オフライン保存用：マス目の場所の情報を、足りない・古い（7日以上前）ものはネットから取って端末に残す。
 * 範囲の中の場所をすべて返す。取れなかった出どころ・名前と種類だけになった出どころも返す
 */
export async function ensurePlaces(
  cellList: string[],
  signal?: AbortSignal,
): Promise<{ items: PlaceItem[]; failed: RemoteSource[]; partial: RemoteSource[] }> {
  /** マス目・出どころ → 場所 */
  const got = new Map<string, PlaceItem[]>();
  const failed: RemoteSource[] = [];
  const partialSources = new Set<RemoteSource>();
  for (const s of REMOTE_SOURCES) {
    const have = await getPlaceCells(cellList.map((c) => placeKey(s, c))).catch(() => cellList.map(() => undefined));
    const need: string[] = [];
    have.forEach((c, i) => {
      if (c) got.set(c.key, c.items);
      if (stale(c, 7 * 24 * 60 * 60_000)) need.push(cellList[i]);
    });
    try {
      await fetchCells(
        s,
        need,
        async (c, list, partial) => {
          if (partial) {
            partialSources.add(s);
            const old = have[cellList.indexOf(c)];
            if (old && !old.partial) return; // 前に取った詳しいものを使う
          }
          got.set(placeKey(s, c), list);
          await store(s, c, list, partial);
        },
        { signal, force: true },
      );
    } catch {
      if (signal?.aborted) break;
      failed.push(s);
    }
  }
  return { items: [...got.values()].flat(), failed, partial: [...partialSources] };
}

/** 読み込んだ場所（オフライン保存で写真を残すため） */
export const importedItems = () => imports.flatMap((i) => i.items);

// ---------- 自分で読み込む場所 ----------
export async function importPlacesFile(file: File): Promise<string> {
  const text = await file.text();
  const id = crypto.randomUUID();
  let list: PlaceItem[];
  if (/\.gpx$/i.test(file.name) || text.trimStart().startsWith('<')) {
    list = fromWaypoints(parseGpx(text).waypoints, id);
  } else {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('GeoJSON・GPX のファイルではありません（読めない形式です）');
    }
    list = fromGeoJson(json, id);
  }
  if (!list.length) throw new Error('ファイルに地点（Point・ウェイポイント）がありません');
  const imp: PlaceImport = { id, name: file.name, importedAt: Date.now(), items: list };
  await putImport(imp);
  imports = [imp, ...imports];
  // 読み込んだ種類は出す
  for (const cat of new Set(list.map((i) => i.cat))) if (!layerOn(cat)) setLayer(cat, true);
  render();
  fitTo(list.map((i) => i.lngLat));
  log(`場所のファイルを読み込んだ: ${list.length}件`);
  return `${list.length}件の場所を読み込みました`;
}

export const placeImports = () => imports;

export async function removeImport(id: string) {
  await deleteImport(id);
  imports = imports.filter((i) => i.id !== id);
  render();
}

// ---------- 吹き出しの中身 ----------
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('ja-JP');

/**
 * 画像を urls の順に読む。まず CORS で読み（Service Worker が端末に残せるのは CORS で読めたものだけ）、
 * 読めなければ普通に読み直す。どれも読めなければ隠す
 */
function loadImage(img: HTMLImageElement, ...urls: string[]) {
  const steps = urls.flatMap((u) => [{ u, cors: true }, { u, cors: false }]);
  let i = 0;
  const next = () => {
    const step = steps[i++];
    if (!step) {
      img.hidden = true;
      return;
    }
    if (step.cors) img.crossOrigin = 'anonymous';
    else img.removeAttribute('crossorigin');
    img.src = step.u;
  };
  img.onerror = next;
  next();
}

/** 場所の吹き出しの中身（ルートに使うボタンは mapTap.ts が足す） */
export function placeContent(it: PlaceItem): HTMLElement {
  const def = PLACE_CATS[it.cat];
  const box = h('div', 'pl');
  const head = h('div', 'pl-head');
  const ic = h('span', 'pl-ic', def.icon);
  ic.style.background = def.color;
  head.append(ic, h('span', 'pl-kind', it.subtitle && it.source === 'osm' ? it.subtitle : def.label));
  box.append(head, h('div', 'pp-name', it.title));
  if (it.subtitle && it.source !== 'osm') box.append(h('div', 'pl-sub', it.subtitle));
  if (it.thumb) {
    const img = h('img', 'pl-img');
    img.alt = it.title;
    loadImage(img, it.thumb);
    img.addEventListener('click', () => openPlaceView(it));
    box.append(img);
  }
  for (const line of it.details ?? []) box.append(h('div', 'pl-line', line));
  const meta = [it.time ? fmtDate(it.time) : '', it.credit ?? '', it.license ?? ''].filter(Boolean).join('・');
  if (meta) box.append(h('div', 'pl-meta', meta));
  if (it.url && /^https?:/.test(it.url)) {
    const a = h('a', 'pl-link', it.source === 'osm' ? 'OpenStreetMap で見る・直す' : '元のページを見る');
    a.href = it.url;
    a.target = '_blank';
    a.rel = 'noopener';
    box.append(a);
  }
  return box;
}

// ---------- 写真を大きく見る ----------
const viewer = $<HTMLDialogElement>('place-view');
const viewImg = $<HTMLImageElement>('place-view-img');
function openPlaceView(it: PlaceItem) {
  viewImg.hidden = false;
  viewImg.alt = it.title;
  // 大きな画像が読めなければ（圏外など）、保存してある小さな画像を出す
  loadImage(viewImg, ...[it.image, it.thumb].filter((u): u is string => !!u));
  $('place-view-caption').textContent = [it.title, it.time ? fmtDate(it.time) : '', it.credit ?? '', it.license ?? ''].filter(Boolean).join('・');
  viewer.showModal();
}
viewer.addEventListener('click', (e) => {
  if (e.target === viewer) viewer.close();
});
viewer.addEventListener('close', () => viewImg.removeAttribute('src'));

// ---------- 起動時 ----------
void listImports()
  .then((list) => {
    imports = list;
    scheduleRender();
  })
  .catch(() => {});

// 端末に残した場所の情報は、保存した範囲で使うもの以外、90日経ったら消す（起動して少ししてから、1日1回まで）
const PRUNED_KEY = 'yama-map:places-pruned';
setTimeout(() => {
  try {
    if (Date.now() - Number(localStorage.getItem(PRUNED_KEY) ?? 0) < 24 * 60 * 60_000) return;
    localStorage.setItem(PRUNED_KEY, String(Date.now()));
  } catch {
    return;
  }
  void listAreas()
    .then((areas) => prunePlaceCells(Date.now() - 90 * 24 * 60 * 60_000, new Set(areas.flatMap((a) => a.cells))))
    .then((n) => n && log(`古い場所の情報を消した: ${n}マス`))
    .catch(() => {});
}, 30_000);
