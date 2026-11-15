/**
 * 動作のログ。メニューの「動作の記録」で見て、ファイルで送れる（USB でつながなくても、実機で起きたことを調べられるように）。
 * 記録の開始・終了などの出来事、裏に回った・戻った、console の注意・エラー、拾われなかった例外を残す。位置（緯度経度）は残さない。
 * 端末には最新 KEEP 行まで保存する（localStorage。書き込みは少しまとめて行い、裏に回るときはすぐ）
 */
const KEY = 'yama-map:log';
/** 端末に残す行数（1日歩いても、10分ごとの計測などが残るように） */
const KEEP = 1500;
/** 1行の長さの上限 */
const MAX_LEN = 600;

export interface LogLine {
  t: number;
  msg: string;
}

let lines: LogLine[] = [];
try {
  lines = JSON.parse(localStorage.getItem(KEY) ?? '[]') as LogLine[];
} catch {
  /* 保存領域が使えない環境でも動かす */
}
let timer = 0;

function persist() {
  clearTimeout(timer);
  timer = 0;
  try {
    localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    /* 容量が足りなければ保存しない */
  }
}

/** 1行残す */
export function log(msg: string) {
  lines.push({ t: Date.now(), msg: msg.length > MAX_LEN ? `${msg.slice(0, MAX_LEN)}…` : msg });
  if (lines.length > KEEP) lines.splice(0, lines.length - KEEP);
  timer ||= window.setTimeout(persist, 2000);
}

export const logLines = (): readonly LogLine[] => lines;

export function clearLog() {
  lines = [];
  persist();
}

/** console に渡されたものを1行の文字にする（例外はスタックの先頭も） */
function text(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? ` @ ${a.stack.split('\n').slice(1, 3).map((s) => s.trim()).join(' / ')}` : ''}`;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a)?.slice(0, 300) ?? String(a);
  } catch {
    return String(a);
  }
}

for (const [level, label] of [
  ['warn', '注意'],
  ['error', 'エラー'],
] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    log(`${label}: ${args.map(text).join(' ')}`);
  };
}
window.addEventListener('error', (e) => log(`例外: ${e.message}（${e.filename?.split('/').pop() ?? ''}:${e.lineno}）`));
window.addEventListener('unhandledrejection', (e) => log(`処理されなかった例外: ${text(e.reason)}`));

// 裏に回った・戻った（アプリ版の記録で、いつ WebView が動いていたかが分かるように）
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    log('裏に回った');
    persist();
  } else if (hiddenAt) log(`表に戻った（${Math.round((Date.now() - hiddenAt) / 60_000)}分ぶり）`);
});
