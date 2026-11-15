/**
 * 方位：現在地の印に向いている方向の扇を出し、「進む向きを上」にすると向きに合わせて地図を回す。
 * 向きは端末の方位センサー（コンパス）から取り、センサーがなければ GPS の進行方向を使う。
 * センサーは1秒に何十回も届くので、現在地を出しているあいだ（か進む向きを上にしているあいだ）だけ聞き、
 * 画面への反映は requestAnimationFrame でまとめる
 */
import type { IControl } from 'maplibre-gl';
import { angleDiff, headingFrom, smoothHeading } from '../nav/heading';
import { h } from '../ui/dom';
import { geolocate, map } from './mapView';
import { pocketActive } from './pocket';
import { startGeolocate } from './recording';
import { replayActive } from './replay';
import { status } from './status';

/** 画面の上が向いている方位（北から時計回りの度）。分からなければ null */
let heading: number | null = null;
let headingAt = 0;
let fromSensor = false;
let headingUp = false;

// ---------- センサー ----------
type OrientationEvt = DeviceOrientationEvent & { webkitCompassHeading?: number };
const absoluteEvent = 'ondeviceorientationabsolute' in window;
const eventName = absoluteEvent ? 'deviceorientationabsolute' : 'deviceorientation';
let listening = false;

function onOrientation(e: Event) {
  const ev = e as OrientationEvt;
  const angle = screen.orientation?.angle ?? 0;
  const hd = headingFrom({ alpha: ev.alpha, absolute: absoluteEvent || ev.absolute, webkitCompassHeading: ev.webkitCompassHeading }, angle);
  if (hd == null) return;
  heading = smoothHeading(fromSensor ? heading : null, hd);
  headingAt = Date.now();
  fromSensor = true;
  // 1秒に何十回も届くので、扇か地図の向きを変えるほど変わったときだけ描く
  if (needsRender()) schedule();
  watchStale();
}

/** 向きが変わって、扇を書き換えるか地図を回すことになるか（render と同じ閾値） */
function needsRender(): boolean {
  if (heading == null) return false;
  if (headingUp && Date.now() - lastRotateAt >= 300 && Math.abs(angleDiff(map.getBearing(), heading)) >= 4) return true;
  if (!locating()) return false;
  if (drawnAngle == null || !cone || cone.hidden) return true;
  return Math.abs(angleDiff(drawnAngle, heading - map.getBearing())) >= 1.5;
}

/** 新しい向きが10秒届かなかったら扇を消す（GPS の進行方向だけで立ち止まった・センサーが止まった）。そのころに確かめる */
let staleTimer = 0;
function watchStale() {
  if (staleTimer) return;
  staleTimer = window.setTimeout(() => {
    staleTimer = 0;
    schedule();
    // まだ新しければ（届き続けている）、新しくなくなるころにもう一度
    if (heading != null && Date.now() - headingAt < 10_000) watchStale();
  }, Math.max(500, headingAt + 10_100 - Date.now()));
}

function listen(on: boolean) {
  if (on === listening) return;
  listening = on;
  if (on) window.addEventListener(eventName, onOrientation);
  else window.removeEventListener(eventName, onOrientation);
}

/** iOS は向きのセンサーを使うのにタップでの許可が要る */
async function requestPermission(): Promise<boolean> {
  const req = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission;
  if (!req) return true;
  try {
    return (await req()) === 'granted';
  } catch {
    return false;
  }
}

const locating = () => geolocate._watchState !== 'OFF';
/**
 * 現在地を出しているあいだ（か進む向きを上にしているあいだ）、画面が表のときだけセンサーを聞く。
 * ポケット表示・シートの全画面のあいだは地図が見えないので聞かない（センサーは1秒に何十回も届くため）。
 * リプレイのあいだはカメラをリプレイが動かすので、地図を回すためには聞かない。
 * 現在地のオン・オフ、画面の表裏、ポケット表示・シートの出入り（body の class が変わる）のたびに合わせる
 */
function syncListening() {
  const want =
    document.visibilityState === 'visible' &&
    !document.body.classList.contains('pocket-on') &&
    !document.body.classList.contains('sheet-full') &&
    (locating() || (headingUp && !replayActive()));
  listen(want);
  if (!want) hideCone();
  else schedule();
}
new MutationObserver(syncListening).observe(document.body, { attributes: true, attributeFilter: ['class'] });
geolocate.on('geolocate', (pos) => {
  syncListening();
  // センサーがない（届かない）ときは、歩いている向き（GPS の進行方向）を使う
  const c = pos.coords;
  if ((!fromSensor || Date.now() - headingAt > 5000) && c.heading != null && !Number.isNaN(c.heading) && (c.speed ?? 0) > 0.5) {
    fromSensor = false;
    heading = c.heading;
    headingAt = Date.now();
    schedule();
    watchStale();
  }
});
// 現在地ボタンでオン・オフした（MapLibre 6 はオフでも trackuserlocationend を出す）・許可がなかった
for (const ev of ['trackuserlocationstart', 'trackuserlocationend', 'error'] as const) geolocate.on(ev, syncListening);
document.addEventListener('visibilitychange', syncListening);

