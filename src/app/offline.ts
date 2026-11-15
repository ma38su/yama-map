/**
 * オフライン用に地図タイル・道データ・場所の情報（写真の縮小画像も）を保存する。
 *  - ルート沿い：ルートの両側の帯（片側 500m・1km・2km）だけを保存する（ルートを囲む長方形全体ではなく）
 *  - 表示中の範囲：真上から見たときの表示範囲
 * 保存した範囲は一覧（メニュー）と地図（地図に重ねる情報の「保存した範囲」）で確かめられ、範囲ごとに消せる
 */
import { bbox, densify, viewBounds, type LngLat } from '../geo';
import { log } from '../log';
import { BASE_LAYERS } from '../map/style';
import { aroundPoint, nearRoute } from '../offline/corridor';
import {
  MAX_TILES,
  clearTileCache,
  deleteSaved,
  downloadLayers,
  downloadTiles,
  planCorridorTiles,
  planTiles,
  storageUsage,
} from '../offline/download';
import { placeCellsIn } from '../places/sources';
import { OSM_ZOOM, osmTileTemplate, osmTileUrls } from '../route/roadTiles';
import { saveSettings, settings } from '../settings';
import { clearAreas, deleteArea, listAreas, putArea, type SavedArea } from '../track/db';
import { $, checkSeg, h, segButtons } from '../ui/dom';
import { map } from './mapView';
import { ensurePlaces, importedItems, setLayer } from './places';
import { refreshSaved, showSaved } from './savedAreas';
import { state } from './state';

const routeBtn = $<HTMLButtonElement>('btn-offline-route');
const viewBtn = $<HTMLButtonElement>('btn-offline');
const offlineInfo = $('offline-info');
const offlineProgress = $<HTMLProgressElement>('offline-progress');
let downloading: AbortController | null = null;

/** 写真の縮小画像を保存する枚数の上限（1枚 20〜80KB） */
const MAX_THUMBS = 300;
const BUFFERS = [500, 1000, 2000] as const;
const bufferM = () => ((BUFFERS as readonly number[]).includes(settings.offlineBufferM ?? 0) ? settings.offlineBufferM! : 1000);
const bufferLabel = (m: number) => (m < 1000 ? `${m} m` : `${m / 1000} km`);

const bufferSeg = $('offline-buffer');
segButtons(bufferSeg, BUFFERS.map((m) => [String(m), bufferLabel(m)] as const), (id) => {
  settings.offlineBufferM = Number(id);
  saveSettings();
  checkSeg(bufferSeg, id);
});
checkSeg(bufferSeg, String(bufferM()));

interface Plan {
  kind: SavedArea['kind'];
  name: string;
  bounds: [number, number, number, number];
  urls: string[];
  cells: string[];
  /** 写真を残す場所か */
  near: (p: LngLat) => boolean;
  bufferM?: number;
}

async function planRoute(coords: LngLat[], name: string): Promise<Plan> {
  const m = bufferM();
  const layers = downloadLayers(BASE_LAYERS[settings.base].url, 16);
  const urls = planCorridorTiles(coords, m, layers);
  // ルート検索用の OpenStreetMap の道データも、帯の分だけ
  const osm = await osmTileTemplate().catch(() => null);
  if (osm) urls.push(...planCorridorTiles(coords, m, [{ template: osm, minZoom: OSM_ZOOM, maxZoom: OSM_ZOOM }]));
  // 場所の情報のマス目：帯にかかるもの
  const cells = new Set<string>();
  for (const p of densify(coords, 1000)) for (const c of placeCellsIn(aroundPoint(p, m), 9)) cells.add(c);
  const [bw, bs, be, bn] = bbox(coords);
  const [w, s] = aroundPoint([bw, bs], m);
  const [, , e, n] = aroundPoint([be, bn], m);
  const dense = densify(coords, 100);
  return { kind: 'route', name, bounds: [w, s, e, n], urls, cells: [...cells], near: (p) => nearRoute(dense, p, m), bufferM: m };
}

