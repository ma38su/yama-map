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
import { startGeolocate } from './recording';
import { whileVisible } from './scheduler';
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
  schedule();
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
/** 現在地を出しているあいだ（か進む向きを上にしているあいだ）、画面が表のときだけセンサーを聞く */
function syncListening() {
  const want = document.visibilityState === 'visible' && (locating() || headingUp);
  listen(want);
  if (!want) hideCone();
}
geolocate.on('geolocate', (pos) => {
  syncListening();
  // センサーがない（届かない）ときは、歩いている向き（GPS の進行方向）を使う
  const c = pos.coords;
  if ((!fromSensor || Date.now() - headingAt > 5000) && c.heading != null && !Number.isNaN(c.heading) && (c.speed ?? 0) > 0.5) {
    fromSensor = false;
    heading = c.heading;
    headingAt = Date.now();
    schedule();
  }
});
geolocate.on('trackuserlocationend', syncListening);
document.addEventListener('visibilitychange', syncListening);
// 現在地ボタンでオフにしたときのイベントはないので、ときどき確かめる
whileVisible(3000, syncListening);

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
function render() {
  frame = 0;
  // 10秒以上新しい向きが届かなければ扇を消す
  const fresh = heading != null && Date.now() - headingAt < 10_000;
  if (locating() && geolocate._dotElement) {
    if (!cone || cone.parentElement !== geolocate._dotElement) {
      cone = h('div', 'heading-cone');
      geolocate._dotElement.append(cone);
    }
    cone.hidden = !fresh;
    if (fresh) cone.style.transform = `rotate(${heading! - map.getBearing()}deg)`;
  }
  if (headingUp && fresh) rotateMap(heading!);
}
map.on('rotate', schedule);

/** 向きに合わせて地図を回す。小さな揺れでは回さず、回すのも0.3秒に1回まで */
function rotateMap(hd: number) {
  const now = Date.now();
  if (Math.abs(angleDiff(map.getBearing(), hd)) < 4 || now - lastRotateAt < 300) return;
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

export async function setHeadingUp(on: boolean) {
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
