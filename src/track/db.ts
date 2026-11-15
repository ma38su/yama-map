/**
 * 記録した軌跡の保存先 (IndexedDB)。
 * 点は1つずつ追記するので、ブラウザが落ちても直前までの記録が残る。
 * 地図に重ねる場所の情報（マス目ごと）と、オフライン用に保存した範囲もここに置く。
 * 版を上げるときは、ストアを足すだけにする（アプリを更新しても記録が消えないように）
 */
import type { PlaceItem, PlaceSource } from '../places/sources';
import type { TrimRange } from './trim';
import type { TrackWeather } from './weatherLog';

export interface TrackPoint {
  trackId: string;
  /** 時刻 (ms) */
  t: number;
  lng: number;
  lat: number;
  /** GPSの高度 (m)。取れない端末も多い */
  alt: number | null;
  /** 水平精度 (m) */
  acc: number;
  /** 標高 (m)。標高タイルから求める（気圧計がある端末では、気圧の変化で補ったもの） */
  ele: number | null;
  /** 気圧 (hPa)。気圧計がある端末（アプリ版）だけ */
  hpa?: number | null;
  /** 標高タイルから求めた標高 (m)。気圧で補ったときに、元の値を残しておく（記録の再開で補い直すため） */
  dem?: number | null;
  /** 記録を始めてからの歩数。アプリ版で歩数計があるときだけ（区間の歩数は差で出す） */
  steps?: number;
}

/** 記録に残した写真 */
export interface TrackPhoto {
  id: string;
  trackId: string;
  /** 撮った時刻 (ms) */
  t: number;
  lng: number;
  lat: number;
  /** 場所の決め方：写真の位置情報 / 撮った時刻と軌跡 / 撮ったときの現在地 */
  located: 'gps' | 'time' | 'here';
  /** 長いほうの辺を1600pxまでに縮めた JPEG */
  image: Blob;
  /** 地図に出す小さな正方形の JPEG */
  thumb: Blob;
}

export interface Track {
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  status: 'recording' | 'done';
  /** 距離・登り・下り（記録の範囲 trim があれば、その中の点で数えたもの） */
  distance: number;
  ascent: number;
  descent: number;
  /** 点の数（範囲の外も含めた全部） */
  pointCount: number;
  /** 歩数（記録の範囲 trim があれば、その中の点で数えたもの）。歩数計がなければない */
  steps?: number;
  /** 記録の範囲（記録の上の開始・終了の時刻）。点は消さずに、出発前・到着後に止まっていた時間を除く（./trim.ts） */
  trim?: TrimRange;
  /**
   * 経路名「女夫渕 → 手白澤温泉」。記録を始めたときのルートの名前か、出発地・到着地の近くの場所の名前（./names.ts）。
   * 自分で変えられる。空の文字列は「経路名なし」（場所の名前から付け直さない）
   */
  route?: string;
  /** ロック（削除できない） */
  locked?: boolean;
}

/** 場所の情報：1つのマス目・1つの出どころの分 */
export interface PlaceCell {
  /** `${source}|${cell}` */
  key: string;
  source: PlaceSource;
  cell: string;
  /** 取ってきた時刻 (ms) */
  fetchedAt: number;
  items: PlaceItem[];
  /** 名前と種類だけ（Overpass から取れず、OpenFreeMap の地図データから出したもの）。あとで取り直す */
  partial?: boolean;
  /** OpenStreetMap の取り方の版（places/sources.ts の OSM_QUERY_VERSION）。古ければ取り直す */
  v?: number;
}

/** 自分で読み込んだ場所のファイル（GeoJSON・GPX） */
export interface PlaceImport {
  id: string;
  /** ファイル名 */
  name: string;
  importedAt: number;
  items: PlaceItem[];
}

/** オフライン用に保存した範囲 */
export interface SavedArea {
  id: string;
  name: string;
  createdAt: number;
  /** ルート沿い / 表示中の範囲 */
  kind: 'route' | 'view';
  /** ルート沿いのとき、片側の幅 (m) */
  bufferM?: number;
  /** 範囲 (west, south, east, north)（地図で見るとき用） */
  bounds: [number, number, number, number];
  /** 保存したタイル・写真の URL（この範囲を消すとき、ほかの範囲で使っていないものを消す） */
  urls: string[];
  /** 場所の情報のマス目 */
  cells: string[];
  /** 保存できなかった枚数 */
  failed: number;
}

