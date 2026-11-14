/**
 * やまマップの起動。画面の各部分は src/app/ に分けてある：
 *  mapView（地図）・mapTap（地図のタップ）・route（行程）・nav（到着予想）・sheetView（下のシート）・
 *  profileView（標高グラフ）・recording（現在地と記録）・status（上の状態表示）・menu（メニュー）・offline（地図の保存）
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Map as MlMap } from 'maplibre-gl';
import { TERRAIN_EXAGGERATION } from './map/style';
import type { ActiveRoute } from './nav/plan';
import type { TrackRecorder } from './track/recorder';
import { settings } from './settings';
import { $ } from './ui/dom';
import { addOverlayLayers, map, updateDaylight } from './app/mapView';
import './app/mapTap';
import { PRESETS } from './app/menu';
import { updateNav, type Nav } from './app/nav';
import './app/offline';
import { checkUnfinished, recorder, renderTrack, updateRecButton } from './app/recording';
import { renderRoute } from './app/route';
import './app/sheetView';
import { state } from './app/state';

map.on('load', () => {
  addOverlayLayers();
  if (settings.terrain) map.setTerrain({ source: 'dem-terrain', exaggeration: TERRAIN_EXAGGERATION });
  updateDaylight();
  setInterval(updateDaylight, 60_000);
  renderRoute();
  renderTrack();
  updateNav();
  void checkUnfinished();
});

// ---------- レイアウト ----------
function updatePanelHeight() {
  // 縮尺・出典の表示位置は、閉じたときのシートの高さに合わせる
  const ht = $('sheet').getBoundingClientRect().height - $('sheet-body').getBoundingClientRect().height;
  document.documentElement.style.setProperty('--panel-h', `${Math.round(ht)}px`);
}
new ResizeObserver(updatePanelHeight).observe($('sheet'));
renderRoute();
updateNav();
updateRecButton();

// ---------- Service Worker（オフライン対応） ----------
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('./sw.js');
      await navigator.serviceWorker.ready;
      // 初回表示で読み込んだアプリ本体（JS/CSS/ワーカー）とおすすめルートをすぐキャッシュし、次回から圏外でも起動できるようにする
      const own = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((u) => u.startsWith(location.origin));
      const extra = [new URL(workerUrl, location.href).href, ...PRESETS.map((p) => new URL(p.file, location.href).href)];
      const cache = await caches.open('yama-map-shell-v1');
      await Promise.all(
        [...new Set([...own, ...extra])].map((u) =>
          cache.match(u, { ignoreVary: true }).then((hit) => (hit ? undefined : cache.add(u))).catch(() => undefined),
        ),
      );
    } catch (e) {
      console.warn('Service Worker の登録に失敗しました', e);
    }
  });
}

// デバッグ・動作確認用
declare global {
  interface Window {
    yamaMap?: { map: MlMap; recorder: TrackRecorder; nav: () => Nav | null; route: () => ActiveRoute | null };
  }
}
window.yamaMap = { map, recorder, nav: () => state.lastNav, route: () => state.route };
