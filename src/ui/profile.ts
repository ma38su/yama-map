/**
 * 標高グラフ。横軸は距離と時刻を切り替えられ、ピンチ・ホイール・ボタンで左右に拡大できる。
 * 歩いた記録では、区間ごとのペース（標準より速い＝青、遅い＝赤）と休憩を下の帯に示す。
 * タップ/なぞった位置を地図に連動させる。
 */
import { formatDistance } from '../geo';
import { interp, type PaceSegment, type RestSpan } from '../nav/eta';
import { fmtClock } from './dom';

export type ProfileAxis = 'dist' | 'time';

export interface ProfileSeries {
  dists: number[];
  eles: (number | null)[];
  /** 点ごとの時刻 (ms)。ルートなら到着予想、記録なら実際の時刻 */
  times?: number[] | null;
  /** 経由地・目的地の位置（距離 m） */
  ticks?: { d: number; kind: string; label: string }[];
  /** 記録の区間ごとのペースと休憩 */
  pace?: { segments: PaceSegment[]; rests: RestSpan[] } | null;
}

/** 表示している範囲（全体を 0〜1 として） */
export interface ProfileView {
  from: number;
  to: number;
}

const MIN_SPAN = 0.04; // 最大で25倍まで拡大
const STRIP_H = 44;
const AXIS_H = 18;
const COLORS = {
  grid: '#e3e6ea',
  text: '#5b6470',
  ink: '#1f2933',
  line: '#16805c',
  fill: 'rgba(22, 128, 92, 0.18)',
  /** 歩き終えた部分（現在地より手前） */
  walked: '#9aa3ad',
  walkedFill: 'rgba(122, 132, 145, 0.16)',
  here: '#d6334a',
  rest: 'rgba(91, 100, 112, 0.16)',
  restInk: '#5b6470',
  /** 乗り物の区間（ペースの色は付けない） */
  vehicle: 'rgba(31, 41, 51, 0.07)',
  vehicleInk: '#7a8491',
};

