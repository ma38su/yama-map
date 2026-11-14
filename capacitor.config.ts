import type { CapacitorConfig } from '@capacitor/cli';

// Androidアプリ版の設定。`npm run android:build` で dist/ を取り込んで APK を作る
const config: CapacitorConfig = {
  appId: 'io.github.ma38su.yamamap',
  appName: 'やまマップ',
  webDir: 'dist',
  android: {
    // 裏に回って5分ほど経つと、ネイティブから JS への知らせ（記録の点を保存した、など）が届かなくなる問題を避ける
    useLegacyBridge: true,
  },
};

export default config;
