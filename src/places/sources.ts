/**
 * 地図に重ねる「場所の情報」。公開データから読むもの・自分で読み込んだファイルを、同じ形（PlaceItem）にする（DOM に触れない）。
 *  - commons: Wikimedia Commons の、位置の付いた写真（自由なライセンス）
 *  - inat:    iNaturalist の、写真付きの生きものの観察記録（研究用の質のもの・写真にライセンスがあるもの）
 *  - osm:     OpenStreetMap の山小屋・宿・水場・トイレ・展望地・山頂・バス停・駐車場など（Overpass API）
 *  - user:    自分で読み込んだ場所・コメント・写真（GeoJSON・GPX のウェイポイント）
 * 公開データは約5kmのマス目（PLACE_CELL_DEG）ごとに取り、端末に保存して圏外でも出す（app/places.ts）。
 */
import type { LngLat } from '../geo';

export type PlaceSource = 'commons' | 'inat' | 'osm' | 'user';
/** ネットから取るもの */
export type RemoteSource = Exclude<PlaceSource, 'user'>;
export const REMOTE_SOURCES: RemoteSource[] = ['osm', 'commons', 'inat'];

/** マス目の大きさ（度）。約 4.4km × 5.5km（北緯37度） */
export const PLACE_CELL_DEG = 0.05;

/**
 * 地図に出す種類。種類ごとにアイコンと色を変え、表示・非表示を切り替えられる。
 * prio が小さいほど、重なったときに優先して出す
 */
export const PLACE_CATS = {
  hut: { label: '山小屋・避難小屋', icon: '🛖', color: '#8d5524', prio: 0, source: 'osm' },
  inn: { label: '宿（温泉宿・旅館・ホテル）', icon: '🏨', color: '#b4442c', prio: 0.5, source: 'osm' },
  water: { label: '水場・湧き水', icon: '💧', color: '#1e7fd6', prio: 1, source: 'osm' },
  toilet: { label: 'トイレ', icon: '🚻', color: '#6a4fa3', prio: 2, source: 'osm' },
  camp: { label: 'キャンプ場', icon: '⛺', color: '#2e7d32', prio: 3, source: 'osm' },
  view: { label: '展望地・見どころ', icon: '🔭', color: '#e07000', prio: 4, source: 'osm' },
  peak: { label: '山頂', icon: '⛰️', color: '#5d4037', prio: 4.5, source: 'osm' },
  onsen: { label: '温泉', icon: '♨️', color: '#d84315', prio: 5, source: 'osm' },
  fall: { label: '滝', icon: '🌊', color: '#00838f', prio: 6, source: 'osm' },
  bus: { label: 'バス停', icon: '🚏', color: '#0277bd', prio: 6.5, source: 'osm' },
  parking: { label: '駐車場', icon: '🅿️', color: '#546e7a', prio: 6.8, source: 'osm' },
  mine: { label: '読み込んだ場所・コメント', icon: '💬', color: '#c2185b', prio: 7, source: 'user' },
  photo: { label: '写真（Wikimedia Commons）', icon: '📷', color: '#3949ab', prio: 8, source: 'commons' },
  life: { label: '生きもの（iNaturalist）', icon: '🌿', color: '#5f8f00', prio: 9, source: 'inat' },
} as const satisfies Record<string, { label: string; icon: string; color: string; prio: number; source: PlaceSource }>;
export type PlaceCat = keyof typeof PLACE_CATS;
export const PLACE_CAT_IDS = Object.keys(PLACE_CATS) as PlaceCat[];

