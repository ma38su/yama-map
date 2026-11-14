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
}

export interface GpxData {
  name?: string;
  lines: GpxLine[];
  waypoints: GpxWaypoint[];
}

function childText(el: Element, tag: string): string | undefined {
  for (const c of Array.from(el.children)) {
    if (c.localName === tag) return c.textContent?.trim() || undefined;
  }
  return undefined;
}

function readPoint(el: Element): GpxPoint | null {
  const lat = Number.parseFloat(el.getAttribute('lat') ?? '');
  const lng = Number.parseFloat(el.getAttribute('lon') ?? '');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const p: GpxPoint = { lng, lat };
  const ele = Number.parseFloat(childText(el, 'ele') ?? '');
  if (Number.isFinite(ele)) p.ele = ele;
  const time = Date.parse(childText(el, 'time') ?? '');
  if (Number.isFinite(time)) p.time = time;
  return p;
}

/** 名前空間・接頭辞に関係なく、要素名（localName）で子孫要素を集める */
const byTag = (root: Element, tag: string) =>
  Array.from(root.getElementsByTagName('*')).filter((e) => e.localName === tag);

export function parseGpx(xml: string): GpxData {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('GPXファイルを読み込めませんでした');
  }
  const root = doc.documentElement;
  const metadata = byTag(root, 'metadata')[0];
  const lines: GpxLine[] = [];
  for (const trk of byTag(root, 'trk')) {
    const points = byTag(trk, 'trkpt')
      .map(readPoint)
      .filter((p): p is GpxPoint => p != null);
    if (points.length > 0) lines.push({ name: childText(trk, 'name'), points });
  }
  for (const rte of byTag(root, 'rte')) {
    const points = byTag(rte, 'rtept')
      .map(readPoint)
      .filter((p): p is GpxPoint => p != null);
    if (points.length > 0) lines.push({ name: childText(rte, 'name'), points });
  }
  const waypoints: GpxWaypoint[] = [];
  for (const wpt of byTag(root, 'wpt')) {
    const p = readPoint(wpt);
    if (p) waypoints.push({ ...p, name: childText(wpt, 'name') });
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

export function toGpx(name: string, points: GpxPoint[]): string {
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
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}
