# コードの構成と仕組み

やまマップは MapLibre GL JS + TypeScript + Vite の PWA です。フレームワークは使わず、画面は `index.html` の要素を直接書き換えています。
Android アプリ版（Capacitor）も同じコードで、記録の測位だけが切り替わります。

## フォルダ

```
index.html            画面の骨組み（地図・下のシート・メニュー）
src/
  main.ts             起動の手順（地図の読み込み後の初期化、Service Worker）
  settings.ts         端末に保存する設定、空の色を決める時刻
  style.css
  app/                画面の各部分（地図・シート・メニューなど）。DOM と状態をつなぐ
  map/                地図のスタイル・3D地形・空の色・指の操作
  nav/                ルート・到着予想・日の出日の入り（DOM に触れない計算）
  route/              道データの読み込みと経路探索
  track/              記録（測位・保存・GPX・実績・想定の記録）
  offline/            地図のオフライン保存
  ui/                 汎用の部品（シート・標高グラフ・DOM の小物）
public/
  sw.js               Service Worker（アプリ本体と地図タイルのキャッシュ）
  routes/             おすすめルートの GPX
test/                 vitest のユニットテスト（nav・track・map の計算が中心）
android/              Capacitor の Android プロジェクト（docs/android.md）
```

`nav/`・`route/`・`track/`・`map/` の計算部分は DOM に依存しないので、テストから直接呼べます。画面に関わるものは `app/` に置いています。

## 画面の各部分（`src/app/`）

| ファイル | 役割 |
|---|---|
| `state.ts` | ファイルをまたいで変わる値（ルート・表示中の記録・最後の到着予想・現在地・読み込み中の表示） |
| `mapView.ts` | 地図本体、3D ボタン（`setTerrain`）、ルート・記録・リプレイを描く層、空の色の更新、`fitTo` |
| `mapTap.ts` | 地図をタップしたときの吹き出し（出発地・経由地・目的地を選ぶ） |
| `route.ts` | ルートを作る・選び直す・消す、GPX の読み書き |
| `nav.ts` | 到着予想の計算（`computeNav`）と画面への反映（`updateNav`、15秒ごと） |
| `sheetView.ts` | 下のシート：カード、行程タブ、出発時刻、記録を開いているときの実績 |
| `profileView.ts` | 標高グラフ（ルート／記録の切り替え、区間ごとのペース） |
| `recording.ts` | 現在地、記録の開始・終了、記録を開く・閉じる（`viewingTrack` / `closeTrack`）、途中で閉じた記録の再開 |
| `replay.ts` | 記録の 3D リプレイ |
| `replayVideo.ts` | リプレイの録画（webm） |
| `status.ts` | 上の状態表示 |
| `menu.ts` | メニュー（ルートの探し方・ペース・地図・記録の一覧・最初から入れる予定の記録） |
| `weather.ts` | 天気予報の取得と保存、行程に出す天気（`weatherFor`）、3D の雲の層と雨・雪 |
| `install.ts` | メニューの「ホーム画面に追加」 |
| `offline.ts` | 地図の保存ボタン |

モジュール同士はお互いを読み込んでいます（例：`nav.ts` ⇄ `sheetView.ts`）。
起動時に読み込みの順番でエラーにならないよう、**ファイルをまたいで使うのは関数（`export function`）だけ**にし、
変わる値は `state` オブジェクトの中に置いています（`export let` は読み込んだ側から書き換えられないため）。

### 画面の流れ

```
測位・記録の更新・15秒ごと
        │
        ▼
   updateNav()  ── computeNav()：ルート上の位置、ペース、各地点の到着予想
        │
        ├─ renderCard()    バー上部（記録を開いているときは実績）
        ├─ renderBody()    シートが開いていれば行程・標高グラフ・ペース
        └─ renderStatus()  上の状態表示
```

状態を変えたら `updateNav()` を呼べば、画面全体がそれに合わせて描き直されます。

### 画面のモード

