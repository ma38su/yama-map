/**
 * ボトムシート：カードを上下にドラッグ（またはタップ）すると詳細が開閉する。
 * 開いても画面上部の地図ボタンは隠さない。中身はスクロールできる。
 */
export class BottomSheet {
  private open = false;
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
      if (this.open) this.body.style.height = `${this.maxHeight()}px`;
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** 開いたときの高さ。画面上部（状態表示・地図のボタン）にはかからないようにする */
  private maxHeight(): number {
    const sheet = this.body.parentElement!;
    const collapsed = sheet.getBoundingClientRect().height - this.body.getBoundingClientRect().height;
    return Math.max(160, Math.round(window.innerHeight - collapsed - 210));
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.body.hidden = false;
    this.body.style.height = `${open ? this.maxHeight() : 0}px`;
    this.handle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('sheet-open', open);
    this.handle.setAttribute('aria-label', open ? '詳細を閉じる' : '詳細を開く');
    if (!open) {
      // 閉じきったら非表示（スクリーンリーダー・タブ移動の対象外に）
      const done = () => {
        if (!this.open) this.body.hidden = true;
      };
      this.body.addEventListener('transitionend', done, { once: true });
      setTimeout(done, 400);
    }
    this.onChange(open);
  }

  toggle(): void {
    this.setOpen(!this.open);
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
    this.body.style.height = `${Math.max(0, Math.min(this.maxHeight(), d.h0 - dy))}px`;
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
    const open = v < -0.4 ? true : v > 0.4 ? false : h > this.maxHeight() / 3;
    this.setOpen(open);
  }
}
