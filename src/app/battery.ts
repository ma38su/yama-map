/**
 * 電池の最適化の案内（アプリ版だけ）。最適化の対象のままだと、画面を消して長く記録しているあいだに、
 * Android やメーカー独自の省電力機能で記録が止められることがある。
 * 記録を始めたときに一度だけ外すか聞き、メニューの「記録」にも今の状態と設定を開くボタンを出す
 */
import { log } from '../log';
import { batteryOptimized, openBatterySettings } from '../track/location';
import { saveSettings, settings } from '../settings';
import { $ } from '../ui/dom';

/** 記録を始めたときに、電池の最適化の対象なら一度だけ外すか聞く */
export async function suggestBatteryExemption() {
  if (settings.batteryAsked || (await batteryOptimized()) !== true) return;
  settings.batteryAsked = true;
  saveSettings();
  const ok = confirm('画面を消して長く記録していると、電池の節約のためにアプリが止められることがあります。\nやまマップを電池の最適化の対象から外しますか？（設定の画面が開きます）');
  log(`電池の最適化から外すか聞いた: ${ok ? '設定を開く' : '外さない'}`);
  if (ok) await openBatterySettings();
}

/** メニューの電池の最適化の表示を、今の状態に合わせる */
export async function refreshBattery() {
  const optimized = await batteryOptimized();
  $('battery').hidden = optimized == null;
  if (optimized == null) return;
  $('battery-note').textContent = optimized
    ? '電池の最適化の対象です。画面を消して長く記録していると、記録が止められることがあります。'
    : '電池の最適化の対象外です。画面を消して長く記録しても止められにくくなっています。戻すときは、アプリ情報の「アプリの電池使用量」で変えられます。';
  // メーカー独自の省電力機能は、ここでは外せない（機種ごとの手順は docs/android-plan.md）
  $('battery-note').append(' メーカー独自の省電力機能がある機種は、その設定も確かめてください。');
  // 外してあるときは、外すか聞くダイアログが出ないので、アプリ情報の画面を開く（TrackingPlugin.openBatterySettings）
  $<HTMLButtonElement>('btn-battery').textContent = optimized ? '電池の最適化から外す' : 'アプリ情報（電池の設定）を開く';
}

$('btn-battery').addEventListener('click', () => void openBatterySettings());
// 設定の画面から戻ってきたら、表示を合わせ直す。外すか聞くダイアログは画面の上に重なるだけで visibilitychange が起きないので、
// アプリ版の resume（Capacitor が画面に戻ったときに document に出す）でも合わせる
const refreshIfOpen = () => {
  if (document.visibilityState === 'visible' && $<HTMLDialogElement>('menu').open) void refreshBattery();
};
document.addEventListener('visibilitychange', refreshIfOpen);
document.addEventListener('resume', refreshIfOpen);
