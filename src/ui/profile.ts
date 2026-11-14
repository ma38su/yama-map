/** 標高グラフ（距離-標高）。タップ/なぞった位置を地図に連動させる */
import { formatDistance } from '../geo';

export class ElevationProfile {
  private dists: number[] = [];
  private eles: (number | null)[] = [];
  private hover: number | null = null;
  private marker: number | null = null;
  private ticks: { d: number; kind: string; label: string }[] = [];
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onHover: (index: number | null) => void,
  ) {
    this.ctx = canvas.getContext('2d')!;
    const pick = (e: PointerEvent) => {
      if (this.dists.length < 2) return;
      const rect = canvas.getBoundingClientRect();
      const { left, right } = this.plotArea(rect.width);
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - left) / (rect.width - left - right)));
      const target = ratio * this.dists[this.dists.length - 1];
      let lo = 0;
      let hi = this.dists.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.dists[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      this.hover = lo;
      this.draw();
      this.onHover(lo);
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      pick(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons > 0 || e.pointerType === 'mouse') pick(e);
    });
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.draw();
      this.onHover(null);
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setData(dists: number[], eles: (number | null)[]): void {
    this.dists = dists;
    this.eles = eles;
    if (this.hover != null && this.hover >= dists.length) this.hover = null;
    this.draw();
  }

  /** 経由地・目的地の位置（距離 m）を縦線で示す */
  setTicks(ticks: { d: number; kind: string; label: string }[]): void {
    this.ticks = ticks;
    this.draw();
  }

  /** 現在地をグラフ上に示す（ルートの何番目の点か） */
  setMarker(index: number | null): void {
    if (index === this.marker) return;
    this.marker = index;
    this.draw();
  }

  private plotArea(_width: number) {
    return { left: 44, right: 10, top: 10, bottom: 20 };
  }

  draw(): void {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const valid = this.eles.filter((e): e is number => e != null);
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#5b6470';
    if (this.dists.length < 2 || valid.length < 2) {
      ctx.textAlign = 'center';
      ctx.fillText('標高データがまだありません', w / 2, h / 2);
      return;
    }
    const pad = this.plotArea(w);
    const total = this.dists[this.dists.length - 1] || 1;
    let min = Math.min(...valid);
    let max = Math.max(...valid);
    const span = Math.max(50, max - min);
    min = Math.floor((min - span * 0.08) / 10) * 10;
    max = Math.ceil((max + span * 0.08) / 10) * 10;
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;
    const sx = (d: number) => pad.left + (d / total) * pw;
    const sy = (e: number) => pad.top + (1 - (e - min) / (max - min)) * ph;

    // 目盛り
    ctx.strokeStyle = '#e3e6ea';
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const step = niceStep((max - min) / 3);
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
      const y = Math.round(sy(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.fillText(`${v}m`, pad.left - 4, y);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('0', pad.left, h - 5);
    ctx.textAlign = 'right';
    ctx.fillText(formatDistance(total), w - pad.right, h - 5);

    // 塗りと線
    const path = new Path2D();
    let started = false;
    let firstX = 0;
    let lastX = 0;
    for (let i = 0; i < this.dists.length; i++) {
      const e = this.eles[i];
      if (e == null) continue;
      const x = sx(this.dists[i]);
      const y = sy(e);
      if (!started) {
        path.moveTo(x, y);
        firstX = x;
        started = true;
      } else path.lineTo(x, y);
      lastX = x;
    }
    const fill = new Path2D(path);
    fill.lineTo(lastX, pad.top + ph);
    fill.lineTo(firstX, pad.top + ph);
    fill.closePath();
    ctx.fillStyle = 'rgba(22, 128, 92, 0.18)';
    ctx.fill(fill);
    ctx.strokeStyle = '#16805c';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke(path);

    // 経由地・目的地
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    let lastLabelX = -Infinity;
    for (const t of this.ticks) {
      if (t.d < 0 || t.d > total) continue;
      const x = Math.round(sx(t.d)) + 0.5;
      const color = t.kind === 'dest' ? '#d6334a' : t.kind === 'start' ? '#16805c' : '#2563eb';
      ctx.strokeStyle = color;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + ph);
      ctx.stroke();
      ctx.setLineDash([]);
      // 近すぎる地点の名前は重なるので省く（縦線は残す）
      if (x - lastLabelX < 64) continue;
      lastLabelX = x;
      ctx.fillStyle = color;
      ctx.textAlign = x > w - 60 ? 'right' : x < pad.left + 20 ? 'left' : 'center';
      ctx.fillText(t.label.slice(0, 8), x, pad.top + 1);
    }
    ctx.textBaseline = 'alphabetic';

    // 現在地
    if (this.marker != null && this.marker < this.dists.length) {
      const e = nearestValid(this.eles, this.marker);
      if (e != null) {
        const x = sx(this.dists[this.marker]);
        ctx.fillStyle = '#d6334a';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, sy(e), 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // カーソル
    if (this.hover != null) {
      const e = nearestValid(this.eles, this.hover);
      const x = sx(this.dists[this.hover]);
      ctx.strokeStyle = '#1f2933';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + ph);
      ctx.stroke();
      if (e != null) {
        ctx.fillStyle = '#1f2933';
        ctx.beginPath();
        ctx.arc(x, sy(e), 4, 0, Math.PI * 2);
        ctx.fill();
        const label = `${formatDistance(this.dists[this.hover])}  ${Math.round(e).toLocaleString()}m`;
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.textAlign = x > w / 2 ? 'right' : 'left';
        ctx.fillText(label, x + (x > w / 2 ? -8 : 8), pad.top + 12);
      }
    }
  }
}

function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function nearestValid(eles: (number | null)[], i: number): number | null {
  for (let d = 0; d < eles.length; d++) {
    if (eles[i - d] != null) return eles[i - d]!;
    if (eles[i + d] != null) return eles[i + d]!;
  }
  return null;
}
