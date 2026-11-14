/**
 * 道・登山道のネットワーク上で経路を求める。
 *
 * 入力は線（座標列）と道の種類。国土地理院ベクトルタイルの道路中心線（徒歩道を含む）や
 * OpenStreetMap の道を想定。タイル境界で切れた線や、交点で切れていない線をつなぐため、
 *  - 近い頂点（tol 以内）は同じノードにまとめる
 *  - 行き止まりの端点が別の線の途中に近ければ（snapTol 以内）接続する
 *
 * 道の種類ごとにコスト倍率（プロファイル）を変えて「登山道優先」「最短距離」などを求める。
 * さらに、見つけた経路の道を通りにくくして再検索することで「別ルート」を作る。
 */
import type { LngLat } from '../geo';

/** trail: 登山道・徒歩道 / track: 林道・作業道 / road: 一般の車道 / major: 国道・県道など */
export type WayKind = 'trail' | 'track' | 'road' | 'major';
export const WAY_KINDS: WayKind[] = ['trail', 'track', 'road', 'major'];

export interface RouteLine {
  coords: LngLat[];
  kind: WayKind;
}

export type CostProfile = Record<WayKind, number>;

export const PROFILES = {
  /** 登山道優先：車道はなるべく避ける（登山口までのアプローチなど、必要なら通る） */
  walk: { trail: 1, track: 1.6, road: 2.5, major: 4 },
  /** 最短距離：道の種類を問わない */
  short: { trail: 1, track: 1, road: 1, major: 1.05 },
} satisfies Record<string, CostProfile>;

export interface RouteOptions {
  profile?: CostProfile;
  /** 始点・終点を道に吸着する最大距離 (m) */
  maxSnap?: number;
  /** 辺ごとの追加コスト倍率（別ルート探索用） */
  penalty?: Map<number, number>;
}

export interface RouteResult {
  coords: LngLat[];
  /** 経路の実際の長さ (m) */
  length: number;
  /** コスト（長さ×倍率） */
  cost: number;
  /** 通った辺の番号 */
  edges: number[];
  /** 道の種類ごとの距離 (m) */
  byKind: Record<WayKind, number>;
  /** 始点・終点からネットワークまでの距離 (m) */
  snapFrom: number;
  snapTo: number;
}

/** 狭い範囲用の平面近似（m） */
class LocalProjection {
  private readonly kx: number;
  private readonly ky = 110_574;
  constructor(lat0: number) {
    this.kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  }
  xy(p: LngLat): [number, number] {
    return [p[0] * this.kx, p[1] * this.ky];
  }
}

const zeroKinds = (): Record<WayKind, number> => ({ trail: 0, track: 0, road: 0, major: 0 });

export class TrailGraph {
  readonly nodes: LngLat[] = [];
  private readonly xy: [number, number][] = [];
  /** ノード → 接続する辺の番号 */
  private readonly adj: number[][] = [];
  private readonly eA: number[] = [];
  private readonly eB: number[] = [];
  private readonly eLen: number[] = [];
  private readonly eKind: WayKind[] = [];
  /** 実際の線分（端点スナップでできた接続辺は含まない） */
  private readonly realSegs: number[] = [];
  private readonly cell: number;
  private readonly nodeGrid = new Map<string, number[]>();
  private readonly segGrid = new Map<string, number[]>();
  private readonly proj: LocalProjection;

  constructor(
    lines: RouteLine[],
    private readonly tol = 1.5,
    snapTol = 4,
  ) {
    const lat0 = lines.find((l) => l.coords.length)?.coords[0][1] ?? 35;
    this.proj = new LocalProjection(lat0);
    this.cell = Math.max(tol, snapTol, 10);
    for (const line of lines) {
      let prev = -1;
      for (const c of line.coords) {
        const n = this.nodeAt(c);
        if (prev >= 0 && prev !== n) this.addSeg(prev, n, line.kind);
        prev = n;
      }
    }
    this.snapDanglingEnds(snapTol);
  }

  get edgeCount(): number {
    return this.eA.length;
  }

