/**
 * 行程（ルートと 出発地・経由地・目的地）の管理。
 *  - auto: 地図で選んだ地点の間を、道・登山道データでルート検索してつなぐ。候補を複数作って選べる
 *  - gpx : 読み込んだGPXの経路をそのまま使い、地点は経路上に投影する
 */
import { bbox, cumulativeDistances, densify, distance, type LngLat } from '../geo';
import { loadOsmLines, loadRoadLines, type PlaceLabel } from '../route/roadTiles';
import { PROFILES, TrailGraph, WAY_KINDS, overlapRatio, type CostProfile, type RouteLine, type WayKind } from '../route/trailRouter';
import type { GpxData } from '../track/gpx';
import { projectOnRoute } from './eta';

/** start/via/dest は自分で選んだ地点、pass はルート沿いの地名（温泉・小屋・山頂など）から自動で付けた通過点 */
export type MarkKind = 'start' | 'via' | 'dest' | 'pass';
export type PointKind = Exclude<MarkKind, 'pass'>;

export interface PlanPoint {
  id: string;
  kind: PointKind;
  name: string;
  lngLat: LngLat;
}

export interface Mark {
  id: string;
  kind: MarkKind;
  name: string;
  lngLat: LngLat;
  /** 経路の始点からの距離 (m) */
  along: number;
}

export type DataSource = 'gsi' | 'osm' | 'gpx';

/** ルート候補 */
export interface RouteOption {
  label: string;
  source: DataSource;
  coords: LngLat[];
  eles: (number | null)[];
  dists: number[];
  /** along の昇順 */
  marks: Mark[];
  /** 道の種類ごとの距離 (m) */
  byKind: Record<WayKind, number>;
  /** 道が見つからず直線で結んだ区間の数 */
  straightLegs: number;
  /** ほぼ同じ経路になったほかの探し方（「最短距離」「OpenStreetMap」など）。経路の確からしさの目安 */
  sameAs?: string[];
}

export interface ActiveRoute extends RouteOption {
  name: string;
  kind: 'auto' | 'gpx';
  /** auto: ルート検索に使った地点（出発地, 経由地..., 目的地） */
  points?: PlanPoint[];
  /** auto: ルート候補。選んでいるのは options[chosen] */
  options?: RouteOption[];
  chosen?: number;
}

/** ルートの探し方（設定）。候補はどちらでも全部作っておき、選ぶ候補だけを変える */
export type RoutePref = 'trail' | 'short';
export const ROUTE_PREFS: Record<RoutePref, { label: string; desc: string }> = {
  trail: { label: '登山道優先', desc: '車道・林道はなるべく避け、登山道（徒歩道）を通ります' },
  short: { label: '最短距離', desc: '道の種類を問わず、いちばん短い道を通ります' },
};

/** 設定に合う候補の番号 */
export function preferredOption(options: RouteOption[], pref: RoutePref): number {
  const named = (label: string) => options.findIndex((o) => o.label === label || o.sameAs?.includes(label));
  const best = (score: (o: RouteOption) => number) =>
    options.reduce((bi, o, i) => (score(o) < score(options[bi]) ? i : bi), 0);
  if (pref === 'short') {
    const i = named('最短距離');
    return i >= 0 ? i : best((o) => {
      const span = routeSpan(o);
      return span.to - span.from;
    });
  }
  const i = named('登山道優先');
  return i >= 0 ? i : best((o) => -(trailShare(o) ?? 0));
}

export type ElevationFn = (lng: number, lat: number) => Promise<number | null>;

const newId = () => Math.random().toString(36).slice(2, 10);
export const makePoint = (kind: PointKind, lngLat: LngLat, name?: string): PlanPoint => ({
  id: newId(),
  kind,
  lngLat,
  name: name ?? (kind === 'start' ? '出発地' : kind === 'dest' ? '目的地' : '経由地'),
});

/** 経由地を、遠回りが最も少なくなる位置に差し込む */
export function insertVia(points: PlanPoint[], via: PlanPoint): PlanPoint[] {
  if (points.length < 2) return [...points, via];
  let best = 1;
  let bestCost = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].lngLat;
    const b = points[i].lngLat;
    const cost = distance(a, via.lngLat) + distance(via.lngLat, b) - distance(a, b);
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  return [...points.slice(0, best), via, ...points.slice(best)];
}

