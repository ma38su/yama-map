/**
 * 国土地理院の地名検索 API（https://msearch.gsi.go.jp/address-search/AddressSearch?q=…）。
 * 住所と、電子国土基本図の地名（山・沢・温泉など）を返す。API キー不要
 */
import { distance, type LngLat } from '../geo';

export interface Place {
  name: string;
  lngLat: LngLat;
  /** 住所（「茨城県下妻市鬼怒」など）か、地図に載っている地名か */
  kind: 'address' | 'place';
  /** 基準の地点（地図の中心）からの距離 (m) */
  dist: number;
}

const ENDPOINT = 'https://msearch.gsi.go.jp/address-search/AddressSearch';

interface GsiFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: { title?: string; dataSource?: string };
}

/** API の答えを、近い順の地点にする。地名を住所より前に、同じ名前で近すぎるものは1つにまとめる */
export function parsePlaces(json: unknown, near: LngLat, limit = 30): Place[] {
  if (!Array.isArray(json)) return [];
  const out: Place[] = [];
  for (const f of json as GsiFeature[]) {
    const c = f.geometry?.coordinates;
    const name = f.properties?.title?.trim();
    if (!c || !name || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const lngLat: LngLat = [c[0], c[1]];
    const p: Place = { name, lngLat, kind: f.properties?.dataSource ? 'place' : 'address', dist: distance(near, lngLat) };
    if (out.some((q) => q.name === p.name && distance(q.lngLat, p.lngLat) < 300)) continue;
    out.push(p);
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.dist - b.dist : a.kind === 'place' ? -1 : 1)).slice(0, limit);
}

export async function searchPlaces(q: string, near: LngLat, signal?: AbortSignal): Promise<Place[]> {
  const res = await fetch(`${ENDPOINT}?q=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) throw new Error(`地名を検索できませんでした（${res.status}）`);
  return parsePlaces(await res.json(), near);
}
