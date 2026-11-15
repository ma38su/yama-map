/**
 * 地図の右上の「重ねる情報」ボタンと、その画面：種類ごと（山小屋・水場・トイレ・写真・生きもの・読み込んだ場所・保存した範囲）に
 * 表示・非表示を切り替える。自分の場所のファイル（GeoJSON・GPX）の読み込み・削除もここ
 */
import type { IControl } from 'maplibre-gl';
import { PLACE_CATS, PLACE_CAT_IDS, type PlaceCat } from '../places/sources';
import { $, h } from '../ui/dom';
import { map } from './mapView';
import { importPlacesFile, layerOn, placeImports, removeImport, setLayer, type LayerId } from './places';
import { showSaved } from './savedAreas';
import { setProgress, status } from './status';

const dialog = $<HTMLDialogElement>('layers');

class LayersControl implements IControl {
  private container?: HTMLDivElement;
  onAdd(): HTMLElement {
    this.container = h('div', 'maplibregl-ctrl maplibregl-ctrl-group');
    const b = h('button', 'ctrl-layers');
    b.type = 'button';
    b.title = '地図に重ねる情報';
    b.setAttribute('aria-label', '地図に重ねる情報（山小屋・水場・写真など）');
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 8 12 13l9.5-5z"/><path d="M2.5 12.5 12 17.5l9.5-5"/><path d="M2.5 16.5 12 21.5l9.5-5"/></svg>';
    b.addEventListener('click', openLayers);
    this.container.append(b);
    return this.container;
  }
  onRemove() {
    this.container?.remove();
  }
}
map.addControl(new LayersControl(), 'top-right');

/** 種類の切り替え（アイコンの色・絵文字の見本付き） */
function toggleRow(id: LayerId, label: string, icon: string, color: string): HTMLElement {
  const row = h('label', 'toggle layer-row');
  const input = h('input');
  input.type = 'checkbox';
  input.checked = layerOn(id);
  input.addEventListener('change', () => {
    setLayer(id, input.checked);
    if (id === 'saved') void showSaved(input.checked);
  });
  const ic = h('span', 'pl-ic', icon);
  ic.style.background = color;
  row.append(input, ic, h('span', '', label));
  return row;
}

const osmCats = PLACE_CAT_IDS.filter((c) => PLACE_CATS[c].source === 'osm');
const catRow = (c: PlaceCat) => toggleRow(c, PLACE_CATS[c].label, PLACE_CATS[c].icon, PLACE_CATS[c].color);

function renderLayers() {
  $('layers-osm').replaceChildren(...osmCats.map(catRow));
  $('layers-photo').replaceChildren(catRow('photo'), catRow('life'));
  $('layers-mine').replaceChildren(catRow('mine'));
  $('layers-saved').replaceChildren(toggleRow('saved', '保存した範囲（オフラインで使える範囲）', '⬛', '#16805c'));
  const all = $<HTMLButtonElement>('layers-all');
  all.textContent = osmCats.every(layerOn) ? '山の施設をすべて隠す' : '山の施設をすべて出す';
  renderImports();
}

function renderImports() {
  $('import-list').replaceChildren(
    ...placeImports().map((imp) => {
      const li = h('li');
      li.append(h('div', 'title', imp.name), h('div', 'meta', `${new Date(imp.importedAt).toLocaleDateString('ja-JP')} 読み込み・${imp.items.length}件`));
      const row = h('div', 'row');
      const del = h('button', 'btn danger', '削除');
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!confirm(`「${imp.name}」で読み込んだ場所を削除しますか？`)) return;
        await removeImport(imp.id);
        renderImports();
      });
      row.append(del);
      li.append(row);
      return li;
    }),
  );
}

function openLayers() {
  renderLayers();
  dialog.showModal();
}
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});

$('layers-all').addEventListener('click', () => {
  const on = !osmCats.every(layerOn);
  for (const c of osmCats) setLayer(c, on);
  renderLayers();
});

$<HTMLInputElement>('places-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  setProgress('場所のファイルを読み込み中…');
  try {
    status(await importPlacesFile(file));
    dialog.close();
  } catch (err) {
    status(err instanceof Error ? err.message : String(err), true);
  } finally {
    setProgress('');
  }
});
