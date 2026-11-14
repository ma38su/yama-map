/**
 * 行程（ルートと 出発地・経由地・目的地）の管理。
 *  - auto: 地図で選んだ地点の間を、国土地理院の道・徒歩道データでルート検索してつなぐ
 *  - gpx : 読み込んだGPXの経路をそのまま使い、地点は経路上に投影する
 */
import { cumulativeDistances, densify, distance, type LngLat } from '../geo';
import { loadRoadLines } from '../route/roadTiles';
import { TrailGraph } from '../route/trailRouter';
import type { GpxData } from '../track/gpx';
import { projectOnRoute } from './eta';

export type MarkKind = 'start' | 'via' | 'dest';

export interface PlanPoint {
  id: string;
  kind: MarkKind;
  name: string;
  lngLat: LngLat;
}

export interface Mark extends PlanPoint {
  /** 経路の始点からの距離 (m) */
  along: number;
}

export interface ActiveRoute {
  name: string;
  source: 'auto' | 'gpx';
  coords: LngLat[];
  eles: (number | null)[];
  dists: number[];
  /** along の昇順 */
  marks: Mark[];
  /** auto: ルート検索に使った地点（出発地, 経由地..., 目的地） */
  points?: PlanPoint[];
  /** 道が見つからず直線で結んだ区間の数 */
  straightLegs: number;
}

export type ElevationFn = (lng: number, lat: number) => Promise<number | null>;

const newId = () => Math.random().toString(36).slice(2, 10);
export const makePoint = (kind: MarkKind, lngLat: LngLat, name?: string): PlanPoint => ({
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
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  let [w, s, e, n] = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
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

/** 地点の間を道・徒歩道沿いにつないだルートを作る */
export async function buildAutoRoute(
  points: PlanPoint[],
  elevation: ElevationFn,
  onProgress?: (msg: string) => void,
): Promise<ActiveRoute> {
  const pts = normalizePoints(points);
  if (pts.length < 2) throw new Error('出発地と目的地が必要です');
  onProgress?.('道のデータを読み込み中…');
  const { lines } = await loadRoadLines(boundsAround(pts.map((p) => p.lngLat)), (d, t) =>
    onProgress?.(`道のデータを読み込み中… ${d}/${t}`),
  );
  onProgress?.('ルートを計算中…');
  const graph = lines.length ? new TrailGraph(lines) : null;
  const coords: LngLat[] = [];
  const legEnds: number[] = [];
  let straightLegs = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1].lngLat;
    const b = pts[i].lngLat;
    const r = graph?.route(a, b, 300);
    let leg: LngLat[];
    if (r && r.snapFrom < 300 && r.snapTo < 300) leg = r.coords;
    else {
      leg = [a, b];
      straightLegs++;
    }
    leg = densify(leg, 50);
    coords.push(...(coords.length ? leg.slice(1) : leg));
    legEnds.push(coords.length - 1);
  }
  const dists = cumulativeDistances(coords);
  onProgress?.('標高を計算中…');
  const eles = await withElevations(coords, elevation);
  const marks: Mark[] = pts.map((p, i) => ({ ...p, along: i === 0 ? 0 : dists[legEnds[i - 1]] }));
  const dest = pts[pts.length - 1];
  return {
    name: `${pts[0].name} → ${dest.name}`,
    source: 'auto',
    coords,
    eles,
    dists,
    marks,
    points: pts,
    straightLegs,
  };
}

/** GPX からルートを作る。地点（wpt）は経路に近いものだけ経由地として使う */
export async function buildGpxRoute(gpx: GpxData, elevation: ElevationFn): Promise<ActiveRoute> {
  const pts = gpx.lines.flatMap((l) => l.points);
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
  if (!marks.some((m) => m.kind === 'dest'))
    marks.push({ ...makePoint('dest', coords[coords.length - 1], 'ゴール'), along: total });
  marks.sort((a, b) => a.along - b.along);
  return { name: gpx.name ?? 'ルート', source: 'gpx', coords, eles, dists, marks, straightLegs: 0 };
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

/** 行程に使う区間：出発地〜目的地 */
export function routeSpan(route: ActiveRoute): { from: number; to: number } {
  const start = route.marks.find((m) => m.kind === 'start');
  const dest = route.marks.find((m) => m.kind === 'dest');
  return { from: start?.along ?? 0, to: dest?.along ?? route.dists[route.dists.length - 1] };
}

// ---------- 保存 ----------
const KEY = 'yama-map:route';

export function saveRoute(route: ActiveRoute | null): void {
  try {
    if (route) localStorage.setItem(KEY, JSON.stringify(route));
    else localStorage.removeItem(KEY);
  } catch {
    /* 容量不足などは無視（再読み込みで消えるだけ） */
  }
}

export function loadSavedRoute(): ActiveRoute | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null') as ActiveRoute | null;
    return r && Array.isArray(r.coords) && r.coords.length > 1 ? r : null;
  } catch {
    return null;
  }
}
