/** 地図をタップしたとき：標高・地名と「出発地・経由地・目的地」のボタン、ルート上ならそこまでの到着予想 */
import { Popup } from 'maplibre-gl';
import { formatDistance, type LngLat } from '../geo';
import { addEstimates, estimate, projectOnRoute } from '../nav/eta';
import type { PointKind } from '../nav/plan';
import { nearestPlaceName } from '../route/roadTiles';
import { fmtClock, fmtM, fmtMin, h } from '../ui/dom';
import { dem, map } from './mapView';
import { choosePoint } from './route';
import { state } from './state';

export const popup = new Popup({ closeButton: false, maxWidth: '300px', offset: 8 });
let popupSeq = 0;
map.on('click', async (e) => {
  const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat];
  const seq = ++popupSeq;
  const box = h('div', 'pp');
  const name = h('div', 'pp-name', ' ');
  const ele = h('div', 'pp-ele', '標高 …');
  const coord = h('div', 'pp-coord', `${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`);
  const eta = h('div', 'pp-eta');
  const actions = h('div', 'pp-actions');
  let placeName: string | null = null;
  for (const [kind, label] of [
    ['start', '出発地'],
    ['via', '経由地'],
    ['dest', '目的地'],
  ] as [PointKind, string][]) {
    const b = h('button', kind, label);
    b.type = 'button';
    b.addEventListener('click', () => void choosePoint(kind, lngLat, placeName ?? undefined));
    actions.append(b);
  }
  box.append(name, ele, coord, eta, actions);
  popup.setLngLat(e.lngLat).setDOMContent(box).addTo(map);
  // ルート上ならここまでの到着予想も出す
  const nav = state.lastNav;
  if (state.route && state.timeline && nav) {
    const pos = projectOnRoute(state.route.coords, state.route.dists, lngLat);
    if (pos && pos.offset < 150) {
      if (pos.along > nav.fromAlong) {
        const ahead = estimate(state.timeline, nav.fromAlong, pos.along, nav.factors);
        const est = nav.rejoin ? addEstimates(nav.rejoin, ahead) : ahead;
        eta.textContent = `ここまで ${formatDistance(pos.along - nav.fromAlong + (nav.rejoin?.distM ?? 0))}・${fmtClock(Date.now() + est.totalMin * 60_000)}着（${fmtMin(est.totalMin)}）`;
      } else eta.textContent = '通過済み';
    }
  }
  const [el, nm] = await Promise.all([dem.elevation(lngLat[0], lngLat[1]), nearestPlaceName(lngLat, 200)]);
  if (seq !== popupSeq) return;
  ele.textContent = `標高 ${fmtM(el)}`;
  placeName = nm;
  name.textContent = nm ? `${nm} 付近` : '';
});