// ---------- 表示 ----------
let cone: HTMLDivElement | null = null;
function hideCone() {
  if (cone) cone.hidden = true;
}

let frame = 0;
function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

let lastRotateAt = 0;
/** 扇を最後に描いた向き（画面の上からの角度）。少ししか変わらなければ書き換えない（センサーは1秒に何十回も届くため） */
let drawnAngle: number | null = null;
function render() {
  frame = 0;
  // ポケット表示のあいだは地図を描かないので、扇も地図の向きも変えない
  if (pocketActive()) return;
  // 10秒以上新しい向きが届かなければ扇を消す
  const fresh = heading != null && Date.now() - headingAt < 10_000;
  if (locating() && geolocate._dotElement) {
    if (!cone || cone.parentElement !== geolocate._dotElement) {
      cone = h('div', 'heading-cone');
      geolocate._dotElement.append(cone);
      drawnAngle = null;
    }
    cone.hidden = !fresh;
    const angle = fresh ? heading! - map.getBearing() : null;
    if (angle != null && (drawnAngle == null || Math.abs(angleDiff(drawnAngle, angle)) >= 1.5)) {
      cone.style.transform = `rotate(${angle}deg)`;
      drawnAngle = angle;
    }
  }
  if (headingUp && fresh) rotateMap(heading!);
}
map.on('rotate', schedule);

/** 向きに合わせて地図を回す。小さな揺れでは回さず、回すのも0.3秒に1回まで */
function rotateMap(hd: number) {
  const now = Date.now();
  if (Math.abs(angleDiff(map.getBearing(), hd)) < 4 || now - lastRotateAt < 300) return;
  // ほかの動き（地名検索・写真への移動など）の途中なら、止めないよう待つ。リプレイのあいだはリプレイがカメラを動かす（ぶつからないように）
  if (map.isMoving() || replayActive()) return;
  lastRotateAt = now;
  // 現在地に追従しているあいだは、中心も現在地に合わせる（追従のアニメーションを止めてしまうので）。
  // geolocateSource を付けて、追従が外れないようにする
  const pos = geolocate._lastKnownPosition as GeolocationPosition | undefined;
  const center: [number, number] | undefined =
    geolocate._watchState === 'ACTIVE_LOCK' && pos ? [pos.coords.longitude, pos.coords.latitude] : undefined;
  map.easeTo({ bearing: hd, center, duration: 300, easing: (t) => t }, { geolocateSource: true, headingUp: true });
}

// ---------- 進む向きを上にするボタン ----------
class HeadingUpControl implements IControl {
  private container?: HTMLDivElement;
  private button?: HTMLButtonElement;
  onAdd(): HTMLElement {
    this.container = h('div', 'maplibregl-ctrl maplibregl-ctrl-group');
    this.button = h('button', 'ctrl-heading');
    this.button.type = 'button';
    this.button.title = '進む向きを上にする';
    this.button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l6 17-6-4-6 4z" /></svg>';
    this.button.addEventListener('click', () => void setHeadingUp(!headingUp));
    this.container.append(this.button);
    this.update();
    return this.container;
  }
  update() {
    this.button?.setAttribute('aria-pressed', String(headingUp));
    this.button?.setAttribute('aria-label', headingUp ? '北を上に戻す' : '進む向きを上にする');
  }
  onRemove() {
    this.container?.remove();
  }
}
const control = new HeadingUpControl();
map.addControl(control, 'top-right');

async function setHeadingUp(on: boolean) {
  if (on === headingUp) return;
  if (on) {
    const sensor = await requestPermission();
    startGeolocate();
    headingUp = true;
    syncListening();
    // センサーが使えなくても、歩いている向き（GPS の進行方向）で回す
    if (sensor) status('進む向きを上にしました（地図を回すと北上に戻ります）');
    else status('方位センサーが使えないため、歩いている向き（GPS）に合わせて回します', true);
  } else {
    headingUp = false;
    map.easeTo({ bearing: 0, duration: 400 }, { geolocateSource: true, headingUp: true });
    syncListening();
  }
  control.update();
  schedule();
}

// 指で地図を回したり、方位ボタンで北に戻したりしたら、進む向きを上にするのをやめる
map.on('rotatestart', (ev) => {
  const e = ev as { headingUp?: boolean; geolocateSource?: boolean };
  if (headingUp && !e.headingUp && !e.geolocateSource) {
    headingUp = false;
    control.update();
    syncListening();
  }
});