  private nodeAt(c: LngLat): number {
    const [x, y] = this.proj.xy(c);
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const n of this.nodeGrid.get(`${cx + dx},${cy + dy}`) ?? []) {
          const [nx, ny] = this.xy[n];
          if (Math.hypot(nx - x, ny - y) <= this.tol) return n;
        }
      }
    }
    const id = this.nodes.length;
    this.nodes.push(c);
    this.xy.push([x, y]);
    this.adj.push([]);
    const k = `${cx},${cy}`;
    const bucket = this.nodeGrid.get(k);
    if (bucket) bucket.push(id);
    else this.nodeGrid.set(k, [id]);
    return id;
  }

  private addEdge(a: number, b: number, len: number, kind: WayKind): number {
    const id = this.eA.length;
    this.eA.push(a);
    this.eB.push(b);
    this.eLen.push(len);
    this.eKind.push(kind);
    this.adj[a].push(id);
    this.adj[b].push(id);
    return id;
  }

  private addSeg(a: number, b: number, kind: WayKind) {
    const [ax, ay] = this.xy[a];
    const [bx, by] = this.xy[b];
    const id = this.addEdge(a, b, Math.hypot(bx - ax, by - ay), kind);
    this.realSegs.push(id);
    const x0 = Math.floor(Math.min(ax, bx) / this.cell);
    const x1 = Math.floor(Math.max(ax, bx) / this.cell);
    const y0 = Math.floor(Math.min(ay, by) / this.cell);
    const y1 = Math.floor(Math.max(ay, by) / this.cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        const bucket = this.segGrid.get(k);
        if (bucket) bucket.push(id);
        else this.segGrid.set(k, [id]);
      }
    }
  }

  /** 点から最も近い線分（radius m 以内） */
  private nearestSeg(x: number, y: number, radius: number, exclude?: number): { edge: number; t: number; d: number } | null {
    let best: { edge: number; t: number; d: number } | null = null;
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const seen = new Set<number>();
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (const e of this.segGrid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (seen.has(e)) continue;
          seen.add(e);
          const a = this.eA[e];
          const b = this.eB[e];
          if (a === exclude || b === exclude) continue;
          const { t, d } = projectToSegment(x, y, this.xy[a], this.xy[b]);
          if (d <= radius && (!best || d < best.d)) best = { edge: e, t, d };
        }
      }
    }
    return best;
  }

  private snapDanglingEnds(snapTol: number) {
    const count = this.nodes.length;
    for (let n = 0; n < count; n++) {
      if (this.adj[n].length !== 1) continue;
      const [x, y] = this.xy[n];
      const hit = this.nearestSeg(x, y, snapTol, n);
      if (!hit) continue;
      const a = this.eA[hit.edge];
      const b = this.eB[hit.edge];
      const own = this.adj[n][0];
      if (this.eA[own] === a || this.eB[own] === a || this.eA[own] === b || this.eB[own] === b) continue;
      const len = this.eLen[hit.edge];
      const kind = this.eKind[own];
      this.addEdge(n, a, hit.d + hit.t * len, kind);
      this.addEdge(n, b, hit.d + (1 - hit.t) * len, kind);
    }
  }

  private attach(p: LngLat, maxSnap: number) {
    const [x, y] = this.proj.xy(p);
    const hit = this.nearestSeg(x, y, maxSnap);
    if (!hit) return null;
    const A = this.nodes[this.eA[hit.edge]];
    const B = this.nodes[this.eB[hit.edge]];
    const point: LngLat = [A[0] + (B[0] - A[0]) * hit.t, A[1] + (B[1] - A[1]) * hit.t];
    return { ...hit, point };
  }

  /** from → to の経路。始点・終点はネットワーク上の最寄りの点に吸着する。見つからなければ null */
  route(from: LngLat, to: LngLat, opts: RouteOptions = {}): RouteResult | null {
    const profile = opts.profile ?? PROFILES.walk;
    const maxSnap = opts.maxSnap ?? 500;
    const pen = opts.penalty;
    const s = this.attach(from, maxSnap);
    const g = this.attach(to, maxSnap);
    if (!s || !g) return null;
    const w = (e: number, frac = 1) => this.eLen[e] * frac * profile[this.eKind[e]] * (pen?.get(e) ?? 1);

    if (s.edge === g.edge) {
      const frac = Math.abs(s.t - g.t);
      const byKind = zeroKinds();
      byKind[this.eKind[s.edge]] = this.eLen[s.edge] * frac;
      return {
        coords: [from, s.point, g.point, to],
        length: this.eLen[s.edge] * frac,
        cost: w(s.edge, frac),
        edges: [s.edge],
        byKind,
        snapFrom: s.d,
        snapTo: g.d,
      };
    }

    const N = this.nodes.length;
    const START = N;
    const GOAL = N + 1;
    const dist = new Float64Array(N + 2).fill(Infinity);
    const prevNode = new Int32Array(N + 2).fill(-1);
    const prevEdge = new Int32Array(N + 2).fill(-1);
    const heap = new MinHeap();
    const relax = (n: number, d: number, p: number, e: number) => {
      if (d < dist[n]) {
        dist[n] = d;
        prevNode[n] = p;
        prevEdge[n] = e;
        heap.push(n, d);
      }
    };
    dist[START] = 0;
    const sa = this.eA[s.edge];
    const sb = this.eB[s.edge];
    const ga = this.eA[g.edge];
    const gb = this.eB[g.edge];
    relax(sa, w(s.edge, s.t), START, s.edge);
    relax(sb, w(s.edge, 1 - s.t), START, s.edge);
    while (heap.size) {
      const [u, du] = heap.pop()!;
      if (du > dist[u]) continue;
      if (u === GOAL) break;
      if (u === ga) relax(GOAL, du + w(g.edge, g.t), u, g.edge);
      if (u === gb) relax(GOAL, du + w(g.edge, 1 - g.t), u, g.edge);
      for (const e of this.adj[u]) {
        const v = this.eA[e] === u ? this.eB[e] : this.eA[e];
        relax(v, du + w(e), u, e);
      }
    }
    if (!Number.isFinite(dist[GOAL])) return null;

    const path: LngLat[] = [];
    const edges: number[] = [];
    const byKind = zeroKinds();
    let length = 0;
    for (let n = GOAL; n !== START && n >= 0; n = prevNode[n]) {
      const e = prevEdge[n];
      const p = prevNode[n];
      let frac = 1;
      if (n === GOAL) frac = p === ga ? g.t : 1 - g.t;
      else if (p === START) frac = n === sa ? s.t : 1 - s.t;
      edges.push(e);
      byKind[this.eKind[e]] += this.eLen[e] * frac;
      length += this.eLen[e] * frac;
      if (n !== GOAL) path.push(this.nodes[n]);
    }
    path.reverse();
    edges.reverse();
    return {
      coords: [from, s.point, ...path, g.point, to],
      length,
      cost: dist[GOAL],
      edges,
      byKind,
      snapFrom: s.d,
      snapTo: g.d,
    };
  }
}

