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

const DB_NAME = 'yama-map';
const DB_VERSION = 2;

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