async function planView(): Promise<Plan> {
  const c = map.getCenter();
  const canvas = map.getCanvas();
  const bounds = viewBounds([c.lng, c.lat], map.getZoom(), canvas.clientWidth, canvas.clientHeight);
  const urls = planTiles(bounds, downloadLayers(BASE_LAYERS[settings.base].url, 16));
  urls.push(...(await osmTileUrls(bounds).catch(() => [])).map((t) => t.url));
  const [w, s, e, n] = bounds;
  return {
    kind: 'view',
    name: `表示中の範囲（${c.lat.toFixed(3)}, ${c.lng.toFixed(3)} 付近）`,
    bounds,
    urls,
    // 地図と同じ範囲を残す（16マスで打ち切ると、広く表示しているときに外側の場所の情報が抜けていた。範囲の広さは MAX_TILES で抑えている）
    cells: placeCellsIn(bounds),
    near: ([lng, lat]) => lng >= w && lng <= e && lat >= s && lat <= n,
  };
}

const setButtons = (busy: boolean, active?: HTMLButtonElement) => {
  routeBtn.textContent = busy && active === routeBtn ? '中止' : 'ルート沿いを保存';
  viewBtn.textContent = busy && active === viewBtn ? '中止' : '表示中の範囲を保存';
  routeBtn.disabled = (busy && active !== routeBtn) || (!busy && !state.route);
  viewBtn.disabled = busy && active !== viewBtn;
};

async function save(kind: 'route' | 'view', btn: HTMLButtonElement) {
  if (downloading) {
    downloading.abort();
    return;
  }
  const route = state.route;
  if (kind === 'route' && !route) return;
  const plan = kind === 'route' && route ? await planRoute(route.coords, `ルート沿い（片側${bufferLabel(bufferM())}）：${route.name}`) : await planView();
  const n = plan.urls.length;
  if (n > MAX_TILES) {
    alert(
      `範囲が広すぎます（${n.toLocaleString()}枚）。${kind === 'route' ? '幅を狭くするか、ルートを分けて' : '地図を拡大してから'}保存してください。`,
    );
    return;
  }
  const mb = Math.max(1, Math.round((n * 30) / 1024));
  const what = kind === 'route' ? `ルートの両側 ${bufferLabel(bufferM())} の地図` : '表示中の範囲の地図';
  if (!confirm(`${what}（ズーム16まで）を保存します。\n約${n.toLocaleString()}枚・目安 ${mb} MB（ほかに山小屋・水場・写真などの情報）\nWi-Fi環境での実行がおすすめです。`)) return;
  downloading = new AbortController();
  const signal = downloading.signal;
  setButtons(true, btn);
  offlineProgress.hidden = false;
  const progress = (label: string) => (p: { done: number; total: number }) => {
    offlineProgress.max = p.total;
    offlineProgress.value = p.done;
    offlineInfo.textContent = `${label}… ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`;
  };
  try {
    // 1. 地図（先に保存する。場所の情報を Overpass から取れないとき、保存した OpenFreeMap の地図データから山小屋などを出すため）
    const tiles = await downloadTiles(plan.urls, progress('地図を保存中'), signal);
    // 2. 場所の情報（地図に出す種類に関係なく、すべての種類。圏外で切り替えられるように）
    if (!signal.aborted) {
      offlineProgress.removeAttribute('value');
      offlineInfo.textContent = '山小屋・水場・写真などの情報を保存中…（混んでいると1分ほどかかります）';
    }
    const places = signal.aborted ? { items: [], failed: [], partial: [] } : await ensurePlaces(plan.cells, signal);
    // 3. 写真の縮小画像（範囲の中のものだけ）
    const thumbs = [...new Set([...places.items, ...importedItems()].filter((it) => it.thumb?.startsWith('https://') && plan.near(it.lngLat)).map((it) => it.thumb!))].slice(0, MAX_THUMBS);
    const photos = signal.aborted ? { failed: 0 } : await downloadTiles(thumbs, progress('写真を保存中'), signal);
    if (signal.aborted) {
      offlineInfo.textContent = '中止しました（途中まで保存した地図は残ります）';
      return;
    }
    const failed = tiles.failed + photos.failed;
    // 同じ範囲（同じルート・同じ幅）を保存し直したときは、一覧の1件にまとめる（前の分の地図・写真も、この範囲のものとして残す）
    const same = (await listAreas()).find((a) => a.name === plan.name);
    await putArea({
      id: same?.id ?? crypto.randomUUID(),
      name: plan.name,
      createdAt: Date.now(),
      kind: plan.kind,
      bufferM: plan.bufferM,
      bounds: plan.bounds,
      urls: [...new Set([...(same?.urls ?? []), ...plan.urls, ...thumbs])],
      cells: [...new Set([...(same?.cells ?? []), ...plan.cells])],
      failed,
    });
    const SOURCE_NAMES = { osm: '山の施設', commons: '写真', inat: '生きもの' } as const;
    const notes = [
      failed ? `失敗 ${failed}枚` : '',
      places.failed.length ? `${places.failed.map((s) => SOURCE_NAMES[s]).join('・')}の情報は取れませんでした` : '',
      places.partial.includes('osm') ? '山の施設は OpenStreetMap が混んでいたため名前と種類だけです' : '',
    ].filter(Boolean);
    if (places.failed.length || places.partial.length) notes.push('あとでもう一度保存すると、足りない分だけ取り直します');
    offlineInfo.textContent = `保存しました（地図 ${plan.urls.length.toLocaleString()}枚・写真 ${thumbs.length}枚${notes.length ? `、${notes.join('・')}` : ''}）`;
    log(`オフライン保存: ${plan.kind === 'route' ? `ルート沿い 片側${plan.bufferM}m` : '表示中の範囲'}・地図 ${plan.urls.length}枚・写真 ${thumbs.length}枚・失敗 ${failed}枚`);
  } catch (e) {
    offlineInfo.textContent = `保存できませんでした: ${e instanceof Error ? e.message : e}`;
  } finally {
    downloading = null;
    setButtons(false);
    offlineProgress.hidden = true;
    void refreshStorage();
    void refreshSaved();
  }
}
routeBtn.addEventListener('click', () => void save('route', routeBtn));
viewBtn.addEventListener('click', () => void save('view', viewBtn));