| モード | 条件 | カード・行程 | 下のボタン |
|---|---|---|---|
| 計画 | 記録していない・記録を開いていない | 到着予想（「今すぐ」または指定した時刻に出発） | 記録開始 |
| 記録中 | `recorder.recording` | 現在地からの到着予想（実績のペースで調整） | 記録終了 |
| 記録を開いている | `viewingTrack()`（記録していない かつ `state.shown` がある） | 出発・目的地の実績、通過した地点・休憩・到着の時刻 | リプレイ・閉じる |

記録を終えたときも、その記録を開いた状態になります。

## 主な仕組み

### 到着予想（`nav/eta.ts`）
- `RouteTimeline`：ルートを50mごとに区切り、標準の歩行時間（Tobler のハイキング関数×0.8）を累積しておく
- `analyzePace`：記録から登り・平坦・下りそれぞれの「標準の何倍か」と休憩の割合を求める。記録が少ないうちは設定のペースに寄せる
- `splitMoving`：90秒以上空いていて秒速0.15m未満しか進んでいない区間を休憩とみなす
- `estimate`：ルート上の2点間の歩行時間＋休憩の見込み
- `paceSegments`：記録を100〜500mの区間に分けた、区間ごとのペース（標高グラフの色分け）

### ルート（`nav/plan.ts`・`route/`）
- 国土地理院の最適化ベクトルタイルと OpenStreetMap（OpenFreeMap）の道データから道のネットワークを作り、`trailRouter.ts` で最短経路を探す
- 「登山道優先」「別ルート」「最短距離」「登山道優先（OSM）」の候補を作り、設定の「ルートの探し方」に合うもの（`preferredOption`）を表示する
- 表示中のルートは `localStorage`（`yama-map:route`）に保存し、次の起動で戻す

### 記録（`track/`）
- `location.ts`：測位元。Web は `watchPosition`、アプリ版はネイティブのバックグラウンド測位（`backgroundCapable` で判定）
- `recorder.ts`：誤差40m超の測位を捨て、8m以上動いたときだけ点を足す。Web 版は設定で画面を点けたままにする（Wake Lock）
- `db.ts`：IndexedDB（`yama-map`）の `tracks`（記録の概要）と `points`（点）に保存
- `actual.ts`：記録の実績。ルートの地点を80m以内で通った時刻、3分以上の休憩、区間ごとの距離・登り下り・所要時間を出す
- `sample.ts`：ルートを標準タイムの決まった倍率で歩き、歩行30分ごとに休んだ想定の記録を作る。最初から入れる「予定」の記録（`menu.ts` の `ensureBuiltinPlan`）に使う。一度入れたら `settings.builtinPlan` を立て、消しても戻さない

### 標高グラフ（`ui/profile.ts`）
- canvas に描く。横軸は距離と時刻で切り替え、ピンチ・Ctrl+ホイール・ボタンで横に拡大
- 記録のときは区間ごとのペースで塗り分け（遅いほど赤、速いほど青）、下に速さの帯、休憩を灰色の帯と「休」の印で出す
- `setSeries(series, key)` の `key` が変わったときだけ表示範囲を戻す（GPS の更新で拡大が戻らないように）

### 3D リプレイ（`app/replay.ts`）
- `requestAnimationFrame` ごとに再生中の時刻を進め、点の時刻から位置を補間して `replay`（今の位置）と `replay-done`（歩き終えた線）の層を更新する
- カメラは120m先の点の方へ少しずつ向きを変えて追いかける。シートに隠れないよう、地図の padding を下に取る
- 点と点のあいだが90秒以上空いているところ（休憩）は10倍で送る
- 標高グラフにも今の位置の印を出す
- 空と地図の色、雲と雨は再生中の時刻に合わせる（`state.daylightAt`。再生中の時刻が2分動くごとに更新し、終えたら今の時刻に戻す）

### リプレイの録画（`app/replayVideo.ts`）
- 地図の `render` イベントのたびに、地図の canvas のうちシートに隠れていない部分と雨・雪の canvas、字幕（記録の名前と時刻）を別の canvas に写す。地図の canvas は描いた直後でないと中身を読めない（`preserveDrawingBuffer` を使わずに済ませるため）
- その canvas を `captureStream(30)` と `MediaRecorder` で webm（VP9 → VP8 の順に使えるもの。webm を作れない Safari では mp4）に記録する。長いほうの辺は1280pxまで
- 最初の場面を写してから記録を始める。最後まで再生するか、録画ボタン・リプレイの終了で止めて保存する（アプリ版は共有シート）
- MediaRecorder の webm には長さの情報が入らないので、再生ソフトによっては長さが出ず、途中へ飛べないことがある

