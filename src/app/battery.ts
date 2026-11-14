/**
 * 電池の最適化の案内（アプリ版だけ）。最適化の対象のままだと、画面を消して長く記録しているあいだに、
 * Android やメーカー独自の省電力機能で記録が止められることがある。
 * 記録を始めたときに一度だけ外すか聞き、メニューの「記録」にも今の状態と設定を開くボタンを出す
 */
import { batteryOptimized, openBatterySettings } from '../track/location';
import { saveSettings, settings } from '../settings';
import { $ } from '../ui/dom';

/** 記録を始めたときに、電池の最適化の対象なら一度だけ外すか聞く */
export async function suggestBatteryExemption() {
  if (settings.batteryAsked || (await batteryOptimized()) !== true) return;
  settings.batteryAsked = true;
  saveSettings();
  if (confirm('画面を消して長く記録していると、電池の節約のためにアプリが止められることがあります。\nやまマップを電池の最適化の対象から外しますか？（設定の画面が開きます）')) {
    await openBatterySettings();
  }
}

/** メニューの電池の最適化の表示を、今の状態に合わせる */
export async function refreshBattery() {
  const optimized = await batteryOptimized();
  $('battery').hidden = optimized == null;
  if (optimized == null) return;
  $('battery-note').textContent = optimized
    ? '電池の最適化の対象です。画面を消して長く記録していると、記録が止められることがあります。'
    : '電池の最適化の対象外です。画面を消して長く記録しても止められにくくなっています。';
  // メーカー独自の省電力機能は、ここでは外せない（機種ごとの手順は docs/android-plan.md）
  $('battery-note').append(' メーカー独自の省電力機能がある機種は、その設定も確かめてください。');
  $<HTMLButtonElement>('btn-battery').textContent = optimized ? '電池の最適化から外す' : '電池の最適化の設定を開く';
}

$('btn-battery').addEventListener('click', () => void openBatterySettings());
// 設定の画面から戻ってきたら、表示を合わせ直す
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $<HTMLDialogElement>('menu').open) void refreshBattery();
});
