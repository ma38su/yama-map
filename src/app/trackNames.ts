/**
 * 記録の経路名とロック：記録を終えたときの経路名（ルートの名前、なければ出発地・到着地の近くの山小屋・温泉などの名前）、
 * 経路名のない前の版の記録への名付け、一覧での経路名の変更・ロックの切り替え（保存して、開いている記録にも入れる）
 */
import type { LngLat } from '../geo';
import { placeCellKey, type PlaceItem } from '../places/sources';
import { placeLabelsNear } from '../route/roadTiles';
import { getPlaceCells, getPoints, placeKey, updateTrack, type Track, type TrackPoint } from '../track/db';
import { NAME_RADIUS_M, guessRouteName, routeNameOf, type NamedPlace } from '../track/names';
import { pointsIn } from '../track/trim';
import { importedItems } from './places';
import { recorder } from './recording';
import { state } from './state';

/** 経路名に使う場所の種類（名前の付いていることが多いもの） */
const NAME_CATS = new Set<PlaceItem['cat']>(['hut', 'inn', 'onsen', 'camp', 'view', 'peak', 'fall', 'bus', 'mine']);

/** OpenStreetMap の場所は名前があるときだけ（名前がなければ title は「山小屋」などの種類） */
const named = (it: PlaceItem) => NAME_CATS.has(it.cat) && (it.source !== 'osm' || it.subtitle != null);

/** 地図の地名のうち、経路名にしないもの（川・沢・谷の名前） */
const WATER_RE = /(川|沢|谷)$/;

/**
 * coords の近く（NAME_RADIUS_M）の名前のある場所：地理院の地図の地名（地図を保存してあれば圏外でも読める）と、
 * 端末に残してある場所の情報（山小屋・温泉など）・自分で読み込んだ場所
 */
async function namedPlacesNear(coords: LngLat[]): Promise<NamedPlace[]> {
  const pad = (NAME_RADIUS_M / 111_000) * 1.5;
  const cells = new Set<string>();
  for (const [lng, lat] of coords) for (const dx of [-pad, 0, pad]) for (const dy of [-pad, 0, pad]) cells.add(placeCellKey([lng + dx, lat + dy]));
  const [labels, got] = await Promise.all([
    placeLabelsNear(coords, NAME_RADIUS_M).catch(() => []),
    getPlaceCells([...cells].map((c) => placeKey('osm', c))).catch(() => []),
  ]);
  return [
    ...labels.filter((l) => !WATER_RE.test(l.text)).map((l) => ({ lngLat: l.lngLat, title: l.text })),
    ...[...got.flatMap((c) => c?.items ?? []), ...importedItems()].filter(named).map((it) => ({ lngLat: it.lngLat, title: it.title })),
  ];
}

/** 記録の範囲の点から、近くの場所の名前で経路名を付ける（付けられなければ null） */
export async function guessTrackRoute(track: Track, all: TrackPoint[]): Promise<string | null> {
  const coords = pointsIn(all, track.trim).map((p): LngLat => [p.lng, p.lat]);
  if (coords.length < 2) return null;
  // 出発地・到着地・一番遠いところの近くの場所だけ読む
  const start = coords[0];
  let far = start;
  let farD = 0;
  for (const c of coords) {
    const d = (c[0] - start[0]) ** 2 + (c[1] - start[1]) ** 2;
    if (d > farD) [far, farD] = [c, d];
  }
  return guessRouteName(coords, await namedPlacesNear([start, coords[coords.length - 1], far]));
}

/** 経路名・ロックを保存して、開いている記録・記録の仕組みが持っている記録にも入れる。保存した記録を返す */
export async function relabelTrack(id: string, patch: Partial<Pick<Track, 'route' | 'locked'>>): Promise<Track | null> {
  const updated = await updateTrack(id, patch);
  if (!updated) return null;
  recorder.relabel(id, patch);
  if (state.shown?.track.id === id) state.shown = { ...state.shown, track: { ...state.shown.track, ...patch } };
  return updated;
}

/** 記録を終えたとき、経路名がなければ付ける：今のルートの名前、なければ近くの場所の名前 */
export async function nameFinishedTrack(track: Track, all: TrackPoint[]): Promise<Track | null> {
  if (track.route != null) return null;
  const route = routeNameOf(state.route?.name) ?? (await guessTrackRoute(track, all));
  return route ? relabelTrack(track.id, { route }) : null;
}

/** この起動で名付けを試した記録（場所の情報がなくて付けられなかったものを、何度も読み直さないように） */
const tried = new Set<string>();

/**
 * 経路名のない記録（前の版の記録・読み込んだ記録）に、近くの場所の名前で経路名を付けて保存する。
 * 付けた記録があれば true（一覧を描き直す）
 */
export async function nameUnnamedTracks(tracks: Track[]): Promise<boolean> {
  let any = false;
  for (const t of tracks) {
    if (t.route != null || t.status !== 'done' || t.id.startsWith('plan-') || tried.has(t.id)) continue;
    tried.add(t.id);
    const route = await guessTrackRoute(t, await getPoints(t.id)).catch(() => null);
    if (route && (await relabelTrack(t.id, { route }).catch(() => null))) any = true;
  }
  return any;
}
