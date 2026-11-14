import type { CapacitorConfig } from '@capacitor/cli';

// Androidアプリ版の設定。`npm run android:build` で dist/ を取り込んで APK を作る
const config: CapacitorConfig = {
  appId: 'io.github.ma38su.yamamap',
  appName: 'やまマップ',
  webDir: 'dist',
  android: {
    // バックグラウンドで5分ほど経つと位置の通知が止まる問題を避ける（background-geolocation の推奨設定）
    useLegacyBridge: true,
  },
};

export default config;