/** 地点リストを kind に合わせて並べ直す（出発地を先頭、目的地を末尾） */
export function normalizePoints(points: PlanPoint[]): PlanPoint[] {
  const start = points.find((p) => p.kind === 'start');
  const dest = points.find((p) => p.kind === 'dest');
  const vias = points.filter((p) => p.kind === 'via');
  return [...(start ? [start] : []), ...vias, ...(dest ? [dest] : [])];
}

function boundsAround(points: LngLat[]): [number, number, number, number] {
  let [w, s, e, n] = bbox(points);
  // 周囲に余裕（25% か 800m の大きい方）を持たせる：道は直線より大回りすることが多い
  const mLat = 1 / 110_574;
  const mLng = 1 / (111_320 * Math.cos(((s + n) / 2) * (Math.PI / 180)));
  const padLat = Math.max((n - s) * 0.25, 800 * mLat);
  const padLng = Math.max((e - w) * 0.25, 800 * mLng);
  w -= padLng;
  e += padLng;
  s -= padLat;
  n += padLat;
  return [w, s, e, n];
}

async function withElevations(coords: LngLat[], elevation: ElevationFn): Promise<(number | null)[]> {
  return Promise.all(coords.map((c) => elevation(c[0], c[1])));
}

/** 地名のうち、通過点にする価値があるもの（川・沢の名前などは除く） */
const PLACE_RE = /(温泉|の湯|湯|小屋|山荘|ヒュッテ|避難小屋|峠|岳|山|峰|ノ頭|の頭|滝|沼|池|湖|乗越|分岐|キャンプ場|登山口|神社|駐車場)$/;

/**
 * ルート沿い（offset m 以内）にある地名を通過点にする。
 * 出発地・経由地・目的地の近く（100m以内）や、同じ名前の重複は除く。
 */
export function detectPassPoints(
  coords: LngLat[],
  dists: number[],
  labels: PlaceLabel[],
  existing: { along: number; name: string }[],
  offset = 80,
): Mark[] {
  const out: Mark[] = [];
  const seen = new Set(existing.map((m) => m.name));
  const cands = labels
    .filter((l) => PLACE_RE.test(l.text))
    .map((l) => ({ l, pos: projectOnRoute(coords, dists, l.lngLat) }))
    .filter((c) => c.pos && c.pos.offset <= offset)
    .sort((a, b) => a.pos!.offset - b.pos!.offset);
  for (const { l, pos } of cands) {
    const along = pos!.along;
    if (seen.has(l.text)) continue;
    if (existing.some((m) => Math.abs(m.along - along) < 100)) continue;
    if (out.some((m) => Math.abs(m.along - along) < 80)) continue;
    seen.add(l.text);
    out.push({ id: newId(), kind: 'pass', name: l.text, lngLat: l.lngLat, along });
  }
  return out;
}

const zeroKinds = (): Record<WayKind, number> => ({ trail: 0, track: 0, road: 0, major: 0 });

interface RawCandidate {
  label: string;
  source: DataSource;
  legs: LngLat[][];
  edges: Set<number>;
  byKind: Record<WayKind, number>;
  straightLegs: number;
  length: number;
}

function routeAllLegs(
  graph: TrailGraph | null,
  pts: PlanPoint[],
  profile: CostProfile,
  penalty?: Map<number, number>,
): Omit<RawCandidate, 'label' | 'source'> {
  const legs: LngLat[][] = [];
  const edges = new Set<number>();
  const byKind = zeroKinds();
  let straightLegs = 0;
  let length = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1].lngLat;
    const b = pts[i].lngLat;
    const r = graph?.route(a, b, { profile, maxSnap: 300, penalty });
    if (r && r.snapFrom < 300 && r.snapTo < 300) {
      legs.push(r.coords);
      r.edges.forEach((e) => edges.add(e));
      for (const k of WAY_KINDS) byKind[k] += r.byKind[k];
      length += r.length + r.snapFrom + r.snapTo;
    } else {
      legs.push([a, b]);
      straightLegs++;
      length += distance(a, b);
    }
  }
  return { legs, edges, byKind, straightLegs, length };
}

