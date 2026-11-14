/**
 * Android の戻るボタン。アプリの画面を終了すると、記録中の測位サービスも一緒に止まってしまう
 * （@capacitor-community/background-geolocation は画面の終了でサービスを止める）ので、終了はしない。
 * 開いているもの（メニュー → 地図の吹き出し → 下のシート → リプレイ）を順に閉じ、何もなければアプリを裏に回す（ホームボタンと同じ）。
 */
import { App } from '@capacitor/app';
import { backgroundCapable } from '../track/location';
import { $ } from '../ui/dom';
import { popup } from './mapTap';
import { updateRecButton } from './recording';
import { replayActive, stopReplay } from './replay';
import { sheet } from './sheetView';

if (backgroundCapable) {
  void App.addListener('backButton', () => {
    const menu = $<HTMLDialogElement>('menu');
    if (menu.open) menu.close();
    else if (popup.isOpen()) popup.remove();
    else if (sheet.isOpen) sheet.setOpen(false);
    else if (replayActive()) {
      stopReplay();
      updateRecButton();
    } else void App.minimizeApp();
  });
}
