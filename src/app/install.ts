/** メニューの「ホーム画面に追加」：PWA としてインストールする（アプリ版・インストール済みなら出さない） */
import { backgroundCapable } from '../track/location';
import { $ } from '../ui/dom';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const section = $('sec-install');
const btn = $<HTMLButtonElement>('btn-install');
const note = $('install-note');
let deferred: BeforeInstallPromptEvent | null = null;

const standalone = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
// iPadOS の Safari は Mac と同じ名乗りをするので、タッチできるかで見分ける
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

function render() {
  section.hidden = backgroundCapable || standalone();
  btn.hidden = !deferred;
  note.textContent = deferred
    ? 'ホーム画面から全画面で起動でき、圏外でも開けます。'
    : isIos
      ? 'Safari の共有ボタン（□↑）から「ホーム画面に追加」を選ぶと、アプリのように全画面で起動できます。'
      : 'ブラウザのメニューから「アプリをインストール」または「ホーム画面に追加」を選ぶと、アプリのように起動できます。';
}

// ブラウザがインストールできると判断したら届く。あとでボタンから出すために取っておく
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as BeforeInstallPromptEvent;
  render();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  render();
});
btn.addEventListener('click', async () => {
  if (!deferred) return;
  const ev = deferred;
  deferred = null;
  await ev.prompt();
  await ev.userChoice;
  render();
});
render();
