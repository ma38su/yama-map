/**
 * 記録の写真：記録中にカメラで撮る・あとから写真を選ぶと、撮った場所（位置情報、なければ撮った時刻と軌跡）に置く。
 * 写真は縮めて IndexedDB に保存し、地図に小さな丸で出す。タップで大きく見る
 */
import { Marker } from 'maplibre-gl';
import { deletePhoto, getPhotos, putPhoto, type TrackPhoto } from '../track/db';
import { jpegSize, readExif } from '../track/exif';
import { placePhoto } from '../track/photoPlace';
import { $, fmtClock, h } from '../ui/dom';
import { map } from './mapView';
import { recorder } from './recording';
import { state } from './state';
import { setProgress, status } from './status';

const IMAGE_MAX = 1600;
const THUMB = 128;

// ---------- 追加 ----------
const pickDialog = $<HTMLDialogElement>('photo-pick');
const cameraInput = $<HTMLInputElement>('photo-camera');
const fileInput = $<HTMLInputElement>('photo-file');

$('btn-photo').addEventListener('click', () => {
  if (!state.shown) return;
  // 記録中はカメラで撮るか選ぶ。保存した記録には、あとから選んだ写真だけ
  if (recorder.recording) pickDialog.showModal();
  else fileInput.click();
});
pickDialog.addEventListener('click', (e) => {
  if (e.target === pickDialog) pickDialog.close();
});
$('photo-pick-camera').addEventListener('click', () => {
  pickDialog.close();
  cameraInput.click();
});
$('photo-pick-file').addEventListener('click', () => {
  pickDialog.close();
  fileInput.click();
});
for (const input of [cameraInput, fileInput]) {
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) void addPhotos(files);
  });
}

async function addPhotos(files: File[]) {
  const shown = state.shown;
  if (!shown) return;
  const trackId = shown.track.id;
  const fix = recorder.recording ? recorder.state.lastFix : null;
  const here = fix ? { lngLat: [fix.lng, fix.lat] as [number, number], t: fix.timestamp } : null;
  let added = 0;
  let unplaced = 0;
  let unreadable = 0;
  let failed = 0;
  try {
    for (const [i, file] of files.entries()) {
      setProgress(`写真を取り込み中… ${i + 1}/${files.length}`);
      const head = await file.slice(0, 256 * 1024).arrayBuffer();
      const meta = readExif(head);
      // 記録の範囲の外（到着後の山小屋など）で撮った写真も置けるよう、全部の点から探す
      const placed = placePhoto(meta, file.lastModified, shown.all, here);
      if (!placed) {
        unplaced++;
        continue;
      }
      let image: Blob;
      let thumb: Blob;
      try {
        // 大きな写真（50MP など）を元の大きさのまま読むとメモリが足りなくなるので、縮めて読む
        const size = jpegSize(head);
        const k = size ? IMAGE_MAX / Math.max(size.width, size.height) : 1;
        const bmp = await createImageBitmap(
          file,
          size && k < 1
            ? { imageOrientation: 'from-image', resizeWidth: Math.round(size.width * k), resizeHeight: Math.round(size.height * k), resizeQuality: 'medium' }
            : { imageOrientation: 'from-image' },
        );
        try {
          [image, thumb] = await Promise.all([shrink(bmp, IMAGE_MAX, false), shrink(bmp, THUMB, true)]);
        } finally {
          // 縮められなかったときも、読み込んだ画像のメモリはすぐ手放す
          bmp.close();
        }
      } catch {
        unreadable++; // HEIC など、ブラウザが読めない形式
        continue;
      }
      try {
        await putPhoto({ id: crypto.randomUUID(), trackId, t: placed.t, lng: placed.lngLat[0], lat: placed.lngLat[1], located: placed.located, image, thumb });
        added++;
      } catch (e) {
        console.error('写真を保存できませんでした', e);
        failed++; // 空き容量が足りないなど
      }
    }
  } finally {
    setProgress('');
  }
  await renderPhotos(true);
  const notes = [
    unplaced ? `${unplaced}枚は撮った時刻が記録と合わないため置けませんでした` : '',
    unreadable ? `${unreadable}枚は読めない形式でした` : '',
    failed ? `${failed}枚は保存できませんでした（空き容量を確かめてください）` : '',
  ].filter(Boolean);
  status(`${added ? `写真を${added}枚、軌跡に置きました` : '写真を置けませんでした'}${notes.length ? `（${notes.join('・')}）` : ''}`, !added);
}

/** 長いほうの辺を max px までに縮めた JPEG。square なら真ん中を正方形に切り抜く */
async function shrink(bmp: ImageBitmap, max: number, square: boolean): Promise<Blob> {
  const { width: w, height: hgt } = bmp;
  const side = Math.min(w, hgt);
  const sw = square ? side : w;
  const sh = square ? side : hgt;
  const k = Math.min(1, max / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * k);
  canvas.height = Math.round(sh * k);
  canvas.getContext('2d')!.drawImage(bmp, (w - sw) / 2, (hgt - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => {
        // 大きな canvas（1600px で約8MB）は、GC を待たずに手放す
        canvas.width = 0;
        canvas.height = 0;
        if (b) resolve(b);
        else reject(new Error('toBlob'));
      },
      'image/jpeg',
      square ? 0.8 : 0.85,
    ),
  );
}

