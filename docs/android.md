# Androidアプリ（Capacitor）

Android アプリ版は、PWA と同じ Web のコード（`dist/`）を [Capacitor](https://capacitorjs.com) の WebView に入れたものです。
アプリにした目的は、**画面を消したままでも軌跡を記録できる**ようにすることです。
ブラウザの位置情報（`watchPosition`）は、画面オフやバックグラウンドで止まってしまいます。
アプリ版の記録は、アプリの中のフォアグラウンドサービスが測位して端末に保存するので、画面を消しても、ほかのアプリを使っても、
アプリを履歴からスワイプして消しても続きます。止まるのは「記録終了」か、通知の「停止」を押したときだけです。

iOS 版はありません（Xcode と Apple Developer Program が必要なため保留）。

## Web版との違い

アプリかどうかは `Capacitor.isNativePlatform()` で判定し、`src/track/location.ts` の `backgroundCapable` として使います。
違うのは次の部分だけで、ほかは Web 版と同じ動きです。

| 場所 | Web版 | アプリ版 |
|---|---|---|
| 記録の測位（`track/location.ts`） | `navigator.geolocation.watchPosition` | アプリの中のフォアグラウンドサービス（`TrackingService.java`）。届いた測位をその場で端末（SQLite）に保存する。JS は保存の知らせ（最大20秒ぶんまとめて）と、表に出たときに取り込む。記録中は通知「やまマップで記録中」（経過時間・距離・停止ボタン）が出る |
| 許可（`requestTrackingPermissions`） | ブラウザに任せる（拒否済みなら記録を始めない） | 記録開始時に、通知 → 位置情報の順に**1つずつ**求める（位置情報は `TrackingPlugin` の `requestPermissions`）。位置情報を拒否されたら記録を始めない |
| 戻るボタン（`app/backButton.ts`） | ブラウザに任せる | アプリを終了しない。メニュー → 地図の吹き出し → 下のシート → リプレイの順に閉じ、何もなければ裏に回す（`@capacitor/app`） |
| 画面に戻ったとき（`track/recorder.ts`） | 測位をやり直す | ネイティブの記録は止まらないので、やり直さず、たまった測位を取り込む |
| アプリを開いたとき（`app/recording.ts` の `checkUnfinished`） | 記録中のまま閉じていたら、続けるか聞く | 裏で記録が続いていれば、聞かずに取り込んで続ける。通知の「停止」で止めていれば、そこまでで締める。端末の再起動などで止まっていたら、続けるか聞く |
| 地図の青い現在地マーク（`app/recording.ts` の `feedNativeFix`） | WebView の位置情報 | WebView の位置情報が古いときは、ネイティブの位置で上書きする |
| 画面を点けたままにする（`settings.ts`） | 初期値オン | 初期値オフ。メニューの説明文も差し替える（`app/menu.ts`） |
| 「画面を消すと記録が止まります」の警告（`app/status.ts`） | 出す | 出さない |
| GPX・動画の書き出し（`ui/dom.ts` の `download`） | `<a download>` | キャッシュフォルダに書き出し、共有シートを開く（`@capacitor/filesystem`・`@capacitor/share`）。動画は3MBずつ書き足す |
| メニューの「ホーム画面に追加」（`app/install.ts`） | 出す | 出さない |
| Service Worker（`src/sw.js`） | アプリ本体と地図タイルをキャッシュ | 地図タイルだけ（`./sw.js?native=1` で登録）。アプリ本体は APK に入っている |

### なぜこうしているか

- **記録の点をネイティブ側で保存する理由**：以前は `@capacitor-community/background-geolocation` から測位を JS に届け、JS が IndexedDB に保存していました。
  このプラグインは画面（Activity）の終了と一緒に測位サービスを止めるうえ、WebView が止まると点が保存されないので、
  履歴からスワイプしたときや OS に画面を止められたときに記録が途切れました。今はサービスが画面と関係なく動き続け、点はその場で SQLite に入ります。
  JS は取り込んで IndexedDB に保存し終えたら、端末側の点を消します（`clearFixes`）。
- **測位の間隔とまとめて受け取る理由**：測位は1秒間隔の高精度で、5m 動いたときだけ受け取ります（記録は8m以上動いたときだけ点を足すので、記録は変わらない）。
  さらに最大20秒ぶんをまとめて受け取ります（`setMaxUpdateDelayMillis`）。止まっていれば何も届かず、歩いていても最大20秒に1回しか JS を起こしません。
- **許可を1つずつ求める理由**：WebView の位置情報（地図の現在地表示）と記録の許可を同時に求めると、許可ダイアログが2枚重なります。
  すると Android のタップ乗っ取り対策で、どちらのダイアログも押せなくなります。そのため記録開始前に順番に許可を求めています。
- **通知の許可を `@capacitor/local-notifications` で求める理由**：Android 13 以降は、記録中の通知を出すのに通知の許可が要ります。
  WebView には Notification API が無いので、このプラグインを許可の取得にだけ使っています。
  通知を拒否されても測位は続きます。
- **`useLegacyBridge: true`（`capacitor.config.ts`）の理由**：これが無いと、裏に回って5分ほど経つと、ネイティブから JS への知らせ（`notifyListeners`）が届かなくなります。
  道迷いアラートは、画面を消していても点が届くたびに判定するので、知らせが届く必要があります（届かなくても点は端末に残り、表に出たときに取り込まれます）。
- **現在地マークを上書きする理由**：画面オフから戻った直後は、WebView の位置情報の再開に数秒かかります。
  その間、記録の線は最新の位置まで伸びているのに、マークだけが遅れて見えます。
- **戻るボタンでアプリを終了しない理由**：Android 11 以前は、戻るボタンで画面が終了します。記録は続きますが、次に開くときに地図や WebView を作り直すことになり、
  開いていたシートや表示の状態もなくなるので、裏に回すだけにしています。
- **定期処理を表のときだけ動かす理由**：Capacitor は、裏に回っても JS のタイマーを止めません（`KeepRunning` の初期値）。
  記録中はアプリが動き続けるので、到着予想や空の色の定期処理は、画面が表のときだけ動かしています（`app/scheduler.ts`）。

## 使っているプラグイン

バージョンは `package.json` で固定しています。Capacitor 本体（`@capacitor/core`・`android`・`cli`）は揃えて上げます。

| パッケージ | 用途 |
|---|---|
| `@capacitor/core`・`@capacitor/android`・`@capacitor/cli` | Capacitor 本体（8.x） |
| `@capacitor/local-notifications` | 通知の許可を求める。道迷いアラートの通知 |
| `@capacitor/filesystem`・`@capacitor/share` | GPX・動画の書き出し |
| `@capacitor/app` | 戻るボタン（アプリを終了せず、裏に回す） |

アプリの中に作ったもの（`android/app/src/main/java/io/github/ma38su/yamamap/`。`MainActivity` で登録する）：

| ファイル | 用途 |
|---|---|
| `TrackingService.java` | 軌跡の記録（位置情報タイプのフォアグラウンドサービス）。測位は `play-services-location` の FusedLocationProviderClient。気圧計があれば気圧も点に付ける。通知の経過時間・距離・停止ボタン |
| `TrackingStore.java` | 記録中の測位を入れておく SQLite（`tracking.db`） |
| `TrackingPlugin.java` | JS（`src/track/location.ts`）から使う `Tracking`。`start`・`stop`・`status`・`getFixes`・`clearFixes` と、位置情報の許可 |
| `BarometerPlugin.java` | 気圧計（`src/track/barometer.ts`）。記録中の今の標高を気圧から求める |

アプリが求める主な権限は、位置情報（精密・おおよそ）、フォアグラウンドサービス（位置情報）、通知、インターネット、振動です。
通知の許可（`POST_NOTIFICATIONS`）は `@capacitor/local-notifications` のマニフェストから入り、ほかは `AndroidManifest.xml` に書いています。
記録のサービスは `exported="false"` で、ほかのアプリからは使えません。

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
- 常駐させて長く使うなら、リリース版をリリース用の鍵で署名して入れるほうが確実です。
  デバッグ版は USB で WebView の中身を見られる状態で（`chrome://inspect`）、動作もやや遅くなります。
- 版は `package.json` の `version` から決めます（`android/app/build.gradle`）。
  `"1.2.3"` なら `versionName` は `1.2.3`、`versionCode` は `10203` です。
  **更新のたびに `package.json` の version を上げてください**（versionCode が下がると上書きできません）。

#### リリース版を作る

1. 鍵を作ります（初回だけ）。`android/` で次を実行し、パスワードを決めます。

   ```bash
   keytool -genkeypair -v -keystore yamamap-release.jks -alias yamamap -keyalg RSA -keysize 4096 -validity 36500
   ```

2. `android/keystore.properties` を作ります。

   ```properties
   storeFile=yamamap-release.jks
   storePassword=（決めたパスワード）
   keyAlias=yamamap
   keyPassword=（決めたパスワード）
   ```

   `keystore.properties` と `*.jks` は `android/.gitignore` でコミットしないようにしています。
   **鍵とパスワードをなくすと、同じアプリとして上書き更新できなくなります**。パスワードマネージャーなどに控えておきます。

3. ビルドして入れます。

   ```bash
   npm run android:release
   adb install -r android/app/build/outputs/apk/release/app-release.apk
   ```

   `keystore.properties` がないと、署名していない `app-release-unsigned.apk` ができます（端末には入りません）。

デバッグ版からリリース版に切り替えるときは、鍵が違うので一度アンインストールが要ります（端末の記録は消えるので、先に GPX で書き出しておきます）。

### アプリの情報

| 項目 | 値・場所 |
|---|---|
| アプリID | `io.github.ma38su.yamamap`（`capacitor.config.ts`。変えると別アプリ扱いになる） |
| 表示名 | やまマップ（`capacitor.config.ts`、`android/app/src/main/res/values/strings.xml`） |
| 対応 Android | 7.0 以降（`minSdkVersion 24`）、`targetSdkVersion 36`（`android/variables.gradle`） |
| 記録中の通知 | アイコン `res/drawable/ic_tracking.xml`（山の形）。色 `res/values/colors_tracking.xml`（`#16805c`）、チャンネル名「軌跡の記録」・文言・停止ボタン（`strings.xml` の `tracking_*`） |
| アプリのアイコン | PWA と同じ山のアイコン（`public/icons/icon.svg`）。アダプティブアイコンの前景は `res/drawable/ic_launcher_foreground.xml`、背景色は `res/values/ic_launcher_background.xml`（`#16805c`）。Android 7 以前向けの `res/mipmap-*/ic_launcher*.png` は `public/icons/icon-512.png` を `sips -z` で縮小したもの。アイコンを変えたら両方を作り直す |
| 起動画面 | Capacitor の初期画像のまま（`res/drawable*/splash.png`） |
| 自動バックアップ | 記録（IndexedDB）と設定は残し、保存した地図（WebView の `Service Worker/` フォルダ）は除く（`res/xml/backup_rules.xml`・`data_extraction_rules.xml`）。地図を含めると上限の25MBを超え、バックアップ自体がされなくなるため。除く場所は WebView の版で変わる可能性があるので、実機で確かめる |

## 確かめたこと・残っていること

エミュレータ（Android 16、Pixel 7）で次のことを確認しました。

- 許可が1つずつ出ること
- 画面を消したまま7分以上、記録が続くこと
- 記録の途中でアプリを入れ直しても、再開できること
- 停止で通知が消えること
- GPX を共有シートで書き出せること

2026-11-15 に、記録をネイティブ側で保存する作りにして、エミュレータ（Android 16、Pixel 7）で次のことを確認しました。

- 記録中に履歴からアプリを消して（`adb shell am stack remove <タスク番号>`）も、通知が残って測位が続くこと
- そのあとアプリを開くと、聞かずに同じ記録を続け、消していた間の点も取り込まれること
- 通知の「停止」で、アプリが開いていれば記録が締まること。アプリを消したあとに止めた場合も、次に開いたときに締まること
- 「記録終了」で記録が締まり、端末側の点が消えること
- 点に気圧が付くこと

戻るボタン・バックアップの除外・リリース版の署名は、エミュレータ・実機ではまだ確かめていません。

残っていること（詳しくは [常駐アプリとしての改善計画](android-plan.md)）：

- システムに止められたあとの再起動（`START_STICKY`）で記録が続くか。Android 12 以降は裏からフォアグラウンドサービスを始められないことがある
- 実機での確認。特に、メーカー独自の省電力機能でアプリが止められないか
- 起動画面（スプラッシュ）の画像
- リリース用の鍵を作って署名する（ビルドの準備は済み）
- 標高を気圧センサーで測る（今は標高タイルの値を使っている）
