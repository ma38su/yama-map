/** 地名の検索：山・沢・温泉などの名前で探し、選ぶとその場所の吹き出し（出発地・経由地・目的地）を出す */
import { formatDistance, type LngLat } from '../geo';
import { searchPlaces, type Place } from '../nav/placeSearch';
import { $, h } from '../ui/dom';
import { map } from './mapView';
import { openPointPopup } from './mapTap';

const dialog = $<HTMLDialogElement>('search');
const input = $<HTMLInputElement>('search-q');
const list = $('search-results');
const note = $('search-note');

$('btn-search').addEventListener('click', () => {
  dialog.showModal();
  input.select();
});
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});

let timer = 0;
let ctrl: AbortController | null = null;
input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = window.setTimeout(() => void run(input.value.trim()), 400);
});
dialog.querySelector('form')!.addEventListener('submit', (e) => {
  // Enter で待たずに探す（ダイアログを閉じない）
  e.preventDefault();
  clearTimeout(timer);
  void run(input.value.trim());
});

async function run(q: string) {
  ctrl?.abort();
  if (!q) {
    list.replaceChildren();
    note.textContent = '';
    return;
  }
  if (!navigator.onLine) {
    note.textContent = '圏外のため検索できません（地図をタップして選んでください）';
    return;
  }
  ctrl = new AbortController();
  const c = map.getCenter();
  note.textContent = '検索中…';
  try {
    const places = await searchPlaces(q, [c.lng, c.lat], ctrl.signal);
    note.textContent = places.length ? '地図の中心から近い順（地図に載っている地名を先に）' : '見つかりませんでした';
    list.replaceChildren(...places.map(item));
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    note.textContent = e instanceof Error ? e.message : '地名を検索できませんでした';
  }
}

function item(p: Place) {
  const li = h('li');
  const b = h('button', 'search-item');
  b.type = 'button';
  b.append(h('span', 'title', p.name), h('span', 'meta', `${p.kind === 'place' ? '地名' : '住所'}・${formatDistance(p.dist)}`));
  b.addEventListener('click', () => pick(p.lngLat, p.name));
  li.append(b);
  return li;
}

function pick(lngLat: LngLat, name: string) {
  dialog.close();
  map.flyTo({ center: lngLat, zoom: Math.max(map.getZoom(), 14), duration: 800 });
  map.once('moveend', () => void openPointPopup(lngLat, name));
}