/** OpenStreetMap の場所の細かい種類（吹き出しに出す名前） */
export const OSM_KINDS = {
  hut: { label: '山小屋', cat: 'hut' },
  shelter: { label: '避難小屋・あずまや', cat: 'hut' },
  camp: { label: 'キャンプ場', cat: 'camp' },
  water: { label: '水場', cat: 'water' },
  spring: { label: '湧き水', cat: 'water' },
  toilet: { label: 'トイレ', cat: 'toilet' },
  view: { label: '展望地', cat: 'view' },
  onsen: { label: '温泉', cat: 'onsen' },
  fall: { label: '滝', cat: 'fall' },
  inn: { label: '宿', cat: 'inn' },
  attraction: { label: '見どころ', cat: 'view' },
  peak: { label: '山頂', cat: 'peak' },
  bus: { label: 'バス停', cat: 'bus' },
  parking: { label: '駐車場', cat: 'parking' },
} as const satisfies Record<string, { label: string; cat: PlaceCat }>;
export type OsmKind = keyof typeof OSM_KINDS;

export interface PlaceItem {
  /** `${source}:${元の id}` */
  id: string;
  source: PlaceSource;
  cat: PlaceCat;
  lngLat: LngLat;
  /** 写真の題・生きものの名前・場所の名前 */
  title: string;
  /** 生きものの学名・場所の細かい種類など */
  subtitle?: string;
  /** 小さな画像（地図の吹き出し・オフライン保存用） */
  thumb?: string;
  /** 大きな画像 */
  image?: string;
  /** 撮った人・観察した人・書いた人 */
  credit?: string;
  license?: string;
  /** 元のページ */
  url?: string;
  /** 撮った・観察した・書いた時刻 (ms) */
  time?: number;
  /** 詳しい情報（「標高 1,850 m」・コメントなど）。1つが1行 */
  details?: string[];
}

/** マス目の番号（"x,y"） */
export const placeCellKey = ([lng, lat]: LngLat) => `${Math.floor(lng / PLACE_CELL_DEG)},${Math.floor(lat / PLACE_CELL_DEG)}`;

/** マス目の範囲 (west, south, east, north) */
export function placeCellBounds(key: string): [number, number, number, number] {
  const [x, y] = key.split(',').map(Number);
  const r = (v: number) => +v.toFixed(4);
  return [r(x * PLACE_CELL_DEG), r(y * PLACE_CELL_DEG), r((x + 1) * PLACE_CELL_DEG), r((y + 1) * PLACE_CELL_DEG)];
}

/** 範囲にかかるマス目。中心に近い順に、多すぎるときは limit まで */
export function placeCellsIn([w, s, e, n]: [number, number, number, number], limit = 64): string[] {
  const cx = (w + e) / 2 / PLACE_CELL_DEG;
  const cy = (s + n) / 2 / PLACE_CELL_DEG;
  const out: { key: string; d: number }[] = [];
  for (let x = Math.floor(w / PLACE_CELL_DEG); x <= Math.floor(e / PLACE_CELL_DEG); x++) {
    for (let y = Math.floor(s / PLACE_CELL_DEG); y <= Math.floor(n / PLACE_CELL_DEG); y++) {
      out.push({ key: `${x},${y}`, d: (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 });
    }
  }
  return out
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((c) => c.key);
}

/** マス目をまとめた範囲 (west, south, east, north) */
export function cellsBounds(cells: string[]): [number, number, number, number] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of cells) {
    const [cw, cs, ce, cn] = placeCellBounds(c);
    w = Math.min(w, cw);
    s = Math.min(s, cs);
    e = Math.max(e, ce);
    n = Math.max(n, cn);
  }
  return [w, s, e, n];
}

/** HTML のタグを除いて1行の文字にする（Commons の撮影者は HTML で届く） */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Wikimedia Commons ----------
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
/** 1マス目あたりの写真の数の上限（多すぎる場所で地図が埋まらないように。画像の情報を1回で聞ける50件まで） */
const COMMONS_LIMIT = 50;

/** 1. マス目の中の写真を探す */
export function commonsSearchUrl(cell: string): string {
  const [w, s, e, n] = placeCellBounds(cell);
  const q = new URLSearchParams({
    action: 'query',
    list: 'geosearch',
    gsbbox: `${n}|${w}|${s}|${e}`,
    gsnamespace: '6',
    gslimit: String(COMMONS_LIMIT),
    format: 'json',
    origin: '*',
  });
  return `${COMMONS}?${q}`;
}

