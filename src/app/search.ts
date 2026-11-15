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
/** 電波が弱いときに「検索中…」のまま止まらないよう、これで打ち切る */
const TIMEOUT_MS = 10_000;
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
    list.replaceChildren();
    note.textContent = '圏外のため検索できません（地図をタップして選んでください）';
    return;
  }
  const mine = new AbortController();
  ctrl = mine;
  const c = map.getCenter();
  note.textContent = '検索中…';
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    mine.abort();
  }, TIMEOUT_MS);
  try {
    const places = await searchPlaces(q, [c.lng, c.lat], mine.signal);
    note.textContent = places.length ? '地図の中心から近い順（地図に載っている地名を先に）' : '見つかりませんでした';
    list.replaceChildren(...places.map(item));
  } catch {
    // 次の入力で取り消した（新しい検索が始まった）ときは何もしない
    if (mine.signal.aborted && !timedOut) return;
    list.replaceChildren();
    // 通信の失敗はブラウザの英語のメッセージになるので、日本語にする
    note.textContent = timedOut
      ? '時間がかかりすぎたので、検索をやめました（電波の届くところで試してください）'
      : '地名を検索できませんでした（電波の状態を確かめてください）';
  } finally {
    clearTimeout(timeout);
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
