/**
 * メニューの「動作の記録」：端末とアプリの状態、アプリのログ、記録のサービスのログ（アプリ版）、logcat（アプリ版）をまとめて見て、
 * ファイルで送れるようにする。USB でつながなくても、実機で起きたことやパフォーマンス（「計測」の行）をあとで調べられるように。
 * 位置が分かるもの（緯度経度・地図タイルの番号・天気の問い合わせの座標）は伏せる
 */
import { maskLocation } from '../geo';
import { clearLog, logLines } from '../log';
import { clearNativeLog, nativeReport } from '../track/location';
import { settings } from '../settings';
import { $, download, fileStamp } from '../ui/dom';
import { recorder } from './recording';

const dialog = $<HTMLDialogElement>('log-dialog');
const textEl = $('log-text');
let report = '';

const time = (ms: number) => new Date(ms).toLocaleString('ja-JP');

async function buildReport(): Promise<string> {
  const out: string[] = [];
  out.push(`やまマップ 動作の記録（${time(Date.now())}）`);
  out.push(`版: ${__APP_VERSION__}`);
  out.push(`ブラウザ: ${navigator.userAgent}`);
  const native = await nativeReport().catch((e) => {
    out.push(`アプリ版の情報を取れませんでした: ${e}`);
    return null;
  });
  if (native) {
    const d = native.diag;
    out.push(`端末: ${d.device} / Android ${d.android} / アプリ ${d.app}`);
    out.push(`WebView: ${d.webview}`);
    out.push(
      `位置情報: ${d.location}（端末の位置情報 ${d.locationEnabled ? 'オン' : 'オフ'}）/ 通知: ${d.notifications ? '許可' : '不許可'}` +
        ` / 電池の最適化: ${d.batteryOptimized ? '対象' : '対象外'} / 省電力モード: ${d.powerSave ? 'オン' : 'オフ'}`,
    );
    out.push(`記録のサービス: ${d.serviceRunning ? `動いている（${d.serviceTrack?.slice(0, 8)}）` : '止まっている'} / 取り込み前の測位: ${d.pendingFixes}件`);
    out.push(
      `歩数計: ${d.stepCounter ? 'あり' : 'なし'} / 大きな動きのセンサー: ${d.motionSensor ? 'あり' : 'なし'} / 身体活動の許可: ${d.activity ? '許可' : 'なし'}` +
        `（${d.stepCounter && d.activity ? '止まっているあいだは測位を間引く' : '測位は間引かない'}）`,
    );
    // アプリが最近終了した理由（Android に止められたときの理由が分かる）
    for (const e of d.exits ?? []) out.push(`アプリの終了: ${time(e.t)} ${e.reason}（${e.importance}）${e.description ? ` ${e.description}` : ''}`);
  }
  const rs = recorder.state;
  out.push(
    `記録: ${recorder.recording ? `記録中（${rs.track?.id.slice(0, 8)}・${rs.points.length}点）` : '記録していない'}` +
      `${rs.saveFailed ? '・保存できていない点あり' : ''}${rs.error ? `・${rs.error}` : ''}`,
  );
  const est = await navigator.storage?.estimate?.().catch(() => undefined);
  if (est?.usage) out.push(`保存領域: ${Math.round(est.usage / 1_048_576)}MB 使用`);
  out.push(
    `設定: 画面を点けたまま=${settings.wakeLock} 道迷いアラート=${settings.offRouteAlert} 3D=${settings.terrain} 天気=${settings.weather}/${settings.weatherFx} ペース=${settings.pace}`,
  );
  out.push('', '--- アプリのログ（古い順）');
  for (const l of logLines()) out.push(`${time(l.t)} ${l.msg}`);
  if (native) {
    out.push('', '--- 記録のサービスのログ（古い順）', ...native.log);
    out.push('', '--- logcat（このアプリの分、新しい 400 行）', native.logcat.trimEnd());
  }
  return maskLocation(out.join('\n'));
}

async function show() {
  textEl.textContent = '読み込み中…';
  // 「ログを消す」から読み直すときは開いたまま（開いているダイアログにもう一度 showModal すると例外になる）
  if (!dialog.open) dialog.showModal();
  report = await buildReport();
  textEl.textContent = report;
}
// 閉じたら報告の文字列（数百KBになる）を手放す
dialog.addEventListener('close', () => {
  report = '';
  textEl.textContent = '';
});

$('btn-log').addEventListener('click', () => void show());
$('btn-log-send').addEventListener('click', () => {
  if (report) download(`yama-map-log-${fileStamp(Date.now())}.txt`, report, 'text/plain');
});
$('btn-log-clear').addEventListener('click', async () => {
  if (!confirm('動作の記録（ログ）を消しますか？（記録した軌跡は消えません）')) return;
  clearLog();
  await clearNativeLog();
  await show();
});
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close(); // 背景タップで閉じる
});