export interface CommonsGeo {
  pageid: number;
  title: string;
  lat: number;
  lon: number;
}

/** 位置が大ざっぱ（小数2桁まで）な写真は除く（宇宙から撮った写真などが、マス目の角に集まるため） */
const precise = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) > 1e-6;

export function parseCommonsSearch(json: unknown): CommonsGeo[] {
  const list = (json as { query?: { geosearch?: CommonsGeo[] } }).query?.geosearch ?? [];
  return list.filter((g) => precise(g.lat) || precise(g.lon));
}

/** 2. 見つけた写真の画像と、撮った人・ライセンス */
export function commonsInfoUrl(pageids: number[]): string {
  const q = new URLSearchParams({
    action: 'query',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    // 縮小画像の幅は、Wikimedia が用意している大きさ（330・960 など）に合わせる
    iiurlwidth: '330',
    iiextmetadatafilter: 'Artist|LicenseShortName|DateTimeOriginal|ObjectName',
    pageids: pageids.join('|'),
    format: 'json',
    origin: '*',
  });
  return `${COMMONS}?${q}`;
}

interface CommonsPage {
  pageid: number;
  title: string;
  imageinfo?: {
    thumburl?: string;
    descriptionurl?: string;
    extmetadata?: Record<string, { value?: string }>;
  }[];
}

/** ファイル名を題にする（「File:」・拡張子・「 - panoramio」を除く） */
const fileTitle = (t: string) =>
  t
    .replace(/^File:/, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/ - panoramio( \(\d+\))?$/, '')
    .replace(/_/g, ' ');

export function parseCommonsInfo(geo: CommonsGeo[], json: unknown): PlaceItem[] {
  const pages = (json as { query?: { pages?: Record<string, CommonsPage> } }).query?.pages ?? {};
  const out: PlaceItem[] = [];
  for (const g of geo) {
    const info = pages[g.pageid]?.imageinfo?.[0];
    if (!info?.thumburl) continue;
    const meta = info.extmetadata ?? {};
    const text = (k: string) => (meta[k]?.value ? stripHtml(meta[k].value!) : undefined);
    const time = Date.parse(text('DateTimeOriginal') ?? '');
    // 縮小画像の URL に付く計測用の ?utm_… は外す（同じ画像を同じ URL で保存・表示するため）
    const thumb = info.thumburl.split('?')[0];
    out.push({
      id: `commons:${g.pageid}`,
      source: 'commons',
      cat: 'photo',
      lngLat: [g.lon, g.lat],
      title: text('ObjectName') || fileTitle(g.title),
      thumb,
      image: thumb.replace(/\/\d+px-/, '/960px-'),
      credit: text('Artist'),
      license: text('LicenseShortName'),
      url: info.descriptionurl,
      time: Number.isFinite(time) ? time : undefined,
    });
  }
  return out;
}

// ---------- iNaturalist ----------
/** 写真のライセンス。すべての権利が保留されている写真は使わない */
const INAT_LICENSES = 'cc0,cc-by,cc-by-sa,cc-by-nd,cc-by-nc,cc-by-nc-sa,cc-by-nc-nd';
const INAT_LIMIT = 60;

export function inatUrl(cell: string): string {
  const [w, s, e, n] = placeCellBounds(cell);
  const q = new URLSearchParams({
    swlat: String(s),
    swlng: String(w),
    nelat: String(n),
    nelng: String(e),
    photos: 'true',
    quality_grade: 'research',
    photo_license: INAT_LICENSES,
    per_page: String(INAT_LIMIT),
    order_by: 'observed_on',
    locale: 'ja',
  });
  return `https://api.inaturalist.org/v1/observations?${q}`;
}

