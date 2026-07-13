# vendor/ — セルフホストしている第三者ライブラリ

CDN（cdnjs）障害時にツールが全停止する単一障害点を除去するため、
使用ライブラリを本リポジトリに同梱している（2026-07-13導入）。
**このディレクトリのファイルは手で編集しない**（更新は下記「更新手順」で丸ごと差し替え）。

## 同梱ファイルと出所

| ファイル | ライブラリ | バージョン | ライセンス | 取得元 |
|---|---|---|---|---|
| pdf.min.mjs | pdf.js (Mozilla) | 4.10.38 | Apache-2.0（LICENSE-pdfjs.txt） | cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/ |
| pdf.worker.min.mjs | pdf.js (Mozilla) | 4.10.38 | Apache-2.0（LICENSE-pdfjs.txt） | 同上 |
| xlsx.full.min.js | SheetJS Community Edition | 0.18.5 | Apache-2.0（LICENSE-sheetjs.txt） | cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/ |

## 完全性検証の記録（2026-07-13）

- `xlsx.full.min.js`: cdnjs 公式 SRI（api.cdnjs.com）の sha512 と**一致**。
- `pdf.min.mjs` / `pdf.worker.min.mjs`: cdnjs API は .mjs の SRI を提供しないため、
  **独立した2系統**（cdnjs と jsDelivr=npm パッケージ `pdfjs-dist@4.10.38` 由来）から取得して
  sha512 が**完全一致**することを確認した。

```
sha512(pdf.min.mjs)        = 2bbe7d51ca8f39acda45f6dfc615e7d401080cf083e86eeff0626d5769e70315a4aec5406786883eaaa26a4f63721ff57c2acc0a5cdc27c086c2c4bf92feb252
sha512(pdf.worker.min.mjs) = 2e43ff365d59334901966da62ef05e01e6b6011b0891bbc9fee5c22373fb2b7a1f0e69516279da84fbc72d0599779a78d154ab86d81d7e667bea6a40507c2c49
sha512(xlsx.full.min.js)   = af6da00a10e71af072964f74fb67bfc9caf7455ac38bc0c83a420636126529fbb240ce2d211008d3ad8c695f2c7e340a6151a338169904e03cef3f8885913d0c
```

再検証コマンド（このディレクトリで）:
`python -c "import hashlib;[print(f,hashlib.sha512(open(f,'rb').read()).hexdigest()) for f in ['pdf.min.mjs','pdf.worker.min.mjs','xlsx.full.min.js']]"`

## 更新手順（セキュリティ更新・CVE対応時）

1. 新バージョンの同名ファイルを cdnjs から取得し、可能なら jsDelivr 等の別系統とハッシュ突合する。
2. 本ファイルの表・ハッシュ・LICENSE を更新する。
3. `index.html` / `batch.html` の `?v=` キャッシュバスターをバンプする。
4. `node tests/run-all.js` 全合格＋ブラウザで実PDF読込・Excel出力を確認してから公開する。

## 注意

- pdf.js の既知CVE（CVE-2024-4367 等）はバージョン固定＋ `isEvalSupported:false` で対応済み。
  同梱化により**セキュリティ更新は自動では来ない**ため、pdf.js のセキュリティアドバイザリを
  年1回程度（要件改定プレイブック実行時）確認すること。