function projectToSegment(x: number, y: number, a: [number, number], b: [number, number]): { t: number; d: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2));
  return { t, d: Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y) };
}

/**
 * 経路 a のうち、経路 b から tol m 以内を通っている割合（0〜1）。
 * 候補ルートがほとんど同じかどうかの判定に使う。
 */
export function overlapRatio(a: LngLat[], b: LngLat[], tol = 15, step = 25): number {
  if (a.length < 2 || b.length < 2) return 0;
  const proj = new LocalProjection(a[0][1]);
  const A = a.map((p) => proj.xy(p));
  const B = b.map((p) => proj.xy(p));
  const cell = Math.max(tol, 50);
  const grid = new Map<string, number[]>();
  for (let i = 1; i < B.length; i++) {
    const [ax, ay] = B[i - 1];
    const [bx, by] = B[i];
    for (let x = Math.floor((Math.min(ax, bx) - tol) / cell); x <= Math.floor((Math.max(ax, bx) + tol) / cell); x++) {
      for (let y = Math.floor((Math.min(ay, by) - tol) / cell); y <= Math.floor((Math.max(ay, by) + tol) / cell); y++) {
        const k = `${x},${y}`;
        const bucket = grid.get(k);
        if (bucket) bucket.push(i);
        else grid.set(k, [i]);
      }
    }
  }
  const near = (x: number, y: number) => {
    for (const i of grid.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`) ?? []) {
      if (projectToSegment(x, y, B[i - 1], B[i]).d <= tol) return true;
    }
    return false;
  };
  let total = 0;
  let shared = 0;
  for (let i = 1; i < A.length; i++) {
    const [ax, ay] = A[i - 1];
    const [bx, by] = A[i];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      const piece = len / n;
      total += piece;
      if (near(ax + (bx - ax) * f, ay + (by - ay) * f)) shared += piece;
    }
  }
  return total > 0 ? shared / total : 0;
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): [number, number] | undefined {
    const ids = this.ids;
    const keys = this.keys;
    if (!ids.length) return undefined;
    const top: [number, number] = [ids[0], keys[0]];
    const id = ids.pop()!;
    const key = keys.pop()!;
    if (ids.length) {
      let i = 0;
      const n = ids.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= key) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }
}
