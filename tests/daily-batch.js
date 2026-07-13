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
   ・支出上限ガード（組織方針: 上限に近づいたら警告・超過は◯円オーバー表示）:
     月次の概算コストを tests/results/cost-ledger.json に累積し、上限
     （既定500円/月・環境変数 DAILY_BATCH_CAP_JPY で変更）の80%で警告、超過で
     「◯円オーバー」を表示。**有料キーのときは超過で自動実行を中止**する。
     無料枠キーは超過しても実課金0円（枠超過はAPIが拒否するだけ）のため、
     警告表示のみで継続する（キー種別は起動時に checkPaidTier で自動判別）。
     ※累計はあくまで定価ベースの概算。無料枠内の実課金は0円。

   使い方: node tests/daily-batch.js [--model gemini-2.5-flash] [--limit 8] [--check-only]
   （.env.local の GEMINI_API_KEY を自動使用。--check-only はガード状態の確認のみで測定は実行しない）
   ============================================================ */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const gemini = require(path.join(__dirname, '..', 'core', 'gemini.js'));

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

// .env.local から GEMINI_API_KEY を読み込む（環境変数が無い場合のみ）。キー値は出力しない。
function loadEnvLocal() {
  if (process.env.GEMINI_API_KEY) return;
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const txt = fs.readFileSync(envPath, 'utf8');
  const m = txt.match(/^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/m);
  if (m) {
    let v = m[1].replace(/^["']|["']$/g, '').trim();
    if (v && v !== 'ここにキーを貼り付け') process.env.GEMINI_API_KEY = v;
  }
}

// ── 月次コスト台帳（概算・定価ベース） ──────────────────────
const LEDGER = path.join(__dirname, 'results', 'cost-ledger.json');
const monthKey = now.toISOString().slice(0, 7); // YYYY-MM
function readLedger() { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')) || {}; } catch (e) { return {}; } }
function writeLedger(l) { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2), 'utf8'); }
function addToLedger(jpy) {
  if (!(Number.isFinite(jpy) && jpy > 0)) return;
  const l = readLedger();
  l[monthKey] = Math.round(((Number(l[monthKey]) || 0) + jpy) * 100) / 100;
  writeLedger(l);
}

const jobs = [
  { name: 'synthetic(recall)', manifest: 'tests/manifest.synthetic.json', out: `tests/results/${stamp}-${hm}-synth-${model}.json` },
  { name: 'precision', manifest: 'tests/manifest.precision.json', out: `tests/results/${stamp}-${hm}-prec-${model}.json` },
];

(async () => {
  loadEnvLocal();
  if (!process.env.GEMINI_API_KEY) {
    console.error('[daily-batch] GEMINI_API_KEY がありません（.env.local を確認）。中止します。');
    process.exitCode = 2; return;
  }

  // ── 支出上限ガード ──────────────────────────────────────
  const capJpy = Number(process.env.DAILY_BATCH_CAP_JPY) || 500;
  const spent = Math.round((Number(readLedger()[monthKey]) || 0) * 100) / 100;
  let isPaid = true; // 判定に失敗したら保守側（有料扱い＝止まる側）に倒す
  try { isPaid = await gemini.checkPaidTier(process.env.GEMINI_API_KEY); } catch (e) { /* 保守側維持 */ }
  const tierNote = isPaid ? '有料キー（実課金あり）' : '無料枠キー（無料枠内の実課金は0円）';

  if (spent >= capJpy) {
    const over = Math.round((spent - capJpy) * 100) / 100;
    if (isPaid) {
      console.error(`[daily-batch]【料金上限】今月の概算累計 ${spent}円 が上限 ${capJpy}円 を ${over}円 オーバーしています。${tierNote}のため自動実行を中止します。上限変更は環境変数 DAILY_BATCH_CAP_JPY。`);
      process.exitCode = 3; return;
    }
    console.log(`[daily-batch]【注意】今月の概算累計 ${spent}円 が上限 ${capJpy}円 を ${over}円 オーバー（定価換算）。${tierNote}のため継続します。`);
  } else if (spent >= capJpy * 0.8) {
    console.log(`[daily-batch]【警告】今月の概算累計 ${spent}円 が上限 ${capJpy}円 の80%（${Math.round(capJpy * 0.8)}円）に到達しています。${tierNote}。`);
  }

  if (argv.includes('--check-only')) {
    console.log(`[daily-batch] check-only: キー種別=${tierNote} ／ 今月の概算累計=${spent}円 ／ 上限=${capJpy}円（80%警告=${Math.round(capJpy * 0.8)}円）`);
    return;
  }

  for (const j of jobs) {
    console.log(`\n===== ${j.name} (${model} / offset=${offset} limit=${limit}) =====`);
    try {
      execFileSync('node', [reg, '--manifest', j.manifest, '--offset', String(offset), '--limit', String(limit), '--model', model, '--sleep', '1500', '--out', j.out],
        { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    } catch (e) {
      console.log(`（${j.name} は一部/全部が失敗。無料枠超過なら翌日リトライで埋まります）`);
    }
    // 成否によらず、結果ファイルがあれば概算コストを月次台帳に加算
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(__dirname, '..', j.out), 'utf8'));
      addToLedger(Number(payload && payload.meta && payload.meta.estCostJpy) || 0);
    } catch (e) { /* 結果ファイルなし＝コスト加算なし */ }
  }

  console.log('\n===== 累積集計（mock除外・実測のみ） =====');
  try { execFileSync('node', [path.join(__dirname, 'aggregate-results.js')], { stdio: 'inherit', cwd: path.join(__dirname, '..') }); } catch (e) { /* 集計失敗は測定自体に影響しない */ }
  const total = Math.round((Number(readLedger()[monthKey]) || 0) * 100) / 100;
  console.log(`\n[daily-batch] 完了。今月の概算累計 ${total}円 / 上限 ${capJpy}円（${tierNote}）。明日以降も同じコマンドを実行すると、開始位置が日替わりでずれて未測定分が埋まっていきます。`);
})();
