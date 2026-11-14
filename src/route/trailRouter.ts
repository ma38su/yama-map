/**
 * 道・登山道のネットワーク上で最短経路を求める。
 *
 * 入力は線（座標列）の集まり。国土地理院ベクトルタイルの道路中心線（徒歩道を含む）を想定。
 * タイル境界で切れた線や、交点で切れていない線をつなぐため、
 *  - 近い頂点（tol 以内）は同じノードにまとめる
 *  - 行き止まりの端点が別の線の途中に近ければ（snapTol 以内）接続する
 */
import type { LngLat } from '../geo';

export interface RouteLine {
  coords: LngLat[];
  /** 徒歩道なら true。コストに差をつけたいとき用 */
  trail?: boolean;
}

interface Edge {
  to: number;
  w: number;
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

export class TrailGraph {
  readonly nodes: LngLat[] = [];
  private readonly xy: [number, number][] = [];
  private readonly adj: Edge[][] = [];
  /** 線分（ノード番号の組）。端点スナップ・始終点の吸着に使う */
  private readonly segs: [number, number][] = [];
  private readonly cell: number;
  private readonly nodeGrid = new Map<string, number[]>();
  private readonly segGrid = new Map<string, number[]>();
  private readonly proj: LocalProjection;

  constructor(
    lines: RouteLine[],
    private readonly tol = 1.5,
    snapTol = 4,
    /** 車道のコスト倍率（1 より大きいと徒歩道を優先） */
    roadPenalty = 1.05,
  ) {
    const lat0 = lines.find((l) => l.coords.length)?.coords[0][1] ?? 35;
    this.proj = new LocalProjection(lat0);
    this.cell = Math.max(tol, snapTol, 10);
    for (const line of lines) {
      let prev = -1;
      for (const c of line.coords) {
        const n = this.nodeAt(c);
        if (prev >= 0 && prev !== n) this.addSeg(prev, n, line.trail ? 1 : roadPenalty);
        prev = n;
      }
    }
    this.snapDanglingEnds(snapTol);
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

  private addEdge(a: number, b: number, w: number) {
    this.adj[a].push({ to: b, w });
    this.adj[b].push({ to: a, w });
  }

  private addSeg(a: number, b: number, factor: number) {
    const [ax, ay] = this.xy[a];
    const [bx, by] = this.xy[b];
    this.addEdge(a, b, Math.hypot(bx - ax, by - ay) * factor);
    const id = this.segs.length;
    this.segs.push([a, b]);
    // 線分が通るセルに登録（端点の範囲の矩形）
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

  /** 点から最も近い線分（radius m 以内）。投影点の情報を返す */
  private nearestSeg(
    x: number,
    y: number,
    radius: number,
    exclude?: number,
  ): { seg: number; t: number; d: number } | null {
    let best: { seg: number; t: number; d: number } | null = null;
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const seen = new Set<number>();
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (const s of this.segGrid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (seen.has(s)) continue;
          seen.add(s);
          const [a, b] = this.segs[s];
          if (a === exclude || b === exclude) continue;
          const { t, d } = projectToSegment(x, y, this.xy[a], this.xy[b]);
          if (d <= radius && (!best || d < best.d)) best = { seg: s, t, d };
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
      // つながっている相手の線分は除外（自分の線の続き）
      const [a, b] = this.segs[hit.seg];
      if (this.adj[n].some((e) => e.to === a || e.to === b)) continue;
      const [ax, ay] = this.xy[a];
      const [bx, by] = this.xy[b];
      this.addEdge(n, a, hit.d + hit.t * Math.hypot(bx - ax, by - ay));
      this.addEdge(n, b, hit.d + (1 - hit.t) * Math.hypot(bx - ax, by - ay));
    }
  }

  /** 線分の数（テスト・デバッグ用） */
  get segmentCount(): number {
    return this.segs.length;
  }

  /**
   * from → to の最短経路。始点・終点はネットワーク上の最寄りの点に吸着する（maxSnap m 以内）。
   * 見つからなければ null。
   */
  route(from: LngLat, to: LngLat, maxSnap = 500): RouteResult | null {
    const s = this.attach(from, maxSnap);
    const g = this.attach(to, maxSnap);
    if (!s || !g) return null;

    // 同じ線分上なら直接
    if (s.seg === g.seg) {
      return { coords: [from, s.point, g.point, to], length: Math.abs(s.along - g.along), snapFrom: s.d, snapTo: g.d };
    }

    const N = this.nodes.length;
    const dist = new Float64Array(N + 2).fill(Infinity);
    const prev = new Int32Array(N + 2).fill(-1);
    const START = N;
    const GOAL = N + 1;
    const heap = new MinHeap();
    const [sa, sb] = this.segs[s.seg];
    const [ga, gb] = this.segs[g.seg];
    const segLen = (seg: number) => {
      const [a, b] = this.segs[seg];
      return Math.hypot(this.xy[b][0] - this.xy[a][0], this.xy[b][1] - this.xy[a][1]);
    };
    const sLen = segLen(s.seg);
    const gLen = segLen(g.seg);
    dist[START] = 0;
    const relax = (n: number, d: number, p: number) => {
      if (d < dist[n]) {
        dist[n] = d;
        prev[n] = p;
        heap.push(n, d);
      }
    };
    relax(sa, s.t * sLen, START);
    relax(sb, (1 - s.t) * sLen, START);
    while (heap.size) {
      const [u, du] = heap.pop()!;
      if (du > dist[u]) continue;
      if (u === GOAL) break;
      if (u === ga) relax(GOAL, du + g.t * gLen, u);
      if (u === gb) relax(GOAL, du + (1 - g.t) * gLen, u);
      for (const e of this.adj[u]) relax(e.to, du + e.w, u);
    }
    if (!Number.isFinite(dist[GOAL])) return null;
    const path: LngLat[] = [];
    for (let n = prev[GOAL]; n !== START && n >= 0; n = prev[n]) path.push(this.nodes[n]);
    path.reverse();
    return {
      coords: [from, s.point, ...path, g.point, to],
      length: dist[GOAL],
      snapFrom: s.d,
      snapTo: g.d,
    };
  }

  private attach(p: LngLat, maxSnap: number) {
    const [x, y] = this.proj.xy(p);
    const hit = this.nearestSeg(x, y, maxSnap);
    if (!hit) return null;
    const [a, b] = this.segs[hit.seg];
    const A = this.nodes[a];
    const B = this.nodes[b];
    const point: LngLat = [A[0] + (B[0] - A[0]) * hit.t, A[1] + (B[1] - A[1]) * hit.t];
    const len = Math.hypot(this.xy[b][0] - this.xy[a][0], this.xy[b][1] - this.xy[a][1]);
    return { seg: hit.seg, t: hit.t, d: hit.d, point, along: hit.t * len };
  }
}

export interface RouteResult {
  coords: LngLat[];
  /** 経路長 (m, コスト倍率込み) */
  length: number;
  /** 始点・終点からネットワークまでの距離 (m) */
  snapFrom: number;
  snapTo: number;
}

function projectToSegment(
  x: number,
  y: number,
  a: [number, number],
  b: [number, number],
): { t: number; d: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2));
  return { t, d: Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y) };
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
