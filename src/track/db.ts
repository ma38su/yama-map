/**
 * 記録した軌跡の保存先 (IndexedDB)。
 * 点は1つずつ追記するので、ブラウザが落ちても直前までの記録が残る。
 * 地図に重ねる場所の情報（マス目ごと）と、オフライン用に保存した範囲もここに置く。
 * 版を上げるときは、ストアを足すだけにする（アプリを更新しても記録が消えないように）
 */
import type { PlaceItem, PlaceSource } from '../places/sources';

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
  distance: number;
  ascent: number;
  descent: number;
  pointCount: number;
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
const DB_VERSION = 3;

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

export function putTrack(track: Track): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction('tracks', 'readwrite');
    tx.objectStore('tracks').put(track);
    return done(tx);
  });
}

/** 点の追記とトラック集計の更新を1トランザクションで行う（前に保存できなかった点もまとめて渡せる） */
export function appendPoints(track: Track, points: TrackPoint[]): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction(['tracks', 'points'], 'readwrite');
    const store = tx.objectStore('points');
    for (const p of points) store.add(p);
    tx.objectStore('tracks').put(track);
    return done(tx);
  });
}

/** 記録をまとめて保存する（サンプルの記録や、読み込んだ記録用） */
export const putTrackWithPoints = appendPoints;

/** 記録の点の標高を書き換える（時刻 → 標高）。あとから標高を埋めるときに使う */
export function updateElevations(trackId: string, eles: Map<number, number>): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction('points', 'readwrite');
    const req = tx.objectStore('points').index('trackId').openCursor(IDBKeyRange.only(trackId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const p = cursor.value as TrackPoint;
      const ele = eles.get(p.t);
      if (ele != null && p.ele == null) cursor.update({ ...p, ele });
      cursor.continue();
    };
    return done(tx);
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

export function deleteTrack(id: string): Promise<void> {
  return withDb((db) => {
    const tx = db.transaction(['tracks', 'points', 'photos'], 'readwrite');
    tx.objectStore('tracks').delete(id);
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
    return done(tx);
  });
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