$('btn-cache-clear').addEventListener('click', async () => {
  if (!confirm('保存した地図・写真と、表示したときに残った地図をすべて削除しますか？（記録した軌跡は消えません）')) return;
  await clearTileCache();
  await clearAreas().catch(() => {});
  offlineInfo.textContent = '削除しました';
  void refreshStorage();
  void refreshSaved();
});

/** 保存した範囲の一覧（地図で見る・削除） */
async function refreshAreaList() {
  const list = $('area-list');
  const areas = await listAreas().catch(() => [] as SavedArea[]);
  list.replaceChildren(
    ...areas.map((a) => {
      const li = h('li');
      const date = new Date(a.createdAt);
      li.append(
        h('div', 'title', a.name),
        h('div', 'meta', `${date.toLocaleDateString('ja-JP')} 保存・${a.urls.length.toLocaleString()}枚${a.failed ? `（失敗 ${a.failed}枚）` : ''}`),
      );
      const row = h('div', 'row');
      const show = h('button', 'btn', '地図で見る');
      show.type = 'button';
      show.addEventListener('click', () => {
        $<HTMLDialogElement>('menu').close();
        setLayer('saved', true);
        void showSaved(true);
        const [w, s, e, n] = a.bounds;
        map.fitBounds(
          [
            [w, s],
            [e, n],
          ],
          { padding: 40, maxZoom: 15, duration: 600 },
        );
      });
      const del = h('button', 'btn danger', '削除');
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!confirm(`「${a.name}」で保存した地図・写真を削除しますか？（ほかの範囲と重なる部分は残します）`)) return;
        const others = new Set((await listAreas()).filter((o) => o.id !== a.id).flatMap((o) => o.urls));
        const n = await deleteSaved(a.urls.filter((u) => !others.has(u)));
        await deleteArea(a.id);
        log(`保存した範囲を削除: ${n}枚`);
        offlineInfo.textContent = `削除しました（${n.toLocaleString()}枚）`;
        void refreshStorage();
        void refreshSaved();
      });
      row.append(show, del);
      li.append(row);
      return li;
    }),
  );
}

export async function refreshStorage() {
  $('storage-info').textContent = (await storageUsage().catch(() => null)) ?? '';
  if (!downloading) setButtons(false);
  $('offline-buffer-field').hidden = !state.route;
  await refreshAreaList();
}
