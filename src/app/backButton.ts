/**
 * Android の戻るボタン。アプリの画面は終了しない（記録は続くが、次に開くときに地図や WebView を作り直すことになり、表示の状態もなくなるため）。
 * 開いているもの（ポケット表示 → 開いているダイアログ（メニュー・検索・写真など） → 地図の吹き出し → 下のシート → リプレイ）を順に閉じ、
 * 何もなければアプリを裏に回す（ホームボタンと同じ）。
 */
import { App } from '@capacitor/app';
import { backgroundCapable } from '../track/location';
import { popup } from './mapTap';
import { exitPocket, pocketActive } from './pocket';
import { updateRecButton } from './recording';
import { replayActive, stopReplay } from './replay';
import { sheet } from './sheetView';

if (backgroundCapable) {
  void App.addListener('backButton', () => {
    // 開いているダイアログを閉じる。メニューの上に開いたもの（動作の記録など）があれば、そちらから
    const dialogs = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')];
    const top = dialogs.find((d) => d.id !== 'menu') ?? dialogs[0];
    if (pocketActive()) exitPocket();
    else if (top) top.close();
    else if (popup.isOpen()) popup.remove();
    else if (sheet.isOpen) sheet.setOpen(false);
    else if (replayActive()) {
      stopReplay();
      updateRecButton();
    } else void App.minimizeApp();
  });
}
