# Androidアプリ（Capacitor）

Android アプリ版は、PWA と同じ Web のコード（`dist/`）を [Capacitor](https://capacitorjs.com) の WebView に入れたものです。
アプリにした目的は、**画面を消したままでも軌跡を記録できる**ようにすることです。
ブラウザの位置情報（`watchPosition`）は、画面オフやバックグラウンドで止まってしまいます。

iOS 版はありません（Xcode と Apple Developer Program が必要なため保留）。

## Web版との違い

アプリかどうかは `Capacitor.isNativePlatform()` で判定し、`src/track/location.ts` の `backgroundCapable` として使います。
違うのは次の部分だけで、ほかは Web 版と同じ動きです。

| 場所 | Web版 | アプリ版 |
|---|---|---|
| 記録の測位（`track/location.ts`） | `navigator.geolocation.watchPosition` | `@capacitor-community/background-geolocation`。フォアグラウンドサービスとして動き、記録中は通知「やまマップで記録中」が出る |
| 許可（`requestTrackingPermissions`） | ブラウザに任せる | 記録開始時に、通知 → 位置情報の順に**1つずつ**求める |
| 画面に戻ったとき（`track/recorder.ts`） | 測位をやり直す | ネイティブの測位は止まらないので、やり直さない |
| 地図の青い現在地マーク（`app/recording.ts` の `feedNativeFix`） | WebView の位置情報 | WebView の位置情報が古いときは、ネイティブの位置で上書きする |
| 画面を点けたままにする（`settings.ts`） | 初期値オン | 初期値オフ。メニューの説明文も差し替える（`app/menu.ts`） |
| 「画面を消すと記録が止まります」の警告（`app/status.ts`） | 出す | 出さない |
| GPX の書き出し（`ui/dom.ts` の `download`） | `<a download>` | キャッシュフォルダに書き出し、共有シートを開く（`@capacitor/filesystem`・`@capacitor/share`） |
| メニューの「ホーム画面に追加」（`app/install.ts`） | 出す | 出さない |

### なぜこうしているか

- **許可を1つずつ求める理由**：WebView の位置情報（地図の現在地表示）とプラグインが同時に許可を求めると、許可ダイアログが2枚重なります。
  すると Android のタップ乗っ取り対策で、どちらのダイアログも押せなくなります。そのため記録開始前に順番に許可を求め、
  `addWatcher` には `requestPermissions: false` を渡しています。
- **通知の許可を `@capacitor/local-notifications` で求める理由**：Android 13 以降は、記録中の通知を出すのに通知の許可が要ります。
  WebView には Notification API が無いので、このプラグインを許可の取得にだけ使っています。
  通知を拒否されても測位は続きます。
- **`useLegacyBridge: true`（`capacitor.config.ts`）の理由**：これが無いと、バックグラウンドで5分ほど経つと位置が届かなくなります。
  プラグインの推奨設定です。
- **「Service not running.」で再試行する理由**：起動直後は、プラグインの測位サービスがまだ接続されていないことがあります。
  `addWatcherWithRetry` で、500ms ごとに最大5回やり直します。
- **現在地マークを上書きする理由**：画面オフから戻った直後は、WebView の位置情報の再開に数秒かかります。
  その間、記録の線は最新の位置まで伸びているのに、マークだけが遅れて見えます。

## 使っているプラグイン

バージョンは `package.json` で固定しています。Capacitor 本体（`@capacitor/core`・`android`・`cli`）は揃えて上げます。

| パッケージ | 用途 |
|---|---|
| `@capacitor/core`・`@capacitor/android`・`@capacitor/cli` | Capacitor 本体（8.x） |
| `@capacitor-community/background-geolocation` | バックグラウンドの測位（フォアグラウンドサービスと通知） |
| `@capacitor/local-notifications` | 通知の許可を求める（通知そのものは出さない） |
| `@capacitor/filesystem`・`@capacitor/share` | GPX の書き出し |

アプリが求める主な権限は、位置情報（精密・おおよそ）、フォアグラウンドサービス（位置情報）、通知、インターネットです。
権限はプラグインのマニフェストから自動で追加されるので、`android/app/src/main/AndroidManifest.xml` には書いていません。

## ビルドの準備（初回だけ）

1. **JDK 21** を入れます。Capacitor 8 は Java 21 が必要です（17 では失敗します）。

   ```bash
   brew install openjdk@21
   ```

2. **Android SDK** を入れます。Android Studio を入れるのが簡単です。
   コマンドラインだけで済ませる場合は、`cmdline-tools;latest`・`platform-tools`・`platforms;android-36`・`build-tools` を `sdkmanager` で入れます。
3. **`android/local.properties`** に SDK の場所を書きます。このファイルはコミットしません。

   ```properties
   sdk.dir=/Users/<ユーザー名>/Library/Android/sdk
   ```

4. `npm install`

## ビルドと端末への入れ方

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
npm run android:build
```

`android:build` は次の3つを順に行います。

1. `vite build`：`dist/` を作る。型チェックはしないので、先に `npm run build` か `npm test` で確かめておく
2. `cap sync android`：`dist/` とプラグインの設定を `android/` に取り込む
3. `./gradlew assembleDebug`：APK を作る

できた APK は `android/app/build/outputs/apk/debug/app-debug.apk` です。USB でつないだ端末かエミュレータには、次のように入れます。

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.github.ma38su.yamamap/.MainActivity   # 起動
```

**Web のコードを直したら、`npm run android:build` で作り直して入れ直すだけ**です。`android/` のファイルを触る必要はありません。
プラグインを追加・削除したときも `cap sync` が設定を取り込みます。

`android/app/src/main/assets/public` などの取り込まれたファイルは、ビルドのたびに作り直されます。そのためコミットしていません。

## エミュレータ

```bash
SDK=~/Library/Android/sdk
$SDK/cmdline-tools/latest/bin/sdkmanager "emulator" "system-images;android-36;google_apis;arm64-v8a"
$SDK/cmdline-tools/latest/bin/avdmanager create avd -n yama_test -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_7
$SDK/emulator/emulator -avd yama_test
```

Homebrew の `avdmanager` は SDK のシステムイメージを見つけられないので、SDK 内の `cmdline-tools/latest` のものを使います。

現在地は `adb emu geo fix <経度> <緯度> <標高>` で動かせます。
記録を試すときは、これを数秒おきに少しずつずらしながら繰り返します。

## デバッグ

- **WebView の中を見る**：デバッグ版の APK なら、PC の Chrome で `chrome://inspect` を開くとアプリの WebView が表示されます。
  コンソール・ネットワーク・DOM を確認でき、`window.yamaMap` も使えます。
- **ネイティブのログ**：

  ```bash
  adb logcat | grep -iE "capacitor|geoloc|yamamap"
  ```

- **画面を消した状態を試す**：

  ```bash
  adb shell input keyevent KEYCODE_POWER
  ```

  もう一度送ると点きます。

ログに `Error injecting safe area CSS` が出ることがありますが、問題ありません。
Capacitor が画面端の余白の CSS を、ページが読み込まれる前に入れようとして失敗しているだけです。
表示されたあとに入れ直されるので、見た目には影響しません。

## 配布と署名

### 家族などに配る

APK ファイルをそのまま送ります（LINE・メール・Google ドライブなど）。受け取った人には次のように進めてもらいます。

1. ファイルを開き、「提供元不明のアプリ」のインストールを許可する（Android の画面の案内どおり）
2. 初めて記録を始めるとき、「通知」と「位置情報」を許可する。位置情報は「アプリの使用中のみ」で構いません。
   記録中は通知が出ているので、画面を消しても測位は続きます。
3. 機種によっては、電池の最適化でアプリが止められることがあります。
   その場合は「設定 → アプリ → やまマップ → 電池」で「制限なし」にしてもらいます。

### 署名とバージョン

- 今の APK は、ビルドした Mac のデバッグ用の鍵（`~/.android/debug.keystore`）で署名されています。
  **アップデートは同じ鍵で署名した APK でないと上書きできません**。
  別の PC でビルドした APK は、一度アンインストールしないと入らず、端末に保存した記録も消えます。
  ビルドする PC を決めておくか、鍵をバックアップしておきます。
- 長く配るなら、リリース用の鍵を作って `assembleRelease` で署名するほうが確実です。
  鍵は `keytool -genkey` で作り、`android/app/build.gradle` に `signingConfigs` を追加します。
  鍵とパスワードはコミットしないでください。
- `android/app/build.gradle` の `versionCode`（整数）と `versionName` は 1 / "1.0" のままです。
  Play ストアに出すときは、更新のたびに `versionCode` を上げる必要があります。
  APK を直接配るだけなら、上げなくても上書きできます。

### アプリの情報

| 項目 | 値・場所 |
|---|---|
| アプリID | `io.github.ma38su.yamamap`（`capacitor.config.ts`。変えると別アプリ扱いになる） |
| 表示名 | やまマップ（`capacitor.config.ts`、`android/app/src/main/res/values/strings.xml`） |
| 対応 Android | 7.0 以降（`minSdkVersion 24`）、`targetSdkVersion 36`（`android/variables.gradle`） |
| 記録中の通知 | アイコン `res/drawable/ic_tracking.xml`（山の形）。色 `#16805c`、チャンネル名「軌跡の記録」（`strings.xml`） |
| アプリのアイコン | PWA と同じ山のアイコン（`public/icons/icon.svg`）。アダプティブアイコンの前景は `res/drawable/ic_launcher_foreground.xml`、背景色は `res/values/ic_launcher_background.xml`（`#16805c`）。Android 7 以前向けの `res/mipmap-*/ic_launcher*.png` は `public/icons/icon-512.png` を `sips -z` で縮小したもの。アイコンを変えたら両方を作り直す |
| 起動画面 | Capacitor の初期画像のまま（`res/drawable*/splash.png`） |

## 確かめたこと・残っていること

エミュレータ（Android 16、Pixel 7）で次のことを確認しました。

- 許可が1つずつ出ること
- 画面を消したまま7分以上、記録が続くこと
- 記録の途中でアプリを入れ直しても、再開できること
- 停止で通知が消えること
- GPX を共有シートで書き出せること

残っていること：

- 実機での確認。特に、メーカー独自の省電力機能でアプリが止められないか
- 起動画面（スプラッシュ）の画像
- リリース用の鍵での署名
- 標高を気圧センサーで測る（今は標高タイルの値を使っている）
