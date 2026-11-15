/**
 * ボトムシート：カードを上下にドラッグ（またはタップ）すると詳細が開閉する。
 * 止まる高さは4段階：最小（つまみと目的地の1行だけ。地図・3Dを広く見る）／閉じる／半分（画面上部の地図ボタンは隠さない）／
 * 全画面（地図は見えなくなる）。中身はスクロールできる。
 */
export type SheetState = 'mini' | 'closed' | 'half' | 'full';

/** 開閉の段（下から順に） */
const STATES: SheetState[] = ['mini', 'closed', 'half', 'full'];
/** 「閉じる」からこれ以上下へ引いたら「最小」にする (px) */
const MINI_PULL = 40;

/** 全画面のときに上に残す余白 (px)。ノッチ・ステータスバーの分は別に足す */
const FULL_TOP_GAP = 8;
/** 半分のときに上に残す高さ (px)。状態表示と地図のボタンがかからないように */
const HALF_TOP_GAP = 210;

export class BottomSheet {
  private state: SheetState = 'closed';
  /** ノッチ・ステータスバーの高さ。画面の向きが変わったら測り直す */
  private safeTopPx: number | null = null;
  private drag: { y0: number; h0: number; max: number; t0: number; moved: boolean; id: number } | null = null;
  /** 閉じきったら中身を非表示にするタイマー */
  private hideTimer = 0;

  constructor(
    private readonly handle: HTMLElement,
    grips: HTMLElement[],
    private readonly body: HTMLElement,
    private readonly onChange: (open: boolean) => void,
    /** 全画面になった・やめたとき（全画面では地図が見えない） */
    private readonly onFull: (full: boolean) => void = () => undefined,
  ) {
    for (const el of [handle, ...grips]) {
      el.addEventListener('pointerdown', (e) => this.start(e, el));
      el.addEventListener('pointermove', (e) => this.move(e));
      el.addEventListener('pointerup', (e) => this.end(e));
      el.addEventListener('pointercancel', (e) => this.end(e));
    }
    window.addEventListener('resize', () => {
      this.safeTopPx = null;
      if (this.state !== 'closed') this.body.style.height = `${this.heightOf(this.state)}px`;
    });
  }

  get isOpen(): boolean {
    return this.state === 'half' || this.state === 'full';
  }

  /** カードとボタン列など、閉じていても見えている部分の高さ */
  private collapsed(): number {
    const sheet = this.body.parentElement!;
    return sheet.getBoundingClientRect().height - this.body.getBoundingClientRect().height;
  }

  /** ノッチ・ステータスバーの高さ（env(safe-area-inset-top) は JS から直接読めないので、要素に当てて測る） */
  private safeTop(): number {
    if (this.safeTopPx != null) return this.safeTopPx;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top);visibility:hidden;pointer-events:none';
    document.body.append(probe);
    const h = probe.getBoundingClientRect().height;
    probe.remove();
    this.safeTopPx = h;
    return h;
  }

  private heightOf(state: SheetState): number {
    if (state === 'closed' || state === 'mini') return 0;
    const room = window.innerHeight - this.collapsed();
    const full = Math.max(160, Math.round(room - this.safeTop() - FULL_TOP_GAP));
    return state === 'full' ? full : Math.min(full, Math.max(160, Math.round(room - HALF_TOP_GAP)));
  }

  setOpen(open: boolean): void {
    this.setState(open ? 'half' : 'closed');
  }

  setState(state: SheetState): void {
    const wasOpen = this.isOpen;
    const wasFull = this.state === 'full';
    this.state = state;
    const open = this.isOpen;
    this.body.hidden = false;
    this.body.style.height = `${this.heightOf(state)}px`;
    this.handle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('sheet-open', open);
    document.body.classList.toggle('sheet-full', state === 'full');
    document.body.classList.toggle('sheet-mini', state === 'mini');
    this.handle.setAttribute('aria-label', open ? '詳細を閉じる' : state === 'mini' ? '表示を戻す' : '詳細を開く');
    if (!open) {
      // 閉じきったら非表示（スクリーンリーダー・タブ移動の対象外に）。閉じる動き（0.22秒）が終わるころに1回だけ確かめる
      // （transitionend は、動きのない最小⇄閉じるでは来ずにリスナーが残り、中の要素の動きでも来るので使わない）
      clearTimeout(this.hideTimer);
      this.hideTimer = window.setTimeout(() => {
        if (!this.isOpen) this.body.hidden = true;
      }, 400);
    }
    // 開いた・閉じたときだけ（半分⇄全画面では中身は同じなので、作り直させない）
    if (open !== wasOpen) this.onChange(open);
    if ((state === 'full') !== wasFull) this.onFull(state === 'full');
  }

  /** タップしたとき：最小なら元に戻し、閉じていれば開き、開いていれば閉じる */
  toggle(): void {
    this.setState(this.state === 'mini' ? 'closed' : this.isOpen ? 'closed' : 'half');
  }

  private start(e: PointerEvent, el: HTMLElement) {
    // カード内のボタンは普通に押せるようにする
    if ((e.target as HTMLElement).closest('button:not(#sheet-handle), a, input')) return;
    el.setPointerCapture(e.pointerId);
    this.body.hidden = false;
    // 全画面の高さはドラッグの始めに1回だけ求める（動かすたびに求めると、直前に変えた高さのレイアウトを毎回やり直させるため）
    this.drag = { y0: e.clientY, h0: this.body.getBoundingClientRect().height, max: this.heightOf('full'), t0: performance.now(), moved: false, id: e.pointerId };
  }

  private move(e: PointerEvent) {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.abs(dy) < 6) return;
    d.moved = true;
    this.body.classList.add('dragging');
    this.body.style.height = `${Math.max(0, Math.min(d.max, d.h0 - dy))}px`;
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
    // 素早く払ったら、払った向きの次の段へ。ゆっくりなら近い段へ（最小は「閉じる」からさらに下へ引いたとき）
    let i = STATES.reduce((best, s, k) => (k > 0 && Math.abs(this.heightOf(s) - h) < Math.abs(this.heightOf(STATES[best]) - h) ? k : best), 1);
    if (Math.abs(v) > 0.4) {
      const from = STATES.indexOf(this.state);
      i = Math.max(0, Math.min(STATES.length - 1, from + (v < 0 ? 1 : -1)));
    } else if (this.state === 'mini' && dy > -MINI_PULL) i = 0;
    else if (h === 0 && d.h0 === 0 && dy > MINI_PULL) i = 0;
    this.setState(STATES[i]);
  }
}
