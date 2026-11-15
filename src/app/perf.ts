/**
 * 画面側のパフォーマンスの計測。あとで分析できるよう、表に出ているあいだの様子を10分ごと（と裏に回るとき）に、
 * 動作のログへ「計測(画面)」の1行で残す：表示していた時間・地図を描いた回数・長い処理（50ms 超）の回数と合計・JS のメモリ・電池（分かれば）。
 * 数を数えるだけで、計測のために何かを動かし続けることはしない（裏に回っているあいだは何もしない）
 */
import { log } from '../log';
import { map } from './mapView';
import { pocketActive } from './pocket';

const SUMMARY_MS = 10 * 60_000;

let renders = 0;
let longTasks = 0;
let longMs = 0;
let since = performance.now();
let timer = 0;

map.on('render', () => {
  renders++;
});
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      longTasks++;
      longMs += e.duration;
    }
  }).observe({ type: 'longtask' });
} catch {
  /* 長い処理を数えられないブラウザ */
}

interface BatteryLike {
  level: number;
  charging: boolean;
}

async function summarize(reason: string) {
  const now = performance.now();
  const min = (now - since) / 60_000;
  const counts = { renders, longTasks, longMs };
  since = now;
  renders = 0;
  longTasks = 0;
  longMs = 0;
  if (min < 0.5) return; // 短すぎる区間は残さない
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
  const battery = await nav.getBattery?.().catch(() => null);
  log(
    `計測(画面) 区間=${min.toFixed(1)}分 描画=${counts.renders}回 長い処理=${counts.longTasks}回/${Math.round(counts.longMs)}ms` +
      ` メモリ=${mem ? `${Math.round(mem / 1_048_576)}MB` : '-'}` +
      ` 電池=${battery ? `${Math.round(battery.level * 100)}%${battery.charging ? '(充電中)' : ''}` : '-'}` +
      ` ポケット=${pocketActive() ? '中' : '-'}（${reason}）`,
  );
}

function start() {
  clearInterval(timer);
  since = performance.now();
  renders = 0;
  longTasks = 0;
  longMs = 0;
  timer = window.setInterval(() => void summarize('定期'), SUMMARY_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') start();
  else {
    clearInterval(timer);
    timer = 0;
    void summarize('裏に回る');
  }
});
if (document.visibilityState === 'visible') start();
