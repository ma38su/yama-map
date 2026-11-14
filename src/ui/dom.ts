/** 画面を組み立てる小さな道具と、数値の表示の形 */

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};
export const fmtM = (m: number | null | undefined) => (m == null ? '–' : `${Math.round(m).toLocaleString('ja-JP')} m`);
export const fmtClock = (ms: number) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};
/** 分 → 「1時間05分」「38分」 */
export const fmtMin = (min: number) => {
  const m = Math.max(0, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)}時間${String(m % 60).padStart(2, '0')}分` : `${m}分`;
};
export const fmtHM = (min: number) => {
  const m = Math.max(0, Math.round(min));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};


export function segButtons(wrap: HTMLElement, items: readonly (readonly [string, string])[], onPick: (id: string) => void) {
  for (const [id, label] of items) {
    const b = h('button', '', label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.id = id;
    b.addEventListener('click', () => onPick(id));
    wrap.append(b);
  }
}
export const checkSeg = (wrap: HTMLElement, id: string) => {
  for (const b of wrap.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(b.dataset.id === id));
};

/** テキストをファイルとして保存させる */
export function download(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
