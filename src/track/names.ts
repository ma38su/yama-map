/**
 * 記録の名前：一覧・リプレイに出す経路名「女夫渕 → 手白澤温泉」と日時「2026/11/15(日) 7:20〜9:05」。
 * 経路名は、記録を始めたときのルートの名前か、出発地・到着地の近くの名前のある場所（山小屋・温泉など）から付ける。DOM には触れない
 */
import { distance, type LngLat } from '../geo';
import type { Track } from './db';
import { trackTimes } from './trim';

/** 名前のある場所（山小屋・温泉・自分で読み込んだ場所など） */
export interface NamedPlace {
  lngLat: LngLat;
  title: string;
}

/** 出発地・到着地からこの距離の中にある場所の名前を使う */
export const NAME_RADIUS_M = 300;

/** 名前を付けずに置いた地点の名前（経路名にしても分からないもの） */
const GENERIC = new Set(['出発地', '目的地', '経由地', '地点', 'ルート']);

/** ルートの名前のうち、経路名にできるもの（「出発地 → 目的地」のように、どこか分からない名前は null） */
export function routeNameOf(name: string | null | undefined): string | null {
  const parts = name?.split(' → ').map((s) => s.trim()) ?? [];
  if (!name?.trim() || parts.every((s) => !s || GENERIC.has(s))) return null;
  return name.trim();
}

/** 一覧・リプレイに出す名前：経路名、なければ記録の名前（「2026/11/15 07:20 の記録」・読み込んだ GPX の名前） */
export const trackTitle = (t: Track): string => t.route || t.name;

/** GPX などに書く名前：経路名があれば「経路名（記録の名前）」 */
export const trackFullName = (t: Track): string => (t.route ? `${t.route}（${t.name}）` : t.name);

const WEEK = '日月火水木金土';
const day = (d: Date, year: boolean) => `${year ? `${d.getFullYear()}/` : ''}${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`;
const clock = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

/** 記録の日時「2026/11/15(日) 7:20〜9:05」（記録の範囲の始めと終わり。日をまたげば終わりにも日付。記録中は「7:20〜」） */
export function trackWhen(t: Track): string {
  const times = trackTimes(t);
  const a = new Date(times.start);
  const head = `${day(a, true)} ${clock(a)}〜`;
  if (t.status === 'recording') return head;
  const b = new Date(times.end);
  const sameDay = a.toDateString() === b.toDateString();
  return `${head}${sameDay ? '' : `${day(b, false)} `}${clock(b)}`;
}

/** at から radius の中で一番近い場所の名前 */
export function nearestName(at: LngLat, places: NamedPlace[], radius = NAME_RADIUS_M): string | null {
  let best: string | null = null;
  let bestD = radius;
  for (const p of places) {
    const d = distance(at, p.lngLat);
    if (d <= bestD && p.title.trim()) {
      best = p.title.trim();
      bestD = d;
    }
  }
  return best;
}

/**
 * 出発地・到着地の近くの場所の名前から経路名を付ける：「女夫渕 → 手白澤温泉」。
 * 出発地に戻ってきた（往復・周回）ときは、出発地から一番遠いところの名前もはさむ（「女夫渕 → 手白澤温泉 → 女夫渕」）。
 * 片方しか分からなければ「女夫渕から」「手白澤温泉まで」。どちらも分からなければ null
 */
export function guessRouteName(coords: LngLat[], places: NamedPlace[], radius = NAME_RADIUS_M): string | null {
  if (!coords.length) return null;
  const start = coords[0];
  const end = coords[coords.length - 1];
  const a = nearestName(start, places, radius);
  const b = nearestName(end, places, radius);
  if (a && b && a !== b) return `${a} → ${b}`;
  if (a && (a === b || distance(start, end) <= radius)) {
    let far = start;
    let farD = 0;
    for (const c of coords) {
      const d = distance(start, c);
      if (d > farD) [far, farD] = [c, d];
    }
    const mid = farD > radius * 2 ? nearestName(far, places, radius) : null;
    return mid && mid !== a ? `${a} → ${mid} → ${a}` : `${a} 周回`;
  }
  if (a) return `${a}から`;
  if (b) return `${b}まで`;
  return null;
}
