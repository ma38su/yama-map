/**
 * 記録の写真：記録中にカメラで撮る・あとから写真を選ぶと、撮った場所（位置情報、なければ撮った時刻と軌跡）に置く。
 * 写真は縮めて IndexedDB に保存し、地図に小さな丸で出す。タップで大きく見る
 */
import { Marker } from 'maplibre-gl';
import { deletePhoto, getPhotos, putPhoto, type TrackPhoto } from '../track/db';
import { readExif } from '../track/exif';
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
  try {
    for (const [i, file] of files.entries()) {
      setProgress(`写真を取り込み中… ${i + 1}/${files.length}`);
      const meta = readExif(await file.slice(0, 256 * 1024).arrayBuffer());
      const placed = placePhoto(meta, file.lastModified, shown.points, here);
      if (!placed) {
        unplaced++;
        continue;
      }
      let image: Blob;
      let thumb: Blob;
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        [image, thumb] = await Promise.all([shrink(bmp, IMAGE_MAX, false), shrink(bmp, THUMB, true)]);
        bmp.close();
      } catch {
        unreadable++; // HEIC など、ブラウザが読めない形式
        continue;
      }
      await putPhoto({ id: crypto.randomUUID(), trackId, t: placed.t, lng: placed.lngLat[0], lat: placed.lngLat[1], located: placed.located, image, thumb });
      added++;
    }
  } finally {
    setProgress('');
  }
  loadedFor = null;
  await renderPhotos();
  const notes = [
    unplaced ? `${unplaced}枚は撮った時刻が記録と合わないため置けませんでした` : '',
    unreadable ? `${unreadable}枚は読めない形式でした` : '',
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
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', square ? 0.8 : 0.85));
}

// ---------- 地図に出す ----------
let photos: TrackPhoto[] = [];
let markers: Marker[] = [];
let urls: string[] = [];
let loadedFor: string | null = null;

/** 表示中の記録の写真を地図に出す（記録が変わったときだけ読み直す） */
export async function renderPhotos() {
  const id = state.shown?.track.id ?? null;
  if (id === loadedFor) return;
  loadedFor = id;
  const list = id ? await getPhotos(id).catch(() => [] as TrackPhoto[]) : [];
  if (loadedFor !== id) return; // 読んでいるあいだに別の記録に変わった
  for (const m of markers) m.remove();
  for (const u of urls) URL.revokeObjectURL(u);
  photos = list;
  urls = list.map((p) => URL.createObjectURL(p.thumb));
  markers = list.map((p, i) => {
    const el = h('button', 'photo-mk');
    el.type = 'button';
    el.setAttribute('aria-label', `${fmtClock(p.t)} の写真`);
    const img = h('img');
    img.src = urls[i];
    img.alt = '';
    el.append(img);
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openViewer(i);
    });
    return new Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lng, p.lat]).addTo(map);
  });
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
  await deletePhoto(p.id);
  viewer.close();
  loadedFor = null;
  await renderPhotos();
});
viewer.addEventListener('click', (e) => {
  if (e.target === viewer) viewer.close();
});
viewer.addEventListener('close', () => {
  viewImg.removeAttribute('src');
  if (viewUrl) URL.revokeObjectURL(viewUrl);
  viewUrl = '';
});