interface InatObs {
  id: number;
  location?: string;
  obscured?: boolean;
  observed_on?: string;
  uri?: string;
  species_guess?: string;
  taxon?: { name?: string; preferred_common_name?: string };
  photos?: { url?: string; attribution?: string; license_code?: string }[];
}

export function parseInat(json: unknown): PlaceItem[] {
  const list = (json as { results?: InatObs[] }).results ?? [];
  const out: PlaceItem[] = [];
  for (const o of list) {
    const photo = o.photos?.[0];
    // 位置をぼかしてある記録（希少な生きもの・本人の設定）は、場所が正しくないので出さない
    if (o.obscured || !o.location || !photo?.url || !photo.license_code) continue;
    const [lat, lng] = o.location.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const name = o.taxon?.preferred_common_name ?? o.species_guess ?? o.taxon?.name ?? '生きもの';
    const time = Date.parse(o.observed_on ?? '');
    out.push({
      id: `inat:${o.id}`,
      source: 'inat',
      cat: 'life',
      lngLat: [lng, lat],
      title: name,
      subtitle: o.taxon?.name && o.taxon.name !== name ? o.taxon.name : undefined,
      thumb: photo.url.replace('/square.', '/small.'),
      image: photo.url.replace('/square.', '/medium.'),
      credit: photo.attribution,
      // 撮った人の表示に「(CC BY)」などが入っていれば、ライセンスは重ねて出さない
      license: /\((CC[^)]*|public domain)\)/i.test(photo.attribution ?? '') ? undefined : photo.license_code.toUpperCase(),
      url: o.uri,
      time: Number.isFinite(time) ? time : undefined,
    });
  }
  return out;
}

// ---------- OpenStreetMap（Overpass API） ----------
/** Overpass API のサーバー（混んでいて答えないときは、次から別のサーバーに聞く） */
export const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

/**
 * 取る種類を変えたら上げる。前の版で取ったマス目は古いとみなして取り直す（app/places.ts）。
 * 版2：宿・見どころ・山頂（名前のあるもの）・バス停・駐車場を足した
 */
export const OSM_QUERY_VERSION = 2;

/** 範囲 (west, south, east, north) の中の山小屋・水場・宿・山頂・バス停など（POST の data に入れる） */
export function overpassQuery([w, s, e, n]: [number, number, number, number]): string {
  const b = `${s},${w},${n},${e}`;
  return (
    '[out:json][timeout:50];(' +
    `nwr["tourism"~"^(alpine_hut|wilderness_hut|camp_site|viewpoint|hotel|guest_house|hostel|motel|chalet|attraction)$"](${b});` +
    `nwr["amenity"~"^(drinking_water|toilets|shelter|parking)$"](${b});` +
    `nwr["natural"~"^(spring|hot_spring)$"](${b});` +
    `nwr["natural"="peak"]["name"](${b});` +
    `nwr["highway"="bus_stop"](${b});` +
    `nwr["waterway"="waterfall"](${b});` +
    ');out center tags;'
  );
}

/** タグから場所の種類を決める */
export function osmKind(tags: Record<string, string>): OsmKind | null {
  switch (tags.tourism) {
    case 'alpine_hut':
    case 'wilderness_hut':
      return 'hut';
    case 'camp_site':
      return 'camp';
    case 'viewpoint':
      return 'view';
    case 'hotel':
    case 'guest_house':
    case 'hostel':
    case 'motel':
    case 'chalet':
      return 'inn';
    case 'attraction':
      return 'attraction';
  }
  switch (tags.amenity) {
    case 'drinking_water':
      return 'water';
    case 'toilets':
      return 'toilet';
    case 'shelter':
      return 'shelter';
    case 'parking':
      return 'parking';
  }
  if (tags.natural === 'spring') return 'spring';
  if (tags.natural === 'hot_spring') return 'onsen';
  if (tags.natural === 'peak' && tags.name) return 'peak';
  if (tags.highway === 'bus_stop') return 'bus';
  if (tags.waterway === 'waterfall') return 'fall';
  return null;
}

