/** GPX の読み込み・書き出し */

export interface GpxPoint {
  lng: number;
  lat: number;
  ele?: number;
  /** 時刻 (ms) */
  time?: number;
}

export interface GpxLine {
  name?: string;
  points: GpxPoint[];
}

export interface GpxWaypoint extends GpxPoint {
  name?: string;
  /** 説明（desc、なければ cmt） */
  desc?: string;
  /** 関連するページ（link の href） */
  link?: string;
}

export interface GpxData {
  name?: string;
  lines: GpxLine[];
  waypoints: GpxWaypoint[];
}

/** 子要素のうち、要素名（localName）が tag の最初のものの文字（配列を作らずに兄弟をたどる） */
function childText(el: Element, tag: string): string | undefined {
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === tag) return c.textContent?.trim() || undefined;
  }
  return undefined;
}

/** 点（緯度・経度と、子要素の標高・時刻）。点の数だけ呼ぶので、子要素は1回だけたどる */
function readPoint(el: Element): GpxPoint | null {
  const lat = Number.parseFloat(el.getAttribute('lat') ?? '');
  const lng = Number.parseFloat(el.getAttribute('lon') ?? '');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const p: GpxPoint = { lng, lat };
  let eleText: string | undefined;
  let timeText: string | undefined;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === 'ele') eleText ??= c.textContent?.trim() ?? '';
    else if (c.localName === 'time') timeText ??= c.textContent?.trim() ?? '';
  }
  const ele = Number.parseFloat(eleText ?? '');
  if (Number.isFinite(ele)) p.ele = ele;
  const time = Date.parse(timeText ?? '');
  if (Number.isFinite(time)) p.time = time;
  return p;
}

/**
 * 名前空間・接頭辞に関係なく、要素名（localName）が tags のどれかの子孫要素を、要素名ごとに集める。
 * 子孫を1回だけたどる（要素名ごとに文書全体を並べ直さない）
 */
function byTags(root: Element, tags: string[]): Map<string, Element[]> {
  const out = new Map(tags.map((t) => [t, [] as Element[]]));
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) out.get(all[i].localName)?.push(all[i]);
  return out;
}
const byTag = (root: Element, tag: string) => byTags(root, [tag]).get(tag)!;

export function parseGpx(xml: string): GpxData {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('GPXファイルを読み込めませんでした');
  }
  const root = doc.documentElement;
  const top = byTags(root, ['metadata', 'trk', 'rte', 'wpt']);
  const metadata = top.get('metadata')![0];
  const lines: GpxLine[] = [];
  for (const trk of top.get('trk')!) {
    const points = byTag(trk, 'trkpt')
      .map(readPoint)
      .filter((p): p is GpxPoint => p != null);
    if (points.length > 0) lines.push({ name: childText(trk, 'name'), points });
  }
  for (const rte of top.get('rte')!) {
    const points = byTag(rte, 'rtept')
      .map(readPoint)
      .filter((p): p is GpxPoint => p != null);
    if (points.length > 0) lines.push({ name: childText(rte, 'name'), points });
  }
  const waypoints: GpxWaypoint[] = [];
  for (const wpt of top.get('wpt')!) {
    const p = readPoint(wpt);
    if (!p) continue;
    let link: string | undefined;
    for (let c = wpt.firstElementChild; c && link == null; c = c.nextElementSibling) if (c.localName === 'link') link = c.getAttribute('href') ?? undefined;
    waypoints.push({ ...p, name: childText(wpt, 'name'), desc: childText(wpt, 'desc') ?? childText(wpt, 'cmt'), link });
  }
  if (lines.length === 0 && waypoints.length === 0) {
    throw new Error('GPXに経路・地点が含まれていません');
  }
  return {
    name: (metadata && childText(metadata, 'name')) ?? lines[0]?.name,
    lines,
    waypoints,
  };
}

const esc = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export function toGpx(name: string, points: GpxPoint[], waypoints: GpxWaypoint[] = []): string {
  const wpts = waypoints
    .map((w) => {
      const ele = w.ele != null ? `<ele>${w.ele.toFixed(1)}</ele>` : '';
      return `  <wpt lat="${w.lat.toFixed(7)}" lon="${w.lng.toFixed(7)}">${ele}<name>${esc(w.name ?? '')}</name></wpt>\n`;
    })
    .join('');
  const pts = points
    .map((p) => {
      const ele = p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : '';
      const time = p.time != null ? `<time>${new Date(p.time).toISOString()}</time>` : '';
      return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}">${ele}${time}</trkpt>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="yama-map" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name></metadata>
${wpts}  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}