const DB_NAME = 'yama-map';
const DB_VERSION = 4;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('points')) {
        const points = db.createObjectStore('points', { autoIncrement: true });
        points.createIndex('trackId', 'trackId');
      }
      if (!db.objectStoreNames.contains('photos')) {
        const photos = db.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('trackId', 'trackId');
      }
      if (!db.objectStoreNames.contains('places')) db.createObjectStore('places', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('areas')) db.createObjectStore('areas', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('imports')) db.createObjectStore('imports', { keyPath: 'id' });
      // 版4：記録した天気（記録ごとに1つ。./weatherLog.ts）
      if (!db.objectStoreNames.contains('weather')) db.createObjectStore('weather', { keyPath: 'trackId' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // 接続が切れたら（ブラウザに閉じられた・別のタブが版を上げた）、次はつなぎ直す
      const reset = () => {
        if (dbPromise === p) dbPromise = null;
      };
      db.onclose = reset;
      db.onversionchange = () => {
        db.close();
        reset();
      };
      resolve(db);
    };
    req.onerror = () => {
      if (dbPromise === p) dbPromise = null;
      reject(req.error);
    };
  });
  dbPromise = p;
  return p;
}

/** 接続が切れているときのエラー（iPhone の Safari では、裏から戻ったときに起きることがある） */
const lostConnection = (e: unknown) => e instanceof DOMException && (e.name === 'InvalidStateError' || e.name === 'UnknownError');

/** db を使う処理。接続が切れていたら、つなぎ直して1回だけやり直す（失敗したトランザクションは取り消されているので、やり直しても二重にならない） */
async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  try {
    return await fn(await open());
  } catch (e) {
    if (!lostConnection(e)) throw e;
    dbPromise = null;
    return fn(await open());
  }
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * 記録を書く。自分で付けたもの（経路名・ロック）は、渡した記録に無ければ保存してあるものを残す
 * （記録の仕組みや標高の埋め直しが持っている古い写しで書いても、消えないように）
 */
function putKeepingLabels(store: IDBObjectStore, track: Track) {
  const req = store.get(track.id);
  req.onsuccess = () => {
    const old = req.result as Track | undefined;
    const route = track.route ?? old?.route;
    const locked = track.locked ?? old?.locked;
    store.put({ ...track, ...(route != null ? { route } : {}), ...(locked != null ? { locked } : {}) });
  };
}

export function putTrack(track: Track): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction('tracks', 'readwrite');
    putKeepingLabels(tx.objectStore('tracks'), track);
    return done(tx);
  });
}

/** 保存してある記録の一部（経路名・ロックなど）を書き換えて、書き換えた記録を返す（なければ null） */
export function updateTrack(id: string, patch: Partial<Pick<Track, 'route' | 'locked'>>): Promise<Track | null> {
  return withDb((db) => {
    const tx = db.transaction('tracks', 'readwrite');
    const store = tx.objectStore('tracks');
    let updated: Track | null = null;
    const req = store.get(id);
    req.onsuccess = () => {
      const old = req.result as Track | undefined;
      if (!old) return;
      updated = { ...old, ...patch };
      store.put(updated);
    };
    return done(tx).then(() => updated);
  });
}

/**
 * 点の追記とトラック集計の更新を1トランザクションで行う（前に保存できなかった点もまとめて渡せる）。
 * 記録をまとめて保存する（読み込んだ記録・予定の記録）ときにも使う。追記なので、同じ記録に2回渡すと点が二重になる
 */
export function appendPoints(track: Track, points: TrackPoint[]): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction(['tracks', 'points'], 'readwrite');
    const store = tx.objectStore('points');
    for (const p of points) store.add(p);
    putKeepingLabels(tx.objectStore('tracks'), track);
    return done(tx);
  });
}

/**
 * あとから標高を埋める：記録の点のうち標高のないものを書き換え（時刻 → 標高）、記録の登り・下りを数え直す。
 * 1つのトランザクションで行い、記録は保存してあるものを読み直して登り・下りだけを変える
 * （埋めているあいだに変えた範囲・経路名を、古い写しで上書きしないように。消した記録は戻さない）。
 * gainOf は保存してある記録（範囲 trim を含む）から登り・下りを数える。書き換えた記録を返す（記録がなければ null）
 */
export function fillTrackElevations(
  trackId: string,
  eles: Map<number, number>,
  gainOf: (stored: Track) => { ascent: number; descent: number },
): Promise<Track | null> {
  return withDb((db) => {
    const tx = db.transaction(['tracks', 'points'], 'readwrite');
    const tracks = tx.objectStore('tracks');
    let updated: Track | null = null;
    const get = tracks.get(trackId);
    get.onsuccess = () => {
      const stored = get.result as Track | undefined;
      if (!stored) return;
      const req = tx.objectStore('points').index('trackId').openCursor(IDBKeyRange.only(trackId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          updated = { ...stored, ...gainOf(stored) };
          tracks.put(updated);
          return;
        }
        const p = cursor.value as TrackPoint;
        const ele = eles.get(p.t);
        if (ele != null && p.ele == null) cursor.update({ ...p, ele });
        cursor.continue();
      };
    };
    return done(tx).then(() => updated);
  });
}

