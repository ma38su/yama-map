# やまマップ（yama-map）

山歩き用の地図アプリ（PWA）。スマホのブラウザで開いて「ホーム画面に追加」すればアプリのように使えます。

- **現在地（GPS）** の表示と追従
- **2D / 3D 切り替え**（国土地理院の標高タイルで地形を立体表示）
- 地図タップで**その地点の標高**を表示
- **GPSで軌跡を記録**（距離・時間・累積標高の登り/下り）→ 端末に保存、**GPXで書き出し**
- **GPXルートの読み込み**（ヤマレコ・YAMAP 等の計画ルート）→ 標高グラフ、「ゴールまで◯km・登り残り◯m」
- **オフライン保存**：表示中の範囲の地図・標高を端末に保存（山の中の圏外対策）
- 背景地図：地理院 標準地図（等高線・登山道・山名入り）／淡色地図／航空写真、陰影起伏

## 使い方（開発）

```bash
npm install
npm run dev      # http://localhost:5173 （スマホ実機は同じWi-FiでPCのIPへ。ただしGPSはHTTPSが必要）
npm test         # ユニットテスト
npm run build    # dist/ に出力
```

GPS（位置情報）は **HTTPS でないと動きません**。スマホで試すには GitHub Pages に置くのが手軽です：

1. リポジトリの Settings → Pages → Source を **GitHub Actions** にする
2. `main` ブランチに push すると `.github/workflows/ci.yml` が `https://<ユーザー名>.github.io/yama-map/` に公開
3. スマホでそのURLを開き、共有メニューから「ホーム画面に追加」

## 設計メモ

### Webアプリ（PWA）か、ネイティブアプリか

| | PWA（今の実装） | ネイティブ / Capacitor 化 |
|---|---|---|
| 地図・3D・GPX・オフライン | ◯ | ◯（同じコードを流用） |
| 画面ONでの現在地・記録 | ◯ | ◯ |
| **画面OFF・ポケットの中での記録** | **✕（ブラウザが測位を止める）** | ◯ |
| 気圧センサーで正確な標高 | ✕ | ◯（iPhone等） |
| 配布 | URLを開くだけ | ストア申請 or 自分の端末へインストール |

**結論：まずPWAで地図まわりを作り込み、記録を本格的に使うなら Capacitor でアプリ化**するのがおすすめです。
地図・UI のコード（MapLibre + TypeScript）はそのまま使い回せ、GPS部分だけ
[`@capacitor-community/background-geolocation`](https://github.com/capacitor-community/background-geolocation)
などのネイティブプラグインに差し替えれば、画面を消したまま記録できます。

PWA版では代わりに、記録中は **Screen Wake Lock で画面を点けたまま** にしています（画面の明るさを最低にすると電池の減りを抑えられます）。

### 電池持ち

電池を食う順に「画面 ＞ GPS ＞ 通信（圏外で電波を探す） ＞ 3D描画」です。この実装での工夫：

- 記録は誤差40m超の測位を捨て、8m以上動いたときだけ保存（無駄な書き込み・処理を減らす）
- 標高は GPS 高度ではなく標高タイルから計算（GPS 高度は誤差が大きく、余計な補正処理も不要）
- 地図タイルはキャッシュ優先。**出発前に「表示中の範囲を保存」して機内モード＋GPS**で歩くと最も長持ち
- 3D は見たいときだけ ON（GPU を使うため 2D より電池を使う）

ネイティブ化すると、OS の省電力測位（iOS の `activityType = .fitness`、Android の Fused Location）や
画面OFFでの記録が使えるので、さらに有利です。

### 地図データ（オープンデータで足りるか）

**日本の山なら国土地理院の地理院タイルで十分実用になります。**

- 標準地図：等高線（10m間隔）、登山道（徒歩道）、山名・標高点、山小屋
- 標高タイル（DEM5A/DEM10B）：3D地形、陰影、標高・累積標高の計算に使用
- 出典の明示（「地理院タイル」）で無料で使えます。利用条件は [地理院タイル一覧](https://maps.gsi.go.jp/development/ichiran.html) と国土地理院コンテンツ利用規約を確認してください
- 地理院の標高PNGは MapLibre が直接読めない形式なので、`src/map/gsiDem.ts` でブラウザ内で Terrarium 形式に変換しています

補足：

- 登山道の情報は地図によって差があります。より新しい登山道情報が欲しければ **OpenStreetMap** 由来のデータ（例：Protomaps の PMTiles を自前でホスト）を重ねるのが次の候補です
- `tile.openstreetmap.org` や OpenTopoMap の公開タイルサーバーは、アプリからの大量利用・一括ダウンロードが利用規約で制限されているので使っていません
- オフライン保存は地理院サーバーに負担をかけないよう、同時4接続・最大4000枚に制限しています

## 構成

```
src/
  main.ts            画面の組み立て（地図・ボタン・メニュー）
  geo.ts             距離・タイル計算・累積標高などの計算
  map/style.ts       背景地図・陰影・2D/3D 切り替え
  map/gsiDem.ts      地理院標高タイル → 3D地形 変換、地点標高の取得
  track/recorder.ts  GPS 記録（フィルタ・Wake Lock・途中再開）
  track/db.ts        記録の保存（IndexedDB）
  track/gpx.ts       GPX 読み込み/書き出し
  ui/profile.ts      標高グラフ
  offline/download.ts 表示範囲の地図をオフライン保存
public/sw.js         Service Worker（アプリ本体と地図タイルのキャッシュ）
```

## 今後の候補

- [ ] Capacitor で iOS/Android アプリ化し、画面OFFでのバックグラウンド記録
- [ ] 気圧センサー（ネイティブ）で標高・累積標高の精度向上
- [ ] OpenStreetMap の登山道レイヤー、山小屋・水場などの POI
- [ ] ルートからの逸脱アラート（バイブ）
- [ ] 保存済みエリアの一覧・個別削除

> この地図は登山計画の参考です。紙の地図とコンパス、登山届の提出もお忘れなく。

地図・標高データ：[国土地理院（地理院タイル）](https://maps.gsi.go.jp/development/ichiran.html)