// ---------- 地図に出す ----------
let photos: TrackPhoto[] = [];
/** 地図に出している写真の印と、縮小画像の object URL（写真の id ごと。写真を足した・消したときは、その分だけ作り直す） */
const shownMarks = new Map<string, { marker: Marker; url: string }>();
/**
 * 写真の印を地図から外しているか（リプレイのあいだ）。印は HTML の要素で、地図が動くたびに位置を計算し直すので、
 * 毎コマ地図を動かすリプレイでは外しておく（リプレイ中は要らない。ルートの地点の印は残す）
 */
let marksHidden = false;

/** 写真の印を地図に出す・外す（リプレイを始めたら外し、終えたら戻す） */
export function showPhotoMarks(on: boolean) {
  if (marksHidden !== on) return;
  marksHidden = !on;
  for (const { marker } of shownMarks.values()) {
    if (on) marker.addTo(map);
    else marker.remove();
  }
}
let loadedFor: string | null = null;
/** 読み込みを始めるたびに増やす（読み込みが重なったら、最後に始めたものだけを描く） */
let loadSeq = 0;

/** 表示中の記録の写真を地図に出す（記録が変わったとき・reload なら読み直す） */
export async function renderPhotos(reload = false) {
  const id = state.shown?.track.id ?? null;
  if (id === loadedFor && !reload) return;
  loadedFor = id;
  const seq = ++loadSeq;
  const list = id ? await getPhotos(id).catch(() => [] as TrackPhoto[]) : [];
  // 読んでいるあいだに別の記録に変わった・同じ記録を読み直し始めた（写真を続けて足したときなど。古い一覧で上書きしないように）
  if (seq !== loadSeq) return;
  photos = list;
  const keep = new Set(list.map((p) => p.id));
  for (const [pid, m] of shownMarks) {
    if (keep.has(pid)) continue;
    m.marker.remove();
    URL.revokeObjectURL(m.url);
    shownMarks.delete(pid);
  }
  for (const p of list) {
    if (shownMarks.has(p.id)) continue;
    const url = URL.createObjectURL(p.thumb);
    const el = h('button', 'photo-mk');
    el.type = 'button';
    el.setAttribute('aria-label', `${fmtClock(p.t)} の写真`);
    const img = h('img');
    img.src = url;
    img.alt = '';
    el.append(img);
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // 写真を足したり消したりすると並びが変わるので、押したときの並びで開く
      openViewer(photos.findIndex((x) => x.id === p.id));
    });
    const marker = new Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lng, p.lat]);
    if (!marksHidden) marker.addTo(map);
    shownMarks.set(p.id, { marker, url });
  }
}

// ---------- 大きく見る ----------
const viewer = $<HTMLDialogElement>('photo-view');
const viewImg = $<HTMLImageElement>('photo-view-img');
let viewIndex = 0;
let viewUrl = '';
const LOCATED_NOTE: Record<TrackPhoto['located'], string> = {
  gps: '写真の位置情報で配置',
  time: '撮った時刻と軌跡から配置',
  here: '撮ったときの現在地に配置',
};

function openViewer(i: number) {
  viewIndex = i;
  showViewed();
  if (!viewer.open) viewer.showModal();
}
function showViewed() {
  const p = photos[viewIndex];
  if (!p) return;
  if (viewUrl) URL.revokeObjectURL(viewUrl);
  viewUrl = URL.createObjectURL(p.image);
  viewImg.src = viewUrl;
  const d = new Date(p.t);
  $('photo-view-caption').textContent = `${d.getMonth() + 1}/${d.getDate()} ${fmtClock(p.t)}・${LOCATED_NOTE[p.located]}（${viewIndex + 1}/${photos.length}）`;
  $<HTMLButtonElement>('photo-prev').disabled = viewIndex === 0;
  $<HTMLButtonElement>('photo-next').disabled = viewIndex === photos.length - 1;
  map.easeTo({ center: [p.lng, p.lat], duration: 300 });
}
$('photo-prev').addEventListener('click', () => {
  if (viewIndex > 0) openViewer(viewIndex - 1);
});
$('photo-next').addEventListener('click', () => {
  if (viewIndex < photos.length - 1) openViewer(viewIndex + 1);
});
$('photo-delete').addEventListener('click', async () => {
  const p = photos[viewIndex];
  if (!p || !confirm('この写真を削除しますか？')) return;
  try {
    await deletePhoto(p.id);
  } catch (e) {
    console.error(e);
    status('写真を削除できませんでした', true);
    return;
  }
  viewer.close();
  await renderPhotos(true);
});
viewer.addEventListener('click', (e) => {
  if (e.target === viewer) viewer.close();
});
viewer.addEventListener('close', () => {
  viewImg.removeAttribute('src');
  if (viewUrl) URL.revokeObjectURL(viewUrl);
  viewUrl = '';
});