/** 山歩きに役立つタグを、日本語の短い行にする */
export function osmDetails(tags: Record<string, string>): string[] {
  const out: string[] = [];
  const yesNo = (v: string) => (v === 'yes' ? 'あり' : v === 'no' ? 'なし' : v);
  const ele = Number(tags.ele);
  if (tags.ele && Number.isFinite(ele)) out.push(`標高 ${Math.round(ele).toLocaleString('ja-JP')} m`);
  if (tags.opening_hours) out.push(`営業 ${tags.opening_hours}`);
  if (tags.capacity) out.push(`収容 ${tags.capacity}人`);
  if (tags.fee) out.push(`料金 ${yesNo(tags.fee)}`);
  if (tags.drinking_water) out.push(`飲用 ${tags.drinking_water === 'yes' ? '可' : tags.drinking_water === 'no' ? '不可' : tags.drinking_water}`);
  if (tags.seasonal) out.push(`季節 ${tags.seasonal}`);
  if (tags.operator) out.push(`管理 ${tags.operator}`);
  const phone = tags.phone ?? tags['contact:phone'];
  if (phone) out.push(`電話 ${phone}`);
  const note = tags['description:ja'] ?? tags.description ?? tags['note:ja'] ?? tags.note;
  if (note) out.push(note);
  return out;
}

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export function parseOverpass(json: unknown): PlaceItem[] {
  const list = (json as { elements?: OsmElement[] }).elements;
  if (!Array.isArray(list)) throw new Error('OpenStreetMap の答えが読めませんでした');
  const out: PlaceItem[] = [];
  for (const el of list) {
    const tags = el.tags ?? {};
    const kind = osmKind(tags);
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!kind || lat == null || lon == null) continue;
    const { label, cat } = OSM_KINDS[kind];
    const name = tags['name:ja'] ?? tags.name;
    out.push({
      id: `osm:${el.type}/${el.id}`,
      source: 'osm',
      cat,
      lngLat: [lon, lat],
      title: name ?? label,
      subtitle: name ? label : undefined,
      details: osmDetails(tags),
      url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    });
  }
  return out;
}

/**
 * OpenFreeMap の地図データ（OpenMapTiles の poi 層）の点の種類。Overpass が混んでいて答えないときの代わり
 * （名前と種類だけで、標高・営業期間などの詳しい情報はない）
 */
export function tilePoiKind(cls: string, subclass: string): OsmKind | null {
  switch (subclass) {
    case 'alpine_hut':
    case 'wilderness_hut':
      return 'hut';
    case 'shelter':
      return 'shelter';
    case 'camp_site':
      return 'camp';
    case 'viewpoint':
      return 'view';
    case 'drinking_water':
      return 'water';
    case 'spring':
      return 'spring';
    case 'hot_spring':
      return 'onsen';
    case 'waterfall':
      return 'fall';
    case 'toilets':
      return 'toilet';
    case 'hotel':
    case 'guest_house':
    case 'hostel':
    case 'motel':
    case 'chalet':
      return 'inn';
    case 'bus_stop':
      return 'bus';
    case 'parking':
      return 'parking';
    case 'attraction':
      return 'attraction';
  }
  if (cls === 'shelter') return 'shelter';
  if (cls === 'toilets') return 'toilet';
  if (cls === 'drinking_water') return 'water';
  return null;
}

