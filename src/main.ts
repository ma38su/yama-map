/**
 * やまマップの起動。画面の各部分は src/app/ に分けてある：
 *  mapView（地図）・mapTap（地図のタップ）・route（行程）・nav（到着予想）・sheetView（下のシート）・
 *  profileView（標高グラフ）・recording（現在地と記録）・tracks（記録の一覧）・status（上の状態表示）・menu（メニュー）・offline（地図の保存）・
 *  places（山小屋・水場・写真などの場所の情報）・layers（地図に重ねる情報の切り替え）・savedAreas（保存した範囲）
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
import { addPlaceLayers } from './app/places';
import { addSavedLayer } from './app/savedAreas';
import './app/backButton';
import './app/diagnostics';
import './app/install';
import './app/layers';
import './app/mapTap';
import './app/compass';
import './app/photos';
import './app/search';
import './app/tracks';
import { ensureBuiltinPlan } from './app/menu';
import { updateNav, type Nav } from './app/nav';
import './app/offline';
import { pocketActive } from './app/pocket';
import './app/perf';
import { checkUnfinished, recorder, renderTrack, updateRecButton } from './app/recording';
import { renderRoute, renderRouteLine } from './app/route';
import './app/sheetView';
import './app/transfer';
import { whileVisible } from './app/scheduler';
import { state } from './app/state';
import { addWeatherLayers } from './app/weather';
import { addTrailLayers } from './app/trails';

log(`起動 ${__APP_VERSION__}（${backgroundCapable ? 'アプリ版' : 'Web版'}）`);

map.on('load', () => {
  addOverlayLayers();
  addWeatherLayers('route-casing');
  // 登山道（地理院の徒歩道・OpenStreetMap の小道）はルートの線の下
  addTrailLayers('route-casing');
  // 保存した範囲はルートの線の下、山小屋・写真などの吹き出しはリプレイの点・カーソルの下（ルートや軌跡の線の上）
  addSavedLayer('route-casing');
  addPlaceLayers('replay');
  if (settings.terrain) map.setTerrain({ source: 'dem-terrain', exaggeration: settings.terrainExaggeration });
  updateDaylight();
  // 空の色は1分ごと。裏に回っている間は止め、戻ったらすぐ合わせる
  // ポケット表示のあいだは地図を描かないので止める（戻ったら合わせる）
  whileVisible(60_000, () => !pocketActive() && updateDaylight());
  // 地図の層に描くもの（地点の印やカードは、読み込みを待たずに下で描いてある）。updateNav は歩き終えた部分の塗り分けのため
  renderRouteLine();
  renderTrack();
  updateNav();
});

// data-close の付いたボタンで、そのダイアログを閉じる
document.addEventListener('click', (e) => {
  const b = (e.target as Element | null)?.closest?.('[data-close]');
  if (b) b.closest('dialog')?.close();
});

// ---------- レイアウト ----------
let panelH = '';
function updatePanelHeight() {
  // 縮尺・出典の表示位置は、閉じたときのシートの高さに合わせる（シートを引いているあいだは毎フレーム呼ばれるが、値はほぼ変わらない）
  const ht = `${Math.round($('sheet').getBoundingClientRect().height - $('sheet-body').getBoundingClientRect().height)}px`;
  if (ht === panelH) return;
  panelH = ht;
  document.documentElement.style.setProperty('--panel-h', ht);
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