/** ペースの色：標準どおりは灰色、速いほど青、遅いほど赤（ルートの青・記録の赤と同じ色味） */
export function paceColor(ratio: number, alpha = 1): string {
  const t = Math.max(-1, Math.min(1, Math.log2(ratio) / 0.6)); // 標準の1.5倍で真っ赤、0.66倍で真っ青
  const mid = [168, 179, 191];
  const end = t < 0 ? [37, 99, 235] : [214, 51, 74];
  const k = Math.abs(t);
  const [r, g, b] = mid.map((m, i) => Math.round(m + (end[i] - m) * k));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export class ElevationProfile {
  private s: ProfileSeries = { dists: [], eles: [] };
  private key = '';
  private axis: ProfileAxis = 'dist';
  private view: ProfileView = { from: 0, to: 1 };
  private hover: number | null = null;
  private marker: number | null = null;
  private markerLabel: string | null = null;
  /**
   * 最後に描いたときの「点の番号 → 印を描く位置（CSS の px に丸めたもの）」と、そのとき描いた印の位置。
   * リプレイでは点が1つ進むたびに印が動くが、同じ px に描くなら描き直さない（グラフ全体を描き直すことになるので。
   * 1px より細かい動きは見て分からない。現在地の縦線も px に合わせて描いている）
   */
  private markerKeyOf: ((i: number | null) => string) | null = null;
  private drawnMarkerKey = '';
  /** canvas の表示の大きさ（ResizeObserver で覚える。描くたびに読むと、直前に書き換えた画面のレイアウトをやり直させるため） */
  private cssW = 0;
  private cssH = 0;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; cx: number; view: ProfileView } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onHover: (index: number | null) => void,
    private readonly onView: (view: ProfileView) => void = () => undefined,
  ) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) this.startPinch();
      else this.pick(e.clientX);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.pointers.size === 2) this.movePinch();
      else if (!this.pinch && (e.buttons > 0 || e.pointerType === 'mouse')) this.pick(e.clientX);
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.hover = null;
      this.draw();
      this.onHover(null);
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (this.s.dists.length < 2) return;
        const span = this.view.to - this.view.from;
        const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
        // 拡大はトラックパッドのピンチ（ctrlKey 付きで届く）か Ctrl/⌘+ホイール。
        // 普通の縦ホイールはシートのスクロールに使う
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.zoom(Math.exp(-e.deltaY * 0.01), this.ratioAt(e.clientX));
        } else if (sideways && span < 1) {
          e.preventDefault();
          this.setPosition(this.view.from + ((e.deltaX || e.deltaY) / this.plotWidth()) * span);
        }
      },
      { passive: false },
    );
    new ResizeObserver(() => {
      this.cssW = canvas.clientWidth;
      this.cssH = canvas.clientHeight;
      this.draw();
    }).observe(canvas);
  }

  /**
   * グラフにするデータを差し替える。key が変わったとき（別のルート・記録になったとき）だけ拡大を戻す。
   * 記録中に点が増えても、拡大したところはそのまま
   */
  setSeries(s: ProfileSeries, key: string): void {
    this.s = s;
    if (this.axis === 'time' && !this.hasTime) this.axis = 'dist';
    if (this.hover != null && this.hover >= s.dists.length) this.hover = null;
    if (key !== this.key) {
      this.key = key;
      this.resetView();
    } else this.draw();
  }

  get hasTime(): boolean {
    return !!this.s.times && this.s.times.length === this.s.dists.length;
  }

  get currentAxis(): ProfileAxis {
    return this.axis;
  }

  get currentView(): ProfileView {
    return this.view;
  }

  setAxis(axis: ProfileAxis): void {
    if (axis === 'time' && !this.hasTime) return;
    this.axis = axis;
    this.draw();
  }

  /** 現在地をグラフ上に示す（何番目の点か）。label があれば縦線と名前も出す（リプレイの位置は点だけ） */
  setMarker(index: number | null, label: string | null = null): void {
    if (index === this.marker && label === this.markerLabel) return;
    const moved = label !== this.markerLabel || !this.markerKeyOf || this.markerKeyOf(index) !== this.drawnMarkerKey;
    this.marker = index;
    this.markerLabel = label;
    if (moved) this.draw();
  }

  /** factor 倍に拡大（1未満で縮小）。center は拡大の中心（表示範囲の中の位置 0〜1） */
  zoom(factor: number, center = 0.5): void {
    const { from, to } = this.view;
    const span = Math.max(MIN_SPAN, Math.min(1, (to - from) / factor));
    const at = from + (to - from) * center;
    this.setView(at - span * center, at - span * center + span);
  }

  resetView(): void {
    this.setView(0, 1);
  }

  /** 表示範囲の左端を動かす（幅はそのまま） */
  setPosition(from: number): void {
    const span = this.view.to - this.view.from;
    this.setView(from, from + span);
  }

  private setView(from: number, to: number): void {
    const span = Math.max(MIN_SPAN, Math.min(1, to - from));
    const f = Math.max(0, Math.min(1 - span, from));
    this.view = { from: f, to: f + span };
    this.draw();
    this.onView(this.view);
  }

  private startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.pinch = { dist: Math.max(20, Math.abs(a.x - b.x)), cx: (a.x + b.x) / 2, view: { ...this.view } };
    this.hover = null;
    this.onHover(null);
  }

  private movePinch() {
    const p = this.pinch!;
    const [a, b] = [...this.pointers.values()];
    const dist = Math.max(20, Math.abs(a.x - b.x));
    const cx = (a.x + b.x) / 2;
    const span0 = p.view.to - p.view.from;
    const span = Math.max(MIN_SPAN, Math.min(1, (span0 * p.dist) / dist));
    // 指の中点の下にある位置を保ったまま拡大し、中点の移動ぶん横に動かす
    const at = p.view.from + span0 * this.ratioAt(p.cx);
    const from = at - span * this.ratioAt(cx);
    this.setView(from, from + span);
  }

  private plotArea() {
    return { left: 44, right: 10, top: 10 };
  }

  private plotWidth(): number {
    const { left, right } = this.plotArea();
    return Math.max(1, (this.cssW || this.canvas.clientWidth) - left - right);
  }

  /** 画面の x 座標が、表示範囲の中のどこか（0〜1） */
  private ratioAt(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left - this.plotArea().left) / this.plotWidth()));
  }

  /** 点 i の横軸の値 */
  private xs(): number[] {
    return this.axis === 'time' && this.hasTime ? this.s.times! : this.s.dists;
  }

  private range(): [number, number] {
    const xs = this.xs();
    const lo = xs[0] ?? 0;
    const hi = xs[xs.length - 1] ?? 1;
    const full = Math.max(1, hi - lo);
    return [lo + full * this.view.from, lo + full * this.view.to];
  }

  private pick(clientX: number) {
    const xs = this.xs();
    if (xs.length < 2) return;
    const [v0, v1] = this.range();
    const target = v0 + this.ratioAt(clientX) * (v1 - v0);
    let lo = 0;
    let hi = xs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    // なぞっていても同じ点なら、描き直しも地図のカーソルの更新もしない
    if (lo === this.hover) return;
    this.hover = lo;
    this.draw();
    this.onHover(lo);
  }

  draw(): void {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = this.cssW;
    const h = this.cssH;
    this.markerKeyOf = null;
    if (w === 0 || h === 0) return;
    // 大きさが変わったときだけ設定し直す（設定するたびに描画用のメモリが取り直される）
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const { dists, eles } = this.s;
    // 標高の最小・最大（Math.min(...配列) は点が多いと引数の上限を超えるので1つずつ）
    let valid = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const e of eles) {
      if (e == null) continue;
      valid++;
      if (e < min) min = e;
      if (e > max) max = e;
    }
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = COLORS.text;
    if (dists.length < 2 || valid < 2) {
      ctx.textAlign = 'center';
      ctx.fillText('標高データがまだありません', w / 2, h / 2);
      return;
    }
    const pace = this.s.pace?.segments.length ? this.s.pace : null;
    const pad = { ...this.plotArea(), bottom: AXIS_H + (pace ? STRIP_H : 0) };
    const xs = this.xs();
    const isTime = xs !== dists;
    const [v0, v1] = this.range();
    const span = Math.max(50, max - min);
    min = Math.floor((min - span * 0.08) / 10) * 10;
    max = Math.ceil((max + span * 0.08) / 10) * 10;
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;
    const sx = (v: number) => pad.left + ((v - v0) / (v1 - v0)) * pw;
    const sy = (e: number) => pad.top + (1 - (e - min) / (max - min)) * ph;
    /** 距離 d (m) の横軸の値 */
    const xOfDist = (d: number) => (isTime ? interp(dists, xs, d) : d);
    // 印を描く位置（px）。setMarker で、印が同じ位置のままなら描き直さないのに使う
    this.markerKeyOf = (i) => {
      if (i == null || i >= dists.length) return '';
      const e = nearestValid(eles, i);
      return `${Math.round(sx(xs[i]))},${e == null ? '' : Math.round(sy(e))}`;
    };
    this.drawnMarkerKey = this.markerKeyOf(this.marker);

    // 標高の目盛り
    ctx.strokeStyle = COLORS.grid;
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

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, 0, pw, h);
    ctx.clip();

    // 横軸の目盛り（距離は km、時刻は 30分・1時間おき）
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    const axisY = h - 5;
    const xStep = isTime ? timeStep((v1 - v0) / Math.max(2, pw / 70)) : niceStep((v1 - v0) / Math.max(2, pw / 70));
    // 時刻の目盛りはローカル時刻の区切り（9:00, 9:30…）にそろえる
    const tz = isTime ? -new Date(v0).getTimezoneOffset() * 60_000 : 0;
    for (let v = Math.ceil((v0 + tz) / xStep) * xStep - tz; v <= v1; v += xStep) {
      const x = Math.round(sx(v)) + 0.5;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + ph);
      ctx.stroke();
      ctx.fillStyle = COLORS.text;
      // 端の目盛りの文字は、はみ出さないよう内側に寄せる
      ctx.textAlign = x < pad.left + 24 ? 'left' : x > w - pad.right - 24 ? 'right' : 'center';
      ctx.fillText(isTime ? fmtClock(v) : formatDistance(v), x, axisY);
    }

    // 休憩（時刻の軸では幅のある帯）
    const rests = this.s.pace?.rests ?? [];
    if (isTime) {
      for (const r of rests) {
        const x0 = sx(r.t0);
        const x1 = sx(r.t1);
        if (x1 < pad.left || x0 > w) continue;
        ctx.fillStyle = COLORS.rest;
        ctx.fillRect(x0, pad.top, x1 - x0, h - pad.top - AXIS_H);
      }
    }

    // 塗りと線。記録ではペースの色で塗る
    const path = new Path2D();
    let started = false;
    let firstX = 0;
    let lastX = 0;
    for (let i = 0; i < dists.length; i++) {
      const e = eles[i];
      if (e == null) continue;
      const x = sx(xs[i]);
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
    if (pace) {
      ctx.save();
      ctx.clip(fill);
      for (const seg of pace.segments) {
        const x0 = sx(isTime ? seg.t0 : seg.d0);
        const x1 = sx(isTime ? seg.t1 : seg.d1);
        ctx.fillStyle = seg.vehicle ? COLORS.vehicle : paceColor(seg.ratio, 0.32);
        ctx.fillRect(x0, pad.top, x1 - x0 + 0.5, ph);
      }
      ctx.restore();
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.stroke(path);
    } else {
      // 現在地より手前（歩き終えた部分）は灰色、先は緑
      const mx = this.marker != null && this.marker < dists.length ? sx(xs[this.marker]) : null;
      const parts: [number, number, string, string][] =
        mx == null ? [[0, w, COLORS.fill, COLORS.line]] : [[0, mx, COLORS.walkedFill, COLORS.walked], [mx, w, COLORS.fill, COLORS.line]];
      for (const [x0, x1, fillColor, lineColor] of parts) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, 0, x1 - x0, h);
        ctx.clip();
        ctx.fillStyle = fillColor;
        ctx.fill(fill);
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke(path);
        ctx.restore();
      }
    }

    // ペースの帯：棒の高さは速さ（標準を真ん中の線）、色は速い青〜遅い赤
    if (pace) {
      const top = pad.top + ph + 6;
      const base = top + STRIP_H - 8;
      const full = base - top;
      for (const seg of pace.segments) {
        const x0 = sx(isTime ? seg.t0 : seg.d0);
        const x1 = sx(isTime ? seg.t1 : seg.d1);
        if (x1 < pad.left || x0 > w) continue;
        // 乗り物の区間は、ペースの棒の代わりに下に細い帯
        if (seg.vehicle) {
          ctx.fillStyle = COLORS.vehicleInk;
          ctx.fillRect(x0, base - 2, Math.max(1, x1 - x0), 2);
          continue;
        }
        // 休憩を含む区間も、棒は歩いていた速さで描く
        const speed = Math.min(2, 1 / seg.ratio);
        const bh = Math.max(2, (speed / 2) * full);
        ctx.fillStyle = paceColor(seg.ratio);
        ctx.fillRect(x0 + 0.5, base - bh, Math.max(1, x1 - x0 - 1), bh);
      }
      ctx.strokeStyle = 'rgba(31, 41, 51, 0.35)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pad.left, Math.round(base - full / 2) + 0.5);
      ctx.lineTo(w - pad.right, Math.round(base - full / 2) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      // 休憩（距離の軸では、その地点に印）
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let lastLabel = -Infinity;
      for (const r of rests) {
        const min = Math.round((r.t1 - r.t0) / 60_000);
        const x = isTime ? sx((r.t0 + r.t1) / 2) : sx(r.d);
        if (x < pad.left - 10 || x > w + 10) continue;
        if (!isTime) {
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = COLORS.restInk;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, top + 7, 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = COLORS.restInk;
          ctx.fillText('休', x, top + 7.5);
        }
        if (x - lastLabel < 30) continue;
        lastLabel = x;
        ctx.fillStyle = COLORS.restInk;
        ctx.fillText(`${min}分`, x, isTime ? pad.top + 8 : top + 21);
      }
    }

    // 経由地・目的地
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    let lastLabelX = -Infinity;
    const total = dists[dists.length - 1];
    for (const t of this.s.ticks ?? []) {
      if (t.d < 0 || t.d > total) continue;
      const x = Math.round(sx(xOfDist(t.d))) + 0.5;
      if (x < pad.left || x > w - pad.right) continue;
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

    // 現在地（名前があれば縦線と、点の上に名前）
    if (this.marker != null && this.marker < dists.length) {
      const e = nearestValid(eles, this.marker);
      const x = sx(xs[this.marker]);
      const label = this.markerLabel;
      if (label) {
        ctx.strokeStyle = COLORS.here;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, pad.top);
        ctx.lineTo(Math.round(x) + 0.5, pad.top + ph);
        ctx.stroke();
      }
      if (e != null) {
        const y = sy(e);
        ctx.fillStyle = COLORS.here;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = label ? 2.5 : 2;
        ctx.beginPath();
        ctx.arc(x, y, label ? 6.5 : 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (label) {
          ctx.font = 'bold 11px system-ui, sans-serif';
          const tw = ctx.measureText(label).width + 10;
          const bh = 17;
          // 点の上（上の地点名と重なるときは点の下）。左右ははみ出さないように
          let by = y - 10 - bh;
          if (by < pad.top + 14) by = y + 10;
          const bx = Math.max(pad.left + 1, Math.min(w - pad.right - tw - 1, x - tw / 2));
          ctx.fillStyle = COLORS.here;
          ctx.beginPath();
          ctx.roundRect(bx, by, tw, bh, 8);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, bx + tw / 2, by + bh / 2 + 0.5);
          ctx.textBaseline = 'alphabetic';
        }
      }
    }
    ctx.restore();

    // カーソル
    if (this.hover != null) {
      const i = this.hover;
      const e = nearestValid(eles, i);
      const x = sx(xs[i]);
      if (x >= pad.left && x <= w - pad.right) {
        ctx.strokeStyle = COLORS.ink;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, h - AXIS_H);
        ctx.stroke();
        if (e != null) {
          ctx.fillStyle = COLORS.ink;
          ctx.beginPath();
          ctx.arc(x, sy(e), 4, 0, Math.PI * 2);
          ctx.fill();
          const parts = [formatDistance(dists[i]), `${Math.round(e).toLocaleString()}m`];
          if (this.hasTime) parts.push(fmtClock(this.s.times![i]));
          const seg = pace?.segments.find((sg) => dists[i] >= sg.d0 && dists[i] <= sg.d1);
          if (seg) parts.push(seg.vehicle ? '乗り物' : `標準タイムの${seg.ratio.toFixed(1)}倍`);
          ctx.font = 'bold 12px system-ui, sans-serif';
          const label = parts.join('  ');
          const right = x > w / 2;
          ctx.textAlign = right ? 'right' : 'left';
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
          ctx.fillRect(right ? x - 10 - tw : x + 6, pad.top + 2, tw + 4, 16);
          ctx.fillStyle = COLORS.ink;
          ctx.fillText(label, x + (right ? -8 : 8), pad.top + 14);
        }
      }
    }
  }
}

function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

/** 時刻の目盛りの間隔 (ms)：10分・15分・30分・1時間・2時間… */
function timeStep(raw: number): number {
  const min = 60_000;
  for (const m of [5, 10, 15, 30, 60, 120, 180, 360]) if (m * min >= raw) return m * min;
  return 720 * min;
}

function nearestValid(eles: (number | null)[], i: number): number | null {
  for (let d = 0; d < eles.length; d++) {
    if (eles[i - d] != null) return eles[i - d]!;
    if (eles[i + d] != null) return eles[i + d]!;
  }
  return null;
}
