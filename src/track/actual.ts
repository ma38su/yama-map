/**
 * 記録の実績：出発・途中の地点・休憩・到着を時刻順に並べ、地点のあいだの距離・登り下り・所要時間を出す。
 * 保存した記録を開いたときの「行程」に使う。
 */
import { GainCounter, distance, type LngLat } from '../geo';
import { splitMoving, type Moving } from '../nav/eta';
import type { Mark } from '../nav/plan';
import type { TrackPoint } from './db';

export interface ActualLeg {
  dist: number;
  up: number;
  down: number;
  /** 所要時間 (ms)。途中の休憩を含む */
  ms: number;
  /** そのうちの休憩 (ms) */
  restMs: number;
}

export interface ActualRow {
  kind: 'start' | 'via' | 'dest' | 'rest';
  name: string;
  /** 着いた（休憩なら休み始めた）時刻 (ms) */
  t: number;
  /** 休憩の長さ (ms) */
  restMs?: number;
  /** 記録の点の番号 */
  index: number;
  /** 前の地点（休憩は除く）からの区間 */
  leg: ActualLeg | null;
}

/** 地点を通ったとみなす距離 (m) */
const PASS_M = 80;
/** 出発地・目的地とみなす距離 (m) */
const END_M = 300;
/** 行程に出す休憩の長さ (ms) */
const MIN_REST_MS = 3 * 60_000;

/** moving は splitMoving(points) の結果（求めてあれば渡す。累積距離もそれを使う） */
export function actualRows(points: TrackPoint[], marks: Mark[] = [], moving: Moving = splitMoving(points)): ActualRow[] {
  if (points.length < 2) return [];
  const coords = points.map((p): LngLat => [p.lng, p.lat]);
  const { cumD: dists, rests } = moving;
  const last = points.length - 1;
  const near = (i: number, m: Mark, r: number) => distance(coords[i], m.lngLat) < r;
  const startMark = marks.find((m) => m.kind === 'start');
  const destMark = marks.filter((m) => m.kind === 'dest').at(-1);

  // 途中の地点は、ルートの順に、前の地点より後で最初に近くを通った点
  const stops: Omit<ActualRow, 't' | 'leg'>[] = [
    { kind: 'start', name: startMark && near(0, startMark, END_M) ? startMark.name : '出発地', index: 0 },
  ];
  let from = 1;
  for (const m of marks) {
    if (m.kind === 'start' || m.kind === 'dest') continue;
    for (let i = from; i < last; i++) {
      if (near(i, m, PASS_M)) {
        stops.push({ kind: 'via', name: m.name, index: i });
        from = i + 1;
        break;
      }
    }
  }
  stops.push({ kind: 'dest', name: destMark && near(last, destMark, END_M) ? destMark.name : '到着地', index: last });

  const rows: ActualRow[] = [];
  // 休憩も区間も時刻の順なので、休憩は前から順に1回ずつ見る（ri は、前の区間までに終わった休憩を飛ばした位置）
  let ri = 0;
  for (let k = 0; k < stops.length; k++) {
    const s = stops[k];
    let leg: ActualLeg | null = null;
    if (k > 0) {
      const a = stops[k - 1].index;
      const gain = new GainCounter();
      for (let i = a; i <= s.index; i++) gain.push(points[i].ele);
      const t0 = points[a].t;
      const t1 = points[s.index].t;
      while (ri < rests.length && rests[ri].t1 <= t0) ri++;
      let restMs = 0;
      let index = a;
      for (let j = ri; j < rests.length && rests[j].t0 < t1; j++) {
        const r = rests[j];
        restMs += Math.max(0, Math.min(r.t1, t1) - Math.max(r.t0, t0));
        // 区間の途中の休憩（区間に収まっているもの）を行程に出す
        if (r.t1 - r.t0 < MIN_REST_MS || r.t0 < t0 || r.t1 > t1) continue;
        while (index < s.index && points[index + 1].t <= r.t0) index++;
        rows.push({ kind: 'rest', name: '休憩', t: r.t0, restMs: r.t1 - r.t0, index, leg: null });
      }
      leg = { dist: dists[s.index] - dists[a], up: gain.ascent, down: gain.descent, ms: t1 - t0, restMs };
    }
    rows.push({ ...s, t: points[s.index].t, leg });
  }
  return rows;
}
