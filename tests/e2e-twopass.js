#!/usr/bin/env node
/* ============================================================
   tests/e2e-twopass.js — 配線ルート図の2パス実走E2E（実API・Node）
   app.js の twoPass フローを忠実に再現し、実PDF×実Geminiで
   Pass1抽出→Pass2判定→マージ→色サニティ→検算→集計 を通す。
   ※Nodeではページ画像化ができないためネイティブPDF送信で実行
     （色観測はPDF内容に依存。観測不能なら色サニティが働くこと自体が検証項目）。
   使い方: node tests/e2e-twopass.js [PDFパス]（省略時: 合成不備の配線PDF）
   費用: Gemini 2.5 Flash ×2コール（概算 数円）
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const reg = require('../core/rules-registry.js');
require('../rules/haisen.js');
const prompt = require('../core/prompt.js');
const gemini = require('../core/gemini.js');
const vote = require('../core/vote.js');
const sanity = require('../core/colorsanity.js');
const verdict = require('../core/verdict.js');
const cost = require('../core/cost.js');

// .env.local からキー（値は出力しない）
(function loadEnv() {
  if (process.env.GEMINI_API_KEY) return;
  const p = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(p)) return;
  const m = fs.readFileSync(p, 'utf8').match(/^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/m);
  if (m) process.env.GEMINI_API_KEY = m[1].replace(/^["']|["']$/g, '').trim();
})();

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY 未設定'); process.exit(1); }
  // 既定PDF: _synthetic の配線ルート図（合成不備）から先頭の1件を動的選択（実案件名をコードに書かない）
  let pdfPath = process.argv[2];
  if (!pdfPath) {
    const dir = path.join(__dirname, '_synthetic');
    const cand = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.startsWith('haisen_') && f.endsWith('.pdf')).sort() : [];
    if (!cand.length) { console.error('合成不備PDFが見つかりません（tests/_synthetic/haisen_*.pdf）。パスを引数で指定してください'); process.exit(1); }
    pdfPath = path.join(dir, cand[0]);
  }
  const rule = reg.getRule('haisen');
  const biz = 'kiso';
  const MODEL = process.env.E2E_MODEL || 'gemini-2.5-flash';
  const images = [{ mimeType: 'application/pdf', base64: fs.readFileSync(pdfPath).toString('base64') }];
  let totalJpy = 0;
  const add = r => { const c = cost.estimateCost(r._usageMetadata, r._model); if (c) totalJpy += c.totalCostJpy; };

  console.log(`[E2E] ${path.basename(pdfPath)} / model=${MODEL} / 2パス実走`);
  // Pass1: 抽出専用
  const p1 = await gemini.callGeminiWithRetry(apiKey, images, prompt.buildPass1Prompt(rule, biz), MODEL, null, { pass: 1, total: 2 }, { maxOutputTokens: rule.settings.maxOutputTokens });
  add(p1);
  const pass1Data = (p1 && p1.detected_info) || null;
  if (!pass1Data) { console.error('[E2E] Pass1 失敗（detected_infoなし）'); process.exit(1); }
  const flags = Array.isArray(pass1Data.wire_annotations) ? pass1Data.wire_annotations.length : 0;
  console.log(`[Pass1] 旗上げ${flags}件 / 色観測: distinction=${JSON.stringify(pass1Data.wire_color_distinction)} legend=${JSON.stringify(pass1Data.color_legend_observed)}`);

  // Pass2: 判定専用
  const p2 = await gemini.callGeminiWithRetry(apiKey, images, prompt.buildPass2Prompt(rule, biz, pass1Data), MODEL, null, { pass: 2, total: 2 }, { maxOutputTokens: rule.settings.maxOutputTokens });
  add(p2);

  // app.js と同じ結線: merge → pass1統合 → 色サニティ → verdict
  const result = vote.mergeRuns([p2]);
  result.detected_info = Object.assign({}, result.detected_info || {}, pass1Data);
  const sr = sanity.apply(result);
  if (sr.count) console.log(`[色サニティ] ${sr.reason}: ${sr.count}件降格（${sr.downgrades.map(d => d.id).join(',')}）`);
  else console.log(`[色サニティ] 介入なし（観測色: ${JSON.stringify(sr.observed)}）`);

  const aggs = verdict.computeGroupAggs(rule, result, biz);
  aggs.forEach(({ group, agg }) => {
    console.log(`[総合] ${group}: ${agg.overall}（必須 ${agg.requiredPass}/${agg.requiredTotal}・fail${agg.requiredFail}・warn${agg.requiredWarn}・critical${agg.criticalFail}）`);
  });
  // 期待: 合成不備（作成日削除）→ creation_date が fail/warn で捕捉されること
  const items = [].concat(...aggs.map(a => a.agg.items));
  const cd = items.find(i => i.id === 'creation_date');
  console.log(`[注入不備の捕捉] creation_date = ${cd ? cd.status : '不明'}（期待: fail または warn）`);
  const rec = items.find(i => i.id === 'total_length');
  console.log(`[三者照合] total_length = ${rec ? rec.status : '—'} / ${(rec && rec.detail || '').slice(0, 140)}`);
  console.log(`[費用] 約 ${totalJpy.toFixed(1)} 円（2コール）`);
  const caught = cd && (cd.status === 'fail' || cd.status === 'warn');
  console.log(caught ? '\n✅ E2E成立: 2パス実走＋不備捕捉を確認' : '\n❌ E2E失敗: 注入不備を捕捉できず');
  process.exit(caught ? 0 : 1);
}
main().catch(e => { console.error('[E2E] エラー:', e.message); process.exit(1); });
