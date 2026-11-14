/**
 * 3D 表示のときの指の操作を入れ替える：1本指のドラッグで回転（左右で向き・上下で傾き）、
 * 2本指で移動（ピンチの拡大縮小・ひねりの回転はそのまま）。マウスの操作は変えない。
 */
import type { Map as MlMap } from 'maplibre-gl';

/** 1px 動かしたときに変わる角度（度）。マウスの右ドラッグに近い速さ */
const BEARING_PER_PX = 0.5;
const PITCH_PER_PX = 0.4;
/** これより動かすまではタップとみなす (px) */
const TAP_TOLERANCE = 6;

interface TouchPanInternals {
  _shouldBePrevented?: (touches: number) => boolean;
}

export function swapTouchGestures(map: MlMap, active: () => boolean): void {
  // 1本指の移動を止める。MapLibre の「2本指で移動」（cooperativeGestures）と同じ仕組みを、
  // デスクトップのホイール操作は変えずに使う（内部のプロパティなので、なければ何もしない）
  const touchPan = (map.dragPan as unknown as { _touchPan?: TouchPanInternals })._touchPan;
  if (touchPan && typeof touchPan._shouldBePrevented === 'function') {
    touchPan._shouldBePrevented = (touches) => touches < (active() ? 2 : 1);
  }

  const el = map.getCanvasContainer();
  let drag: { id: number; x: number; y: number; bearing: number; pitch: number; moved: boolean } | null = null;
  el.addEventListener(
    'touchstart',
    (e) => {
      // 1本指で始めたときだけ。2本目が触れたら回転はやめる
      if (!active() || e.touches.length !== 1) {
        drag = null;
        return;
      }
      const t = e.touches[0];
      drag = { id: t.identifier, x: t.clientX, y: t.clientY, bearing: map.getBearing(), pitch: map.getPitch(), moved: false };
    },
    { passive: true },
  );
  el.addEventListener(
    'touchmove',
    (e) => {
      const d = drag;
      if (!d) return;
      const t = e.touches[0];
      if (e.touches.length !== 1 || t.identifier !== d.id) {
        drag = null;
        return;
      }
      const dx = t.clientX - d.x;
      const dy = t.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < TAP_TOLERANCE) return;
      d.moved = true;
      map.jumpTo({ bearing: d.bearing + dx * BEARING_PER_PX, pitch: Math.max(0, d.pitch - dy * PITCH_PER_PX) });
    },
    { passive: true },
  );
  const end = () => {
    drag = null;
  };
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', end, { passive: true });
}