### 空と地図の色（`map/daylight.ts`・`nav/sun.ts`）
- `sunPosition`：NOAA の式で太陽の高度・方位を求める
- 太陽の高度ごとに決めた色の表（`SKY_STOPS`・`TONE_STOPS`）を補間して、空（`setSky`）、地図の明るさ・彩度、色を重ねる層（`daylight-tint`）を決める
- 陰影の光の向きを太陽に合わせる（夜は通常の北西からの光）
- 1分ごとに更新。URL の `?time=18:30` でその時刻の見え方を確かめられる

### 天気（`nav/weather.ts`・`app/weather.ts`）
- [Open-Meteo](https://open-meteo.com/) の1時間ごとの予報（降水確率・降水量・天気・雲量・気温・風）を使う。API キー不要で、複数の地点を1回で問い合わせられる
- 予報は約5km（0.05度）のマス目ごとに取る。描画中に頼まれたマス目を200ms待ってまとめて問い合わせ、届いたら `updateNav()` で描き直す
- 取った予報は `localStorage`（`yama-map:weather`）に3日分残し、1時間経ったら取り直す。圏外で取れないマス目は5分間は問い直さない
- 時刻の天気は前後の時刻で補間する（`weatherAt`）。降水確率と天気は近いほうの時刻の値
- 3D の雲：地図の中心のまわり9×9マスの雲量を補間し、つながったノイズの模様で切り取った画像を `image` ソースで地形にかける。模様は地上の風の3倍の速さで風下に流す。時刻が10分動くか、中心のマス目が変わったら描き直す
- 雨・雪：画面を6×10のマスに区切り、マスの真ん中が地図のどこに当たるか（`unproject`）を求めて、その場所の降水量に見合う割合の雨粒（雪なら雪片）を地図の上の canvas に描く。予報で降っていない場所には描かない。地図を動かしたら300msごとに数えなおす（3D のときだけ）
- 設定：`weather`（行程の天気）と `weatherFx`（3D の雲・雨・雪と曇りの空）を分けている。演出は予報を出しているときだけ
- 空の色は雲量に合わせて灰色に寄せ、厚い雲では日差しの陰影を弱める（`overcastSky`）。`mapView.ts` から `weather.ts` を読み込むと地図ができる前に動いてしまうので、`hookDaylight` で登録している

### 指の操作（`map/gestures.ts`）
3D のときは1本指のドラッグで回転・傾き、2本指で移動にしています。
MapLibre の1本指の移動を止めるのに、内部のプロパティ（`dragPan._touchPan._shouldBePrevented`）を上書きしています。
MapLibre を更新したときは、この仕組みが残っているか確かめてください（なければ何もしないようにしてあります）。

### オフライン（`offline/download.ts`・`public/sw.js`）
- アプリ本体は `yama-map-shell-v1`、地図タイルは `yama-map-tiles-v1` のキャッシュに入れる
- 地図の保存は地理院サーバーに負担をかけないよう、同時4接続・最大4000枚に制限

## 端末に保存するもの

| 場所 | キー | 中身 |
|---|---|---|
| localStorage | `yama-map:settings` | 設定（背景地図・陰影・空の色・3D・天気・ペース・ルートの探し方・出発時刻・地図の位置・予定の記録を入れたか） |
| localStorage | `yama-map:route` | 表示中のルート |
| localStorage | `yama-map:weather` | 天気予報（マス目ごと、3日分） |
| IndexedDB | `yama-map`（`tracks` / `points`） | 記録 |
| Cache Storage | `yama-map-shell-v1` / `yama-map-tiles-v1` | アプリ本体・保存した地図 |

## テスト

```bash
npm test
```

`test/` には到着予想・ペース分析・GPX・標高タイルの変換・経路探索・空の色・想定の記録・実績・天気予報の読み取りのテストがあります。
画面（`src/app/`）のテストはないので、画面を変えたら `npm run dev` で動作を確かめてください。
