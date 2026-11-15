/**
 * 画面が表のときだけ動く定期処理。裏に回ったらタイマーを止め、表に戻ったらすぐ一度呼んでから再開する。
 * アプリ版（Capacitor）は裏でも JS のタイマーを止めないので、止めないと記録中ずっと端末を起こしてしまう。
 */
interface Job {
  ms: number;
  fn: () => void;
  timer: number;
  /** 動かすか（off にしたあいだは、表でも動かさない） */
  on: boolean;
}
const jobs: Job[] = [];
const visible = () => document.visibilityState === 'visible';

function start(job: Job) {
  if (!job.timer) job.timer = window.setInterval(job.fn, job.ms);
}
function stop(job: Job) {
  clearInterval(job.timer);
  job.timer = 0;
}

/**
 * ms ごとに fn を呼ぶ（表のときだけ）。表に戻ったときにも一度呼ぶ。
 * 返す on・off で、要るあいだだけ動かせる（ポケット表示のあいだだけなど。作ったときは動いている）
 */
export function whileVisible(ms: number, fn: () => void): { on: () => void; off: () => void } {
  const job: Job = { ms, fn, timer: 0, on: true };
  jobs.push(job);
  if (visible()) start(job);
  return {
    on: () => {
      job.on = true;
      if (visible()) start(job);
    },
    off: () => {
      job.on = false;
      stop(job);
    },
  };
}

document.addEventListener('visibilitychange', () => {
  for (const job of jobs) {
    if (!job.on) continue;
    if (visible()) {
      job.fn();
      start(job);
    } else stop(job);
  }
});
