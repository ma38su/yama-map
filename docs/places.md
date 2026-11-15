# 場所のファイルの読み込み

地図の右上の「重ねる情報」ボタン →「場所のファイルを読み込む」で、自分で用意した地点（コメント・写真付き）を地図に出せます。
読み込んだ地点は「読み込んだ場所・コメント」（💬・赤紫）の吹き出しで出て、タップするとコメントや写真が見られます。
端末に残るので圏外でも出ます。ファイルごとに「重ねる情報」の画面から削除できます。

読み込めるのは次の2つです。

## GeoJSON

`Point` の `Feature` を並べた `FeatureCollection`（`Feature` 1つでも可）。線や面は読み飛ばします。

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [139.4185, 36.8725] },
      "properties": {
        "name": "八丁の湯の先の分岐",
        "comment": "右へ。道標あり\n雨のあとは滑りやすい",
        "photo": "https://example.com/photo.jpg",
        "time": "2026-10-01T09:00:00+09:00",
        "author": "自分",
        "url": "https://example.com/notes/1"
      }
    },
    {
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [139.4145, 36.8685] },
      "properties": { "name": "沢の水", "category": "water" }
    }
  ]
}
```

`properties` で読む名前（どれも省略できます。左にあるものを優先）：

| 項目 | 名前 |
|---|---|
| 名前 | `title` / `name` |
| コメント（改行で複数行） | `comment` / `description` / `desc` / `text` / `body` |
| 写真の URL（`data:` も可） | `photo` / `image` / `img` |
| 小さな写真の URL（なければ写真を使う） | `thumb` / `thumbnail` |
| 時刻（ISO 8601 など） | `time` / `date` / `datetime` |
| 元のページ | `url` / `link` / `href` |
| 書いた人・撮った人 | `author` / `credit` / `user` / `by` |
| ライセンス | `license` |
| 種類 | `category` / `cat`：`hut`（山小屋）・`water`（水場）・`toilet`・`camp`・`view`（展望地）・`onsen`・`fall`（滝）。それ以外・なしは「読み込んだ場所・コメント」 |

写真の URL が `https://` のものは、ルート沿いのオフライン保存で縮小画像（`thumb`、なければ `photo`）も保存します。

## GPX

ウェイポイント（`<wpt>`）を読みます。名前（`<name>`）・説明（`<desc>`、なければ `<cmt>`）・リンク（`<link href>`）・時刻（`<time>`）を使います。
経路（`<trk>`・`<rte>`）はここでは読みません（ルートとして読むときは、メニューの「GPXを読み込む」）。

## 注意

ほかのサービスの投稿（写真・コメント）は、そのサービスの利用規約と投稿者の権利に従って扱ってください。
自分で書いたメモ・自分で撮った写真・自由なライセンスで公開されているもの・公式に書き出せるデータを使うのが確実です。
