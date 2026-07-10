#!/usr/bin/env node
/* ============================================================
   tests/daily-batch.js — 無料枠での日次測定バッチ（0円運用）
   1日1回これを実行するだけ。無料枠は毎日リセットするので、数日で
   合成不備(recall)＋正解事例(precision)の全件が測定され、累積集計に反映される。
   ・成功した図面は結果に残り、失敗(quota超過)は翌日リトライで自然に埋まる。
   ・aggregate-results.js が図面重複を「最新成功」で上書きするため、何度回してもOK。
   ・FM-2: 日替わりで --offset をローテーションし、--limit 固定でも全件を巡回する
     （旧実装は常に先頭N件固定で、後半の図面が永遠に測定されなかった）。
   ・FM-3: 出力ファイル名に時刻(HHMM)を含め、同日再実行が当日の成功結果を
     上書き消去しないようにする（累積集計は「最新成功」を採用するので追記で安全）。

   使い方: node tests/daily-batch.js [--model gemini-2.5-flash] [--limit 8]
   （.env.local の GEMINI_API_KEY を自動使用）
   ============================================================ */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const argv = process.argv.slice(2);
const model = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : 'gemini-2.5-flash';
const limit = Number(argv.includes('--limit') ? argv[argv.indexOf('--limit') + 1] : 8) || 8;
const now = new Date();
const stamp = now.toISOString().slice(0, 10);
const hm = now.toISOString().slice(11, 16).replace(':', ''); // FM-3: 同日再実行の上書き防止
// FM-2: 日数ベースのローテーション開始位置（regression.js 側で件数に応じて mod される）
const dayIndex = Math.floor(now.getTime() / 86400000);
const offset = dayIndex * limit;
const reg = path.join(__dirname, 'regression.js');

const jobs = [
  { name: 'synthetic(recall)', manifest: 'tests/manifest.synthetic.json', out: `tests/results/${stamp}-${hm}-synth-${model}.json` },
  { name: 'precision', manifest: 'tests/manifest.precision.json', out: `tests/results/${stamp}-${hm}-prec-${model}.json` },
];

for (const j of jobs) {
  console.log(`\n===== ${j.name} (${model} / offset=${offset} limit=${limit}) =====`);
  try {
    execFileSync('node', [reg, '--manifest', j.manifest, '--offset', String(offset), '--limit', String(limit), '--model', model, '--sleep', '1500', '--out', j.out],
      { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  } catch (e) {
    console.log(`（${j.name} は一部/全部が失敗。無料枠超過なら翌日リトライで埋まります）`);
  }
}

console.log('\n===== 累積集計（mock除外・実測のみ） =====');
try { execFileSync('node', [path.join(__dirname, 'aggregate-results.js')], { stdio: 'inherit' }); } catch (e) {}
console.log('\n[daily-batch] 完了。明日以降も同じコマンドを実行すると、開始位置が日替わりでずれて未測定分が埋まっていきます。');
