/**
 * 地図をタップしたとき：標高・地名と「出発地・経由地・目的地」のボタン、ルート上ならそこまでの到着予想。
 * 山小屋・写真などの吹き出しをタップしたときは、その場所の詳しい情報（places.ts）
 */
import { Popup } from 'maplibre-gl';
import { formatDistance, type LngLat } from '../geo';
import { addEstimates, estimate, projectOnRoute } from '../nav/eta';
import type { PointKind } from '../nav/plan';
import { nearestPlaceName } from '../route/roadTiles';
import { $, fmtClock, fmtM, fmtMin, h } from '../ui/dom';
import type { PlaceItem } from '../places/sources';
import { dem, map } from './mapView';
import { placeAt, placeContent } from './places';
import { choosePoint } from './route';
import { state } from './state';

// 開いたときに中のボタン・リンクに移らない（スマホでは要らず、枠が出て目立つため）
export const popup = new Popup({ closeButton: false, maxWidth: '300px', offset: 8, focusAfterOpen: false });
let popupSeq = 0;
map.on('click', (e) => {
  const place = placeAt(e.point);
  if (place) openPlacePopup(place);
  else void openPointPopup([e.lngLat.lng, e.lngLat.lat]);
});

/** 「出発地・経由地・目的地」のボタン。name() はボタンを押したときの地点の名前 */
function pointActions(lngLat: LngLat, name: () => string | undefined): HTMLElement {
  const actions = h('div', 'pp-actions');
  for (const [kind, label] of [
    ['start', '出発地'],
    ['via', '経由地'],
    ['dest', '目的地'],
  ] as [PointKind, string][]) {
    const b = h('button', kind, label);
    b.type = 'button';
    b.addEventListener('click', () => void choosePoint(kind, lngLat, name()));
    actions.append(b);
  }
  return actions;
}

/** 山小屋・写真などの吹き出し（その場所を出発地・目的地などにもできる） */
function openPlacePopup(item: PlaceItem) {
  popupSeq++;
  // 開いている吹き出しは先に閉じる（開いたままだと、このタップで閉じる処理（closeOnClick）に新しい中身ごと閉じられる）
  if (popup.isOpen()) popup.remove();
  const box = placeContent(item);
  box.append(pointActions(item.lngLat, () => (item.source === 'osm' || item.source === 'user' ? item.title : undefined)));
  popup.setLngLat(item.lngLat).setDOMContent(box).addTo(map);
  keepPopupInView();
  // 写真が読み込まれると吹き出しが大きくなるので、もう一度
  box.querySelector('img')?.addEventListener('load', keepPopupInView, { once: true });
}

/** 吹き出しが下のシートや画面の上にはみ出していたら、地図をずらして見えるようにする */
function keepPopupInView() {
  requestAnimationFrame(() => {
    const el = popup.isOpen() ? popup.getElement() : undefined;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const top = 12;
    const bottom = $('sheet').getBoundingClientRect().top - 36; // 縮尺・出典の表示の上まで
    let dy = r.bottom > bottom ? r.bottom - bottom : 0;
    if (r.top - dy < top) dy = r.top - top;
    if (Math.abs(dy) > 1) map.panBy([0, dy], { duration: 300 });
  });
}

/** 地点の吹き出しを出す。knownName は地名の検索で選んだときの名前（なければ近くの地名を探す） */
export async function openPointPopup(lngLat: LngLat, knownName?: string) {
  const seq = ++popupSeq;
  const box = h('div', 'pp');
  const name = h('div', 'pp-name', knownName ?? ' ');
  const ele = h('div', 'pp-ele', '標高 …');
  const coord = h('div', 'pp-coord', `${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`);
  const eta = h('div', 'pp-eta');
  let placeName: string | null = knownName ?? null;
  box.append(name, ele, coord, eta, pointActions(lngLat, () => placeName ?? undefined));
  popup.setLngLat(lngLat).setDOMContent(box).addTo(map);
  // ルート上ならここまでの到着予想も出す
  const nav = state.lastNav;
  if (state.route && state.timeline && nav) {
    const pos = projectOnRoute(state.route.coords, state.route.dists, lngLat);
    if (pos && pos.offset < 150) {
      if (pos.along > nav.fromAlong) {
        const ahead = estimate(state.timeline, nav.fromAlong, pos.along, nav.factors);
        const est = nav.rejoin ? addEstimates(nav.rejoin, ahead) : ahead;
        // 時刻は行程と同じ基準（出発時刻を指定していればその時刻）から数える
        eta.textContent = `ここまで ${formatDistance(pos.along - nav.fromAlong + (nav.rejoin?.distM ?? 0))}・${fmtClock(nav.startAt + est.totalMin * 60_000)}着（${fmtMin(est.totalMin)}）`;
      } else eta.textContent = '通過済み';
    }
  }
  const [el, nm] = await Promise.all([dem.elevation(lngLat[0], lngLat[1]), knownName ? null : nearestPlaceName(lngLat, 200)]);
  if (seq !== popupSeq) return;
  ele.textContent = `標高 ${fmtM(el)}`;
  if (knownName) return;
  placeName = nm;
  name.textContent = nm ? `${nm} 付近` : '';
}
