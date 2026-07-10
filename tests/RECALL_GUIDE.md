# recall測定 ラベリング手順書

## 目的
正解事例（合格図面）だけの検証では「良い図面を誤って落とさないか（過剰指摘）」しか分からない。
**「不備のある図面をちゃんと捕まえられるか（見逃し＝recall）」**を測るのがこの手順の狙い。
補助金ツールで最も危険なのは「合格と出たが実は不備」→提出→差戻し。ここを数値で管理する。

## 用意するもの
1. **Gemini APIキー**（`nev-drawing-checker/.env.local` に `GEMINI_API_KEY=...`）
2. **ラベル付き図面**（PDF）。特に **不備を含む図面**（過去の差戻し事例など）が recall 測定に必須。
   - 正解事例（合格図面）も混ぜると precision（過剰指摘の少なさ）も同時に測れる。

## 手順

### 1. 補助資産を生成
```
node tests/gen-labeling-assets.js
```
→ `tests/check-ids.md`（項目IDの一覧）と `tests/manifest.starter.json`（正解事例のパス雛形）ができる。

### 2. ラベル付きマニフェストを作る（manifest.local.json）
`manifest.starter.json` をコピーして `manifest.local.json` を作り、各図面の `expect.items` を記入する。
IDは `check-ids.md` を参照。状態は次の4値:
- `pass` … 要件を満たしている
- `fail` … 明確な不備（← これが「捕まえてほしい不備」）
- `warn` … 曖昧/要確認が妥当
- `na`  … 非該当（その図面の構成では対象外）

例（不備を含む電気系統図）:
```json
{
  "file": "C:/.../ある案件_電気系統図.pdf",
  "type": "keitou", "biz": "kiso",
  "expect": { "items": {
    "nev_main_breaker_capacity": "fail",   // ← 主幹容量が未記載＝捕まえてほしい不備
    "nev_title": "pass"
  }}
}
```
> 全項目を書く必要はない。**測りたい項目だけ**書けばよい（書いた項目のみ集計対象）。
> 実案件名を含むので manifest.local.json は .gitignore 済み（コミットされない）。

### 3. 測定を実行
```
GEMINI_API_KEY は .env.local から自動読み込み。安価モデルで少量から:
node tests/regression.js --manifest tests/manifest.local.json --model gemini-2.5-flash --out tests/results/recall.json
```

### 4. 結果を読む
標準出力に次が出る:
- **recall（不備の捕捉率）** = 捕まえた不備 / 全不備。1に近いほど見逃しが少ない。**最重要**。
- **precision（指摘の的中率）** = 正しい指摘 / 全指摘。1に近いほど過剰指摘が少ない。
- **⚠見逃し一覧** = 期待fail/warn なのに pass と判定した項目（危険な見逃し）。

### 5. 改善サイクル
- 見逃し(FN)が多い項目 → その rule の `description` を具体化、または決定論チェック追加を検討。
- 過剰指摘(FP)が多い項目 → 条件（na化）や warn 化を検討（2.4m幅・LBの前例参照）。
- 変更前後で `node tests/diff-baseline.js <旧> <新>` を実行し、デグレ（緩和/厳格化）を確認。
- 高精度モード（voting）の効果は、同一セットを通常/高精度で回して recall/precision を比較すれば数値化できる。

## 差戻し図面が無い場合（合成不備でrecall近似）

実際の差戻し図面が無くても、正解事例から**合成不備**を作って見逃し率を近似できる:

```
python tests/make-eval-manifests.py        # PyMuPDF必要
```
- **案X（recall近似）**: 正解事例の「作成日」テキストを redaction で実削除し、`tests/_synthetic/*_nodate.pdf` を生成。
  作成日は表題欄にのみ出る情報なので、除去＝その項目が確実に不備になる（クリーンな合成）。
  → `tests/manifest.synthetic.json`（expect: creation_date=fail）。ツールが「作成日なし」を捕まえれば recall にカウント。
- **案Y（precision）**: 正解事例(無改変)の表題欄コア項目に expect=pass を付与 → `tests/manifest.precision.json`。
  ツールがそれを fail にすれば過剰指摘。
- 実行: `node tests/regression.js --manifest tests/manifest.synthetic.json --model gemini-2.5-flash`
- ⚠ 近似の限界: 「要素の欠落」は測れるが、実際の不備（誤った値・微妙な仕様違反）ほど多様ではない。
  真のrecallには実差戻し事例が要る。合成はあくまで下限の目安。

## 課金なしでできる検証（無料枠・0円）

課金APIが無くても、次の3手段で検証できる。

### 1. 決定論カバレッジ（API不要・0件）
```
node tests/coverage-report.js
```
「AIの気分に依存せずコードで確定判定される項目」がどれだけあるかを静的に集計。
再現性100%で守られている検出範囲が分かる（例: 平面図の幅2.5m、配線の三者照合など）。

### 2. 無料枠の日次バッチ + 累積集計（0円・数日かける）
無料枠は毎日回復するので、1日十数件ずつ回して結果を積み上げる:
```
# 1日目（少量）。結果は tests/results/ に日付名で保存
node tests/regression.js --manifest tests/manifest.synthetic.json --limit 6 --model gemini-2.5-flash --out tests/results/day1-flash.json
# 別枠モデルも使うと1日の件数を増やせる（quotaは model 別）
node tests/regression.js --manifest tests/manifest.synthetic.json --limit 6 --model gemini-2.0-flash --out tests/results/day1-2flash.json
# 翌日以降も同様に追加 → 累積で集計（mock結果は自動除外・図面重複は最新採用）
node tests/aggregate-results.js
```
数日で数十件のサンプルになり、0円で recall/precision を安定測定できる。

**ワンコマンド運用**（1日1回これだけ。未測定分が翌日以降に自然に埋まる）:
```
node tests/daily-batch.js                    # 既定 gemini-2.5-flash で synthetic+precision を回し累積集計まで実行
node tests/daily-batch.js --model gemini-2.0-flash   # 別枠モデルで追加（1日の件数を増やせる）
```

### 3. UIでの人手スポット確認（無料枠内）
手元の図面を数枚 UI でチェックし、目視と突合。定性的だが即座に体感できる。

## コストの目安
1図面あたり約0.2〜0.3円（gemini-2.5-flash, 通常モード）。高精度モードは約3倍。
無料枠は1日あたり十数〜数十回で上限に達するため、全数は課金（Pay-as-you-go）有効化を推奨。