/**
 * 地点の間を道・登山道沿いにつないだルート候補を作る。
 *  1. 登山道優先（国土地理院の道データ）
 *  2. 別ルート（1 で通った道を避けて再検索）
 *  3. 最短距離（車道・林道も同じ扱い）
 *  4. 登山道優先（OpenStreetMap のデータ）
 * ほとんど同じ経路になった候補はまとめる。
 * failedTiles は読めなかった道のデータのタイルの数（圏外・電波が弱いなど。多いと、道があっても直線や遠回りになりうる）。
 * signal で止めたら AbortError
 */
export async function buildRouteOptions(
  points: PlanPoint[],
  elevation: ElevationFn,
  pref: RoutePref = 'trail',
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<ActiveRoute & { failedTiles: number }> {
  const pts = normalizePoints(points);
  if (pts.length < 2) throw new Error('出発地と目的地が必要です');
  const bounds = boundsAround(pts.map((p) => p.lngLat));
  onProgress?.('道のデータを読み込み中…');
  const [gsi, osmLines] = await Promise.all([
    loadRoadLines(bounds, (d, t) => onProgress?.(`道のデータを読み込み中… ${d}/${t}`), signal),
    loadOsmLines(bounds, signal).catch(() => [] as RouteLine[]),
  ]);
  signal?.throwIfAborted();
  onProgress?.('ルートを計算中…');
  const gsiGraph = gsi.lines.length ? new TrailGraph(gsi.lines) : null;
  const osmGraph = osmLines.length ? new TrailGraph(osmLines) : null;

  const raw: RawCandidate[] = [];
  const walk = routeAllLegs(gsiGraph, pts, PROFILES.walk);
  raw.push({ label: '登山道優先', source: 'gsi', ...walk });
  if (gsiGraph && walk.straightLegs === 0) {
    const penalty = new Map<number, number>();
    for (const e of walk.edges) penalty.set(e, 4);
    raw.push({ label: '別ルート', source: 'gsi', ...routeAllLegs(gsiGraph, pts, PROFILES.walk, penalty) });
    raw.push({ label: '最短距離', source: 'gsi', ...routeAllLegs(gsiGraph, pts, PROFILES.short) });
  }
  if (osmGraph) {
    const osm = routeAllLegs(osmGraph, pts, PROFILES.walk);
    if (osm.straightLegs < walk.straightLegs || osm.straightLegs === 0) {
      raw.push({ label: '登山道優先（OSM）', source: 'osm', ...osm });
    }
  }

  // 直線で結ぶ区間が少ない候補を先に。似た候補・遠回りすぎる候補は除く
  raw.sort((a, b) => a.straightLegs - b.straightLegs);
  const kept: (RawCandidate & { flat: LngLat[]; sameAs: string[] })[] = [];
  const base = raw[0];
  for (const c of raw) {
    const flat = c.legs.flatMap((leg, i) => (i === 0 ? leg : leg.slice(1)));
    if (kept.length && c.straightLegs > base.straightLegs) continue;
    if (kept.length && c.length > base.length * 1.8 + 500) continue;
    const same = kept.find((k) => overlapRatio(flat, k.flat) > 0.85 && overlapRatio(k.flat, flat) > 0.85);
    if (same) {
      same.sameAs.push(c.source === 'osm' && same.source !== 'osm' ? 'OpenStreetMap' : c.label);
      continue;
    }
    // 「別ルート」は中身に合わせて名前を付ける
    let label = c.label;
    if (label === '別ルート') {
      const total = WAY_KINDS.reduce((sum, k) => sum + c.byKind[k], 0) || 1;
      label = c.byKind.trail / total < 0.3 ? '林道・車道経由' : '別の登山道';
    }
    kept.push({ ...c, label, flat, sameAs: [] });
  }
  onProgress?.('標高を計算中…');
  const options: RouteOption[] = [];
  for (const c of kept) {
    signal?.throwIfAborted();
    const coords: LngLat[] = [];
    const legEnds: number[] = [];
    for (const leg of c.legs) {
      const d = densify(leg, 50);
      coords.push(...(coords.length ? d.slice(1) : d));
      legEnds.push(coords.length - 1);
    }
    const dists = cumulativeDistances(coords);
    const eles = await withElevations(coords, elevation);
    const userMarks: Mark[] = pts.map((p, i) => ({ ...p, along: i === 0 ? 0 : dists[legEnds[i - 1]] }));
    const pass = detectPassPoints(coords, dists, gsi.labels, userMarks);
    options.push({
      label: c.label,
      source: c.source,
      coords,
      eles,
      dists,
      marks: [...userMarks, ...pass].sort((a, b) => a.along - b.along),
      byKind: c.byKind,
      straightLegs: c.straightLegs,
      sameAs: c.sameAs,
    });
  }
  signal?.throwIfAborted();
  const route = chooseOption({ name: `${pts[0].name} → ${pts[pts.length - 1].name}`, kind: 'auto', points: pts, options }, preferredOption(options, pref));
  return { ...route, failedTiles: gsi.failed };
}

/** 候補 i を選ぶ */
export function chooseOption(r: Pick<ActiveRoute, 'name' | 'kind' | 'points' | 'options'>, i: number): ActiveRoute {
  const opt = r.options![i];
  return { ...r, ...opt, name: r.name, kind: r.kind, chosen: i };
}

/** 出発地と目的地を入れ替える（経由地はそのまま、通過点も変えない） */
const swapKind = <K extends MarkKind>(k: K): K => (k === 'start' ? 'dest' : k === 'dest' ? 'start' : k) as K;

/** 候補を逆向きにする（帰り道）。道の形はそのままで、距離・地点の位置を目的地側から数え直す */
function reverseOption<T extends RouteOption>(o: T): T {
  const total = o.dists[o.dists.length - 1] ?? 0;
  return {
    ...o,
    coords: [...o.coords].reverse(),
    eles: [...o.eles].reverse(),
    dists: o.dists.map((d) => total - d).reverse(),
    marks: o.marks.map((m) => ({ ...m, kind: swapKind(m.kind), along: total - m.along })).reverse(),
  };
}

/**
 * ルートを逆向き（帰り道）にする。道を探し直さないので圏外でもでき、行きと同じ道を通る。
 * 名前の「A → B」は「B → A」に
 */
export function reverseRoute(r: ActiveRoute): ActiveRoute {
  const parts = r.name.split(' → ');
  return {
    ...reverseOption(r),
    name: parts.length === 2 ? `${parts[1]} → ${parts[0]}` : `${r.name}（逆向き）`,
    points: r.points && normalizePoints([...r.points].reverse().map((p) => ({ ...p, kind: swapKind(p.kind) }))),
    options: r.options?.map(reverseOption),
  };
}

/**
 * GPX の経路の点の間隔の下限 (m)。前に残した点からこれより近い点は落とす（最後の点は残す）。
 * 1秒ごとのログの GPX（数万点）でも、当てはめ・地図の線・グラフ・道迷いの判定・保存が重くならないように
 */
const GPX_MIN_STEP_M = 5;
function thinPoints<T extends { lng: number; lat: number }>(pts: T[], minM: number): T[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    if (distance([a.lng, a.lat], [pts[i].lng, pts[i].lat]) >= minM) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** GPX からルートを作る。地点（wpt）は経路に近いものだけ経由地として使う */
export async function buildGpxRoute(gpx: GpxData, elevation: ElevationFn): Promise<ActiveRoute> {
  const pts = thinPoints(gpx.lines.flatMap((l) => l.points), GPX_MIN_STEP_M);
  if (pts.length < 2) throw new Error('GPXに経路（trk/rte）がありません');
  const hasEle = pts.every((p) => p.ele != null);
  const raw = pts.map((p): LngLat => [p.lng, p.lat]);
  // 標高がないGPX（計画ルートなど）は点を補って、標高タイルから細かく標高を取る
  const coords = hasEle ? raw : densify(raw, 50);
  const dists = cumulativeDistances(coords);
  const eles = hasEle ? pts.map((p) => p.ele!) : await withElevations(coords, elevation);
  const total = dists[dists.length - 1];
  const marks: Mark[] = [];
  for (const w of gpx.waypoints) {
    const pos = projectOnRoute(coords, dists, [w.lng, w.lat]);
    if (!pos || pos.offset > 300) continue;
    const kind: MarkKind = pos.along < 50 ? 'start' : pos.along > total - 50 ? 'dest' : 'via';
    marks.push({ id: newId(), kind, name: w.name ?? '地点', lngLat: [w.lng, w.lat], along: pos.along });
  }
  if (!marks.some((m) => m.kind === 'start')) marks.push({ ...makePoint('start', coords[0], 'スタート'), along: 0 });
  if (!marks.some((m) => m.kind === 'dest')) marks.push({ ...makePoint('dest', coords[coords.length - 1], 'ゴール'), along: total });
  marks.sort((a, b) => a.along - b.along);
  return {
    name: gpx.name ?? 'ルート',
    label: 'GPX',
    kind: 'gpx',
    source: 'gpx',
    coords,
    eles,
    dists,
    marks,
    byKind: zeroKinds(),
    straightLegs: 0,
  };
}

/** GPXルート上に地点を置く（経路に投影）。経路から maxOffset m 以上離れていたら null */
export function placeOnRoute(route: ActiveRoute, point: PlanPoint, maxOffset = 250): ActiveRoute | null {
  const pos = projectOnRoute(route.coords, route.dists, point.lngLat);
  if (!pos || pos.offset > maxOffset) return null;
  let marks = route.marks;
  if (point.kind !== 'via') marks = marks.filter((m) => m.kind !== point.kind);
  marks = [...marks, { ...point, along: pos.along }].sort((a, b) => a.along - b.along);
  return { ...route, marks };
}

/** 今より前の出発時刻をこれ以上さかのぼったら、翌日の出発とみなす */
const PAST_DEPARTURE_MS = 6 * 3_600_000;

/** 出発の日時の書き方：日付を選んだとき "YYYY-MM-DDTHH:MM"、時刻だけのとき "HH:MM"（端末の時刻で） */
export const DEPART_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
export const DEPART_TIME = /^(\d{2}):(\d{2})$/;

/**
 * 出発の日時 (ms)。日付を選んでいればその日のその時刻。
 * 時刻 "HH:MM" だけなら now の日のその時刻にし、今より6時間以上前の時刻は翌日とみなす（夜に翌朝の出発時刻を入れたとき）
 */
export function departureAt(departAt: string, now: number): number {
  const full = DEPART_DATE_TIME.exec(departAt);
  if (full) {
    const [y, mo, day, hh, mm] = full.slice(1).map(Number);
    return new Date(y, mo - 1, day, hh, mm).getTime();
  }
  const [hh, mm] = departAt.split(':').map(Number);
  const d = new Date(now);
  d.setHours(hh, mm, 0, 0);
  if (d.getTime() < now - PAST_DEPARTURE_MS) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 行程に使う区間：出発地〜目的地 */
export function routeSpan(route: RouteOption): { from: number; to: number } {
  const start = route.marks.find((m) => m.kind === 'start');
  const dest = route.marks.find((m) => m.kind === 'dest');
  return { from: start?.along ?? 0, to: dest?.along ?? route.dists[route.dists.length - 1] };
}

/** 登山道（徒歩道）を通る割合 0〜1。GPX など不明なら null */
export function trailShare(o: RouteOption): number | null {
  const total = WAY_KINDS.reduce((s, k) => s + o.byKind[k], 0);
  return total > 0 ? o.byKind.trail / total : null;
}

// ---------- 保存 ----------
const KEY = 'yama-map:route';

export function saveRoute(route: ActiveRoute | null): void {
  try {
    if (route) localStorage.setItem(KEY, JSON.stringify(route));
    else localStorage.removeItem(KEY);
  } catch {
    // 容量不足なら候補を省いて保存を試みる
    try {
      if (route) localStorage.setItem(KEY, JSON.stringify({ ...route, options: undefined, chosen: undefined }));
    } catch {
      /* あきらめる（再読み込みで消えるだけ） */
    }
  }
}

export function loadSavedRoute(): ActiveRoute | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null') as ActiveRoute | null;
    // 旧形式（kind/byKind なし）は読み込まない
    return r && Array.isArray(r.coords) && r.coords.length > 1 && r.byKind ? r : null;
  } catch {
    return null;
  }
}
