# tests — 統合版の検証

## 単体・構造テスト（APIキー不要）

```
node tests/test_core.js     # core（util/aggregate/cost）の単体テスト
node tests/test_rules.js    # rules 定義の構造検証・項目数の突合
node tests/test_prompt.js   # プロンプト生成の網羅性（全項目の取りこぼしなし）
node tests/test_deterministic.js  # 決定論チェック（幅/デマンド/ケーブル配管/三者照合）
node tests/test_crosscheck.js     # 図面間整合性
node tests/test_vote.js           # 自己一致（多数決）マージ
node tests/test_reconcile.js      # 配線数値の三者照合
node tests/test_evalmetrics.js    # recall測定メトリクス
```

## recall測定（見逃し率）: ラベル付きマニフェスト

正解事例（全pass想定）だけでなく、**既知の不備がある図面**を expect 付きで与えると、
不備を捕まえられたか（recall）・過剰指摘（precision）・見逃し（FN）を数値化できる。

```
# 雛形: tests/manifest.sample.json（expect.items に項目ごとの既知状態を記載）
GEMINI_API_KEY=xxx node tests/regression.js --manifest tests/manifest.sample.json --model gemini-2.5-flash --out tests/results/recall.json
```
出力に `recall(不備の捕捉率) / precision(指摘の的中率) / ⚠見逃し一覧` が表示される。
※ 見逃し(FN)を意味あるものにするには、不備を含む実図面をマニフェストに加えること。

### ラベリング補助（recall測定の準備）

```
node tests/gen-labeling-assets.js   # check-ids.md（項目ID一覧）と manifest.starter.json を生成
```
- **手順書**: [RECALL_GUIDE.md](RECALL_GUIDE.md) … 不備事例のラベル付け〜測定〜改善サイクルの具体手順。
- **check-ids.md**: expect.items に書く項目IDの一覧（図面種別×事業区分ごと）。
- 実データ版は `manifest.local.json` 等の名前で作成（実案件名を含むため .gitignore 済み）。

### 判定の回帰差分（デグレ検知）
```
node tests/diff-baseline.js <baseline.json> <current.json>   # 項目単位の 厳格化/緩和/na変化 を表示
```

## 回帰検証 harness（P4）: tests/regression.js

既存4ツールの「正解事例」PDF を統合版の新パイプラインで判定し、
**正解事例は pass になるべき**という期待への乖離（＝回帰候補）を可視化する。
本番UI(app.js)と同一の core/rules/prompt を通すため、harnessと本番のロジック乖離が起きない。

### プラミング検証（APIキー不要・モック応答）

```
node tests/regression.js --mock --limit 2            # 各種別2件をモックで
node tests/regression.js --mock                      # 全件モック
```
モックは全項目 pass を返すので、PDF発見→プロンプト生成→解析→集計→判定の配線確認用。

### 実API検証（要 GEMINI_API_KEY）

⚠ APIキーは環境変数で渡す（チャット等に貼らない）。少額の課金が発生する。

```
# まず少量・安価モデルで動作と精度を確認（推奨）
GEMINI_API_KEY=xxx node tests/regression.js --type heimen --biz kiso --limit 3 --model gemini-2.0-flash

# 種別ごと・全件
GEMINI_API_KEY=xxx node tests/regression.js --type keitou --model gemini-2.5-flash --out tests/results/keitou.json

# 全4図面・全件
GEMINI_API_KEY=xxx node tests/regression.js --model gemini-2.5-flash --out tests/results/full.json
```

オプション: `--mock` `--limit N` `--type <mitori|heimen|haisen|keitou>` `--biz <kiso|mokutekichi>` `--model <id>` `--out <path>` `--sleep <ms>`

### 出力

`tests/results/*.json` に `{ meta:{total,pass,regression,error,estCostJpy}, results:[{type,biz,file,verdict,isRegression}] }`。
`isRegression:true`（正解事例なのに fail）は要目視確認。verdict.items に項目ごとの pass/fail/warn/na を記録。

> 注: `tests/results/` と正解事例PDF（`../【*】_要件判定チェックツール/素材/`）は .gitignore 対象。実案件図面はコミットしない。
