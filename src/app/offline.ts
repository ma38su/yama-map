/** オフライン用に地図タイル・道データを保存する */
import { bbox, viewBounds } from '../geo';
import { BASE_LAYERS } from '../map/style';
import {
  MAX_TILES,
  clearTileCache,
  downloadLayers,
  downloadTiles,
  estimateTiles,
  planTiles,
  storageUsage,
} from '../offline/download';
import { osmTileUrls } from '../route/roadTiles';
import { settings } from '../settings';
import { $ } from '../ui/dom';
import { map } from './mapView';
import { state } from './state';

const offlineBtn = $<HTMLButtonElement>('btn-offline');
const offlineInfo = $('offline-info');
const offlineProgress = $<HTMLProgressElement>('offline-progress');
let downloading: AbortController | null = null;

offlineBtn.addEventListener('click', async () => {
  if (downloading) {
    downloading.abort();
    return;
  }
  // ルートがあればルート全体、なければ表示中の範囲
  let bounds: [number, number, number, number];
  if (state.route) {
    const [w, s, e, n] = bbox(state.route.coords);
    const pad = 0.005;
    bounds = [w - pad, s - pad, e + pad, n + pad];
  } else {
    const c = map.getCenter();
    const canvas = map.getCanvas();
    bounds = viewBounds([c.lng, c.lat], map.getZoom(), canvas.clientWidth, canvas.clientHeight);
  }
  const layers = downloadLayers(BASE_LAYERS[settings.base].url, 16);
  const osmUrls = (await osmTileUrls(bounds).catch(() => [])).map((t) => t.url);
  const n = estimateTiles(bounds, layers) + osmUrls.length;
  if (n > MAX_TILES) {
    alert(`範囲が広すぎます（${n.toLocaleString()}枚）。地図を拡大してから保存してください。`);
    return;
  }
  const mb = Math.max(1, Math.round((n * 30) / 1024));
  if (!confirm(`${state.route ? 'ルート周辺' : '表示中の範囲'}の地図（ズーム16まで）を保存します。\n約${n.toLocaleString()}枚・目安 ${mb} MB\nWi-Fi環境での実行がおすすめです。`)) return;
  downloading = new AbortController();
  offlineBtn.textContent = '中止';
  offlineProgress.hidden = false;
  offlineProgress.max = n;
  offlineProgress.value = 0;
  const result = await downloadTiles(
    [...planTiles(bounds, layers), ...osmUrls],
    (p) => {
      offlineProgress.value = p.done;
      offlineInfo.textContent = `保存中… ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`;
    },
    downloading.signal,
  );
  const aborted = downloading.signal.aborted;
  downloading = null;
  offlineBtn.textContent = '地図を保存';
  offlineProgress.hidden = true;
  offlineInfo.textContent = aborted
    ? '中止しました'
    : `保存しました（${result.done - result.failed}枚${result.failed ? `、失敗 ${result.failed}枚` : ''}）`;
  void refreshStorage();
});

$('btn-cache-clear').addEventListener('click', async () => {
  if (!confirm('保存した地図と、表示したときに残った地図をすべて削除しますか？（記録した軌跡は消えません）')) return;
  await clearTileCache();
  offlineInfo.textContent = '削除しました';
  void refreshStorage();
});

export async function refreshStorage() {
  $('storage-info').textContent = (await storageUsage().catch(() => null)) ?? '';
  offlineBtn.textContent = state.route ? 'ルート周辺の地図を保存' : '表示中の範囲を保存';
}
