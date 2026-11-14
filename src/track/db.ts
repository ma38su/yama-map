/**
 * 記録した軌跡の保存先 (IndexedDB)。
 * 点は1つずつ追記するので、ブラウザが落ちても直前までの記録が残る。
 */

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
  /** 標高タイルから求めた標高 (m) */
  ele: number | null;
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

const DB_NAME = 'yama-map';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
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

export async function putTrack(track: Track): Promise<void> {
  const db = await open();
  const tx = db.transaction('tracks', 'readwrite');
  tx.objectStore('tracks').put(track);
  await done(tx);
}

/** 点の追記とトラック集計の更新を1トランザクションで行う */
export async function appendPoint(track: Track, point: TrackPoint): Promise<void> {
  const db = await open();
  const tx = db.transaction(['tracks', 'points'], 'readwrite');
  tx.objectStore('points').add(point);
  tx.objectStore('tracks').put(track);
  await done(tx);
}

/** 記録をまとめて保存する（サンプルの記録や、読み込んだ記録用） */
export async function putTrackWithPoints(track: Track, points: TrackPoint[]): Promise<void> {
  const db = await open();
  const tx = db.transaction(['tracks', 'points'], 'readwrite');
  const store = tx.objectStore('points');
  for (const p of points) store.add(p);
  tx.objectStore('tracks').put(track);
  await done(tx);
}

export async function getTrack(id: string): Promise<Track | undefined> {
  const db = await open();
  return wrap(db.transaction('tracks').objectStore('tracks').get(id));
}

export async function listTracks(): Promise<Track[]> {
  const db = await open();
  const all = await wrap<Track[]>(db.transaction('tracks').objectStore('tracks').getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function getPoints(trackId: string): Promise<TrackPoint[]> {
  const db = await open();
  const index = db.transaction('points').objectStore('points').index('trackId');
  const pts = await wrap<TrackPoint[]>(index.getAll(trackId));
  return pts.sort((a, b) => a.t - b.t);
}

export async function deleteTrack(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(['tracks', 'points'], 'readwrite');
  tx.objectStore('tracks').delete(id);
  const points = tx.objectStore('points');
  const cursorReq = points.index('trackId').openKeyCursor(IDBKeyRange.only(id));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    points.delete(cursor.primaryKey);
    cursor.continue();
  };
  await done(tx);
}
