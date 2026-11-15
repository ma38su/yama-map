/**
 * やまマップの起動。画面の各部分は src/app/ に分けてある：
 *  mapView（地図）・mapTap（地図のタップ）・route（行程）・nav（到着予想）・sheetView（下のシート）・
 *  profileView（標高グラフ）・recording（現在地と記録）・status（上の状態表示）・menu（メニュー）・offline（地図の保存）
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
// 動作のログは、ほかのモジュールより先に（読み込み中のエラーも残すため）
import { log } from './log';
import type { Map as MlMap } from 'maplibre-gl';
import type { ActiveRoute } from './nav/plan';
import { backgroundCapable } from './track/location';
import type { TrackRecorder } from './track/recorder';
import { settings } from './settings';
import { $ } from './ui/dom';
import { addOverlayLayers, map, updateDaylight } from './app/mapView';
import './app/backButton';
import './app/diagnostics';
import './app/install';
import './app/mapTap';
import './app/compass';
import './app/photos';
import './app/search';
import { ensureBuiltinPlan } from './app/menu';
import { updateNav, type Nav } from './app/nav';
import './app/offline';
import { pocketActive } from './app/pocket';
import './app/perf';
import { checkUnfinished, recorder, renderTrack, updateRecButton } from './app/recording';
import { renderRoute } from './app/route';
import './app/sheetView';
import './app/transfer';
import { whileVisible } from './app/scheduler';
import { state } from './app/state';
import { addWeatherLayers } from './app/weather';

log(`起動 ${__APP_VERSION__}（${backgroundCapable ? 'アプリ版' : 'Web版'}）`);

map.on('load', () => {
  addOverlayLayers();
  addWeatherLayers('route-casing');
  if (settings.terrain) map.setTerrain({ source: 'dem-terrain', exaggeration: settings.terrainExaggeration });
  updateDaylight();
  // 空の色は1分ごと。裏に回っている間は止め、戻ったらすぐ合わせる
  // ポケット表示のあいだは地図を描かないので止める（戻ったら合わせる）
  whileVisible(60_000, () => !pocketActive() && updateDaylight());
  renderRoute();
  renderTrack();
  updateNav();
});

// data-close の付いたボタンで、そのダイアログを閉じる
document.addEventListener('click', (e) => {
  const b = (e.target as Element | null)?.closest?.('[data-close]');
  if (b) b.closest('dialog')?.close();
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
// 前回の途中の記録は、地図の読み込みを待たずに確かめる（電波が弱いと読み込みが長引くため。その間「記録開始」は待つ）
void checkUnfinished();
void ensureBuiltinPlan();

// ---------- Service Worker（オフライン対応） ----------
// アプリ本体のキャッシュは sw.js がインストール時に行う（ビルドのファイル一覧が埋め込んである）。
// アプリ版はアプリ本体が APK に入っているので、地図タイルだけを任せる
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(backgroundCapable ? './sw.js?native=1' : './sw.js').catch((e) => {
      console.warn('Service Worker の登録に失敗しました', e);
    });
  });
}

// デバッグ・動作確認用
declare global {
  interface Window {
    yamaMap?: { map: MlMap; recorder: TrackRecorder; nav: () => Nav | null; route: () => ActiveRoute | null };
  }
}
window.yamaMap = { map, recorder, nav: () => state.lastNav, route: () => state.route };