export async function listTracks(): Promise<Track[]> {
  const all = await withDb((db) => wrap<Track[]>(db.transaction('tracks').objectStore('tracks').getAll()));
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function getPoints(trackId: string): Promise<TrackPoint[]> {
  const pts = await withDb((db) => wrap<TrackPoint[]>(db.transaction('points').objectStore('points').index('trackId').getAll(trackId)));
  return pts.sort((a, b) => a.t - b.t);
}

/** ロックしている記録を消そうとしたときのエラー */
export class LockedTrackError extends Error {
  constructor() {
    super('ロックしている記録は削除できません');
  }
}

/** 記録を点・写真・天気ごと消す。ロックしている記録は消さずに LockedTrackError */
export function deleteTrack(id: string): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction(['tracks', 'points', 'photos', 'weather'], 'readwrite');
    const tracks = tx.objectStore('tracks');
    let locked = false;
    const req = tracks.get(id);
    req.onsuccess = () => {
      if ((req.result as Track | undefined)?.locked) {
        locked = true;
        tx.abort();
        return;
      }
      tracks.delete(id);
      tx.objectStore('weather').delete(id);
      for (const name of ['points', 'photos']) {
        const store = tx.objectStore(name);
        const cursorReq = store.index('trackId').openKeyCursor(IDBKeyRange.only(id));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
      }
    };
    return done(tx).catch((e) => {
      throw locked ? new LockedTrackError() : e;
    });
  });
}

/** 記録した天気（なければ null） */
export async function getTrackWeather(trackId: string): Promise<TrackWeather | null> {
  return (await withDb((db) => wrap<TrackWeather | undefined>(db.transaction('weather').objectStore('weather').get(trackId)))) ?? null;
}

export function putTrackWeather(rec: TrackWeather): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction('weather', 'readwrite');
    tx.objectStore('weather').put(rec);
    return done(tx);
  });
}

/** 記録の写真の枚数 */
export function countPhotos(trackId: string): Promise<number> {
  return withDb((db) => wrap<number>(db.transaction('photos').objectStore('photos').index('trackId').count(trackId)));
}

export function putPhoto(photo: TrackPhoto): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction('photos', 'readwrite');
    tx.objectStore('photos').put(photo);
    return done(tx);
  });
}

export async function getPhotos(trackId: string): Promise<TrackPhoto[]> {
  const all = await withDb((db) => wrap<TrackPhoto[]>(db.transaction('photos').objectStore('photos').index('trackId').getAll(trackId)));
  return all.sort((a, b) => a.t - b.t);
}

export function deletePhoto(id: string): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction('photos', 'readwrite');
    tx.objectStore('photos').delete(id);
    return done(tx);
  });
}

// ---------- 場所の情報 ----------
export const placeKey = (source: PlaceSource, cell: string) => `${source}|${cell}`;

export function putPlaceCell(c: PlaceCell): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction('places', 'readwrite');
    tx.objectStore('places').put(c);
    return done(tx);
  });
}

/** マス目の場所の情報（keys の順。ないものは undefined） */
export function getPlaceCells(keys: string[]): Promise<(PlaceCell | undefined)[]> {
  return withDb(async (db) => {
    const store = db.transaction('places').objectStore('places');
    return Promise.all(keys.map((k) => wrap<PlaceCell | undefined>(store.get(k))));
  });
}

/** keep に入っていない、before より前に取ってきたマス目を消す（増えすぎないように） */
export function prunePlaceCells(before: number, keep: Set<string>): Promise<number> {
  return withDb((db) => {
    const tx = db.transaction('places', 'readwrite');
    let n = 0;
    const req = tx.objectStore('places').openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const c = cursor.value as PlaceCell;
      if (c.fetchedAt < before && !keep.has(c.cell)) {
        cursor.delete();
        n++;
      }
      cursor.continue();
    };
    return done(tx).then(() => n);
  });
}

export function putImport(i: PlaceImport): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction('imports', 'readwrite');
    tx.objectStore('imports').put(i);
    return done(tx);
  });
}

export async function listImports(): Promise<PlaceImport[]> {
  const all = await withDb((db) => wrap<PlaceImport[]>(db.transaction('imports').objectStore('imports').getAll()));
  return all.sort((a, b) => b.importedAt - a.importedAt);
}

export function deleteImport(id: string): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction('imports', 'readwrite');
    tx.objectStore('imports').delete(id);
    return done(tx);
  });
}

// ---------- 保存した範囲 ----------
export function putArea(a: SavedArea): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction('areas', 'readwrite');
    tx.objectStore('areas').put(a);
    return done(tx);
  });
}

export async function listAreas(): Promise<SavedArea[]> {
  const all = await withDb((db) => wrap<SavedArea[]>(db.transaction('areas').objectStore('areas').getAll()));
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteArea(id: string): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction('areas', 'readwrite');
    tx.objectStore('areas').delete(id);
    return done(tx);
  });
}

export function clearAreas(): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction('areas', 'readwrite');
    tx.objectStore('areas').clear();
    return done(tx);
  });
}
