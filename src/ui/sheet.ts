/**
 * ボトムシート：カードを上下にドラッグ（またはタップ）すると詳細が開閉する。
 * 止まる高さは3段階：閉じる／半分（画面上部の地図ボタンは隠さない）／全画面（地図は見えなくなる）。
 * 中身はスクロールできる。
 */
export type SheetState = 'closed' | 'half' | 'full';

/** 全画面のときに上に残す余白 (px)。ノッチ・ステータスバーの分は別に足す */
const FULL_TOP_GAP = 8;
/** 半分のときに上に残す高さ (px)。状態表示と地図のボタンがかからないように */
const HALF_TOP_GAP = 210;

export class BottomSheet {
  private state: SheetState = 'closed';
  private drag: { y0: number; h0: number; t0: number; moved: boolean; id: number } | null = null;

  constructor(
    private readonly handle: HTMLElement,
    grips: HTMLElement[],
    private readonly body: HTMLElement,
    private readonly onChange: (open: boolean) => void,
  ) {
    for (const el of [handle, ...grips]) {
      el.addEventListener('pointerdown', (e) => this.start(e, el));
      el.addEventListener('pointermove', (e) => this.move(e));
      el.addEventListener('pointerup', (e) => this.end(e));
      el.addEventListener('pointercancel', (e) => this.end(e));
    }
    window.addEventListener('resize', () => {
      if (this.state !== 'closed') this.body.style.height = `${this.heightOf(this.state)}px`;
    });
  }

  get isOpen(): boolean {
    return this.state !== 'closed';
  }

  /** カードとボタン列など、閉じていても見えている部分の高さ */
  private collapsed(): number {
    const sheet = this.body.parentElement!;
    return sheet.getBoundingClientRect().height - this.body.getBoundingClientRect().height;
  }

  /** ノッチ・ステータスバーの高さ（env(safe-area-inset-top) は JS から直接読めないので、要素に当てて測る） */
  private safeTop(): number {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top);visibility:hidden;pointer-events:none';
    document.body.append(probe);
    const h = probe.getBoundingClientRect().height;
    probe.remove();
    return h;
  }

  private heightOf(state: SheetState): number {
    if (state === 'closed') return 0;
    const room = window.innerHeight - this.collapsed();
    const full = Math.max(160, Math.round(room - this.safeTop() - FULL_TOP_GAP));
    return state === 'full' ? full : Math.min(full, Math.max(160, Math.round(room - HALF_TOP_GAP)));
  }

  setOpen(open: boolean): void {
    this.setState(open ? 'half' : 'closed');
  }

  setState(state: SheetState): void {
    const wasOpen = this.isOpen;
    this.state = state;
    const open = state !== 'closed';
    this.body.hidden = false;
    this.body.style.height = `${this.heightOf(state)}px`;
    this.handle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('sheet-open', open);
    document.body.classList.toggle('sheet-full', state === 'full');
    this.handle.setAttribute('aria-label', open ? '詳細を閉じる' : '詳細を開く');
    if (!open) {
      // 閉じきったら非表示（スクリーンリーダー・タブ移動の対象外に）
      const done = () => {
        if (!this.isOpen) this.body.hidden = true;
      };
      this.body.addEventListener('transitionend', done, { once: true });
      setTimeout(done, 400);
    }
    if (open || wasOpen) this.onChange(open);
  }

  toggle(): void {
    this.setState(this.isOpen ? 'closed' : 'half');
  }

  private start(e: PointerEvent, el: HTMLElement) {
    // カード内のボタンは普通に押せるようにする
    if ((e.target as HTMLElement).closest('button:not(#sheet-handle), a, input')) return;
    el.setPointerCapture(e.pointerId);
    this.body.hidden = false;
    this.drag = { y0: e.clientY, h0: this.body.getBoundingClientRect().height, t0: performance.now(), moved: false, id: e.pointerId };
  }

  private move(e: PointerEvent) {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.abs(dy) < 6) return;
    d.moved = true;
    this.body.classList.add('dragging');
    this.body.style.height = `${Math.max(0, Math.min(this.heightOf('full'), d.h0 - dy))}px`;
  }

  private end(e: PointerEvent) {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    this.body.classList.remove('dragging');
    if (!d.moved) {
      this.toggle(); // タップ
      return;
    }
    const dy = e.clientY - d.y0;
    const v = dy / Math.max(1, performance.now() - d.t0); // px/ms（上方向が負）
    const h = this.body.getBoundingClientRect().height;
    const states: SheetState[] = ['closed', 'half', 'full'];
    // 素早く払ったら、払った向きの次の段へ。ゆっくりなら近い段へ
    let i = states.reduce((best, s, k) => (Math.abs(this.heightOf(s) - h) < Math.abs(this.heightOf(states[best]) - h) ? k : best), 0);
    if (Math.abs(v) > 0.4) {
      const from = states.indexOf(this.state);
      i = Math.max(0, Math.min(2, from + (v < 0 ? 1 : -1)));
    }
    this.setState(states[i]);
  }
}
