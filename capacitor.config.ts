import type { CapacitorConfig } from '@capacitor/cli';

// Androidアプリ版の設定。`npm run android:build` で dist/ を取り込んで APK を作る
const config: CapacitorConfig = {
  appId: 'io.github.ma38su.yamamap',
  appName: 'やまマップ',
  webDir: 'dist',
  // Capacitor の詳しいログ（呼び出しのたびに結果を丸ごと console と logcat に出す）は使わない。記録の測位を取り込むたびに大きなログになり、
  // 処理の無駄にもなるため。アプリの動作はメニューの「動作の記録」に残す（src/log.ts、TrackingStore のログ）
  loggingBehavior: 'none',
  android: {
    // 裏に回って5分ほど経つと、ネイティブから JS への知らせ（記録の点を保存した、など）が届かなくなる問題を避ける
    useLegacyBridge: true,
  },
};

export default config;