export function fromTilePois(pois: { cls: string; subclass: string; name?: string; lngLat: LngLat }[]): PlaceItem[] {
  const out: PlaceItem[] = [];
  for (const p of pois) {
    const kind = tilePoiKind(p.cls, p.subclass);
    if (!kind) continue;
    const { label, cat } = OSM_KINDS[kind];
    const [lng, lat] = p.lngLat.map((v) => +v.toFixed(6));
    out.push({
      id: `osm:tile/${kind}/${lng},${lat}`,
      source: 'osm',
      cat,
      lngLat: [lng, lat],
      title: p.name ?? label,
      subtitle: p.name ? label : undefined,
      url: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`,
    });
  }
  return out;
}

/** 範囲で取った場所を、マス目ごとに分ける（場所のないマス目も空で入れる＝「取ったが何もない」を覚える） */
export function splitByCell(items: PlaceItem[], cells: string[]): Map<string, PlaceItem[]> {
  const out = new Map(cells.map((c) => [c, [] as PlaceItem[]]));
  for (const it of items) out.get(placeCellKey(it.lngLat))?.push(it);
  return out;
}

// ---------- 自分で読み込む場所（GeoJSON・GPX のウェイポイント） ----------
/**
 * 読み込める GeoJSON：Point の Feature を並べた FeatureCollection。properties は次の名前を読む（どれも省略できる）
 *   title / name: 名前　comment / description / desc / text: コメント（改行で複数行）
 *   photo / image: 画像の URL（data URL も可）　thumb: 小さな画像の URL（なければ photo を使う）
 *   time / date: 時刻（ISO 8601 など）　url / link: 元のページ　author / credit / user: 書いた人・撮った人
 *   license: ライセンス　category: 種類（hut・water・toilet・camp・view・onsen・fall。それ以外・なしは「読み込んだ場所」）
 */
export function fromGeoJson(json: unknown, importId: string): PlaceItem[] {
  const fc = json as { type?: string; features?: unknown[] } | null;
  const features = fc?.type === 'FeatureCollection' && Array.isArray(fc.features) ? fc.features : fc?.type === 'Feature' ? [fc] : null;
  if (!features) throw new Error('GeoJSON の FeatureCollection ではありません');
  const out: PlaceItem[] = [];
  features.forEach((f, i) => {
    const feat = f as { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> | null; id?: unknown };
    const c = feat.geometry?.type === 'Point' ? (feat.geometry.coordinates as number[]) : null;
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return;
    const p = feat.properties ?? {};
    const str = (...keys: string[]) => {
      for (const k of keys) {
        const v = p[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number') return String(v);
      }
      return undefined;
    };
    const time = Date.parse(str('time', 'date', 'datetime') ?? '');
    const photo = str('photo', 'image', 'img');
    const cat = str('category', 'cat');
    const comment = str('comment', 'description', 'desc', 'text', 'body');
    out.push({
      id: `user:${importId}/${typeof feat.id === 'string' || typeof feat.id === 'number' ? feat.id : i}`,
      source: 'user',
      cat: cat && cat in PLACE_CATS && PLACE_CATS[cat as PlaceCat].source === 'osm' ? (cat as PlaceCat) : 'mine',
      lngLat: [c[0], c[1]],
      title: str('title', 'name') ?? 'コメント',
      thumb: str('thumb', 'thumbnail') ?? photo,
      image: photo,
      credit: str('author', 'credit', 'user', 'by'),
      license: str('license'),
      url: str('url', 'link', 'href'),
      time: Number.isFinite(time) ? time : undefined,
      details: comment ? comment.split(/\r?\n/).filter((l) => l.trim()) : undefined,
    });
  });
  return out;
}

export interface WaypointLike {
  lng: number;
  lat: number;
  name?: string;
  desc?: string;
  link?: string;
  time?: number;
}

/** GPX のウェイポイントを場所にする */
export const fromWaypoints = (wpts: WaypointLike[], importId: string): PlaceItem[] =>
  wpts.map((w, i) => ({
    id: `user:${importId}/${i}`,
    source: 'user',
    cat: 'mine',
    lngLat: [w.lng, w.lat],
    title: w.name ?? '地点',
    url: w.link,
    time: w.time,
    details: w.desc ? w.desc.split(/\r?\n/).filter((l) => l.trim()) : undefined,
  }));
