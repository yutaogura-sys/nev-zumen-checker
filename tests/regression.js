#!/usr/bin/env node
/* ============================================================
   tests/regression.js — 統合版の回帰検証harness（P4）
   ------------------------------------------------------------
   既存4ツールの「正解事例」PDF を、統合版の新パイプライン
   （prompt.js → gemini.js → aggregate.js）で判定し、
   正解事例は pass となるべき、という期待に対する乖離を可視化する。

   本番UI(app.js)と同一の core/rules/prompt を通すため、harnessと本番の
   ロジック乖離が原理的に起きない（＝評価の信頼性）。

   使い方:
     # プラミング検証（APIキー不要・モック応答で全項目pass）
     node tests/regression.js --mock --limit 2

     # 実API（要 GEMINI_API_KEY）。まず少量・安価モデルで
     GEMINI_API_KEY=xxx node tests/regression.js --type heimen --biz kiso --limit 3 --model gemini-2.0-flash

     # 全件
     GEMINI_API_KEY=xxx node tests/regression.js --model gemini-2.5-flash --out tests/results/full.json

   オプション: --mock --limit N --type <mitori|heimen|haisen|keitou> --biz <kiso|mokutekichi>
              --model <id> --out <path> --sleep <ms>
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const reg = require('../core/rules-registry.js');
const prompt = require('../core/prompt.js');
const agg = require('../core/aggregate.js');
const cost = require('../core/cost.js');
const gemini = require('../core/gemini.js');
const det = require('../core/deterministic.js');
const verdictCore = require('../core/verdict.js');
['mitori', 'heimen', 'haisen', 'keitou'].forEach(t => require('../rules/' + t + '.js'));

// 統合フォルダ（nev-drawing-checker の親）
const INTEG_ROOT = path.resolve(__dirname, '..', '..');
const TOOL_DIR = {
  mitori: '【設置場所見取図】_要件判定チェックツール',
  heimen: '【平面図】_要件判定チェックツール',
  haisen: '【配線ルート図】_要件判定チェックツール',
  keitou: '【電気系統図】_要件判定チェックツール',
};

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

function parseArgs(argv) {
  const a = { mock: false, limit: 0, offset: 0, type: null, biz: null, model: 'gemini-2.5-flash', out: null, sleep: 500, manifest: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--mock') a.mock = true;
    else if (k === '--limit') a.limit = Number(argv[++i]) || 0;
    else if (k === '--offset') a.offset = Number(argv[++i]) || 0;
    else if (k === '--type') a.type = argv[++i];
    else if (k === '--biz') a.biz = argv[++i];
    else if (k === '--model') a.model = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--sleep') a.sleep = Number(argv[++i]) || 0;
    else if (k === '--manifest') a.manifest = argv[++i];
  }
  return a;
}

// ── recall測定: 期待値と実測の項目単位比較 ────────────────────────
// results: [{ type, biz, file, verdict:{items:{id:status}}, expect:{items:{id:status}} }]
// 「不備＝期待が fail/warn」を「捕まえた＝実測が fail/warn」で分類。
//   TP: 不備を捕捉 / FN: 不備の見逃し（期待fail→実測pass, 最も危険）/ FP: 過剰指摘 / TN: 正常を正常と判定
function computeMetrics(results) {
  const caught = s => s === 'fail' || s === 'warn';
  const defect = s => s === 'fail' || s === 'warn';
  let TP = 0, FN = 0, FP = 0, TN = 0;
  const misses = [], overflags = [];
  results.forEach(r => {
    const exp = (r.expect && r.expect.items) || {};
    const act = (r.verdict && r.verdict.items) || {};
    Object.keys(exp).forEach(id => {
      const e = String(exp[id]).toLowerCase();
      const a = String(act[id] == null ? 'pass' : act[id]).toLowerCase();
      if (defect(e)) {
        if (caught(a)) TP++;
        else { FN++; misses.push({ type: r.type, file: r.file, id, expected: e, actual: a }); }
      } else { // 期待 pass/na（正常）
        if (caught(a)) { FP++; overflags.push({ type: r.type, file: r.file, id, expected: e, actual: a }); }
        else TN++;
      }
    });
  });
  const recall = (TP + FN) ? TP / (TP + FN) : null;      // 不備の捕捉率（1に近いほど見逃しが少ない）
  const precision = (TP + FP) ? TP / (TP + FP) : null;    // 指摘の的中率（1に近いほど過剰指摘が少ない）
  return { TP, FN, FP, TN, recall, precision, misses, overflags };
}

// 正解事例フォルダを再帰探索し [{type, biz, file}] を返す
function discover(typeFilter, bizFilter) {
  const out = [];
  for (const type of Object.keys(TOOL_DIR)) {
    if (typeFilter && type !== typeFilter) continue;
    const toolPath = path.join(INTEG_ROOT, TOOL_DIR[type]);
    if (!fs.existsSync(toolPath)) continue;
    const found = [];
    (function walk(dir) {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) found.push(p);
      }
    })(toolPath);
    for (const f of found) {
      const norm = f.replace(/\\/g, '/');
      let biz = null;
      if (/基礎_正解事例/.test(norm)) biz = 'kiso';
      else if (/目的地_正解事例/.test(norm)) biz = 'mokutekichi';
      if (!biz) continue;                        // 正解事例フォルダ配下のみ対象
      if (bizFilter && biz !== bizFilter) continue;
      out.push({ type, biz, file: f });
    }
  }
  return out;
}

// モック応答: 全チェックを pass にして返す（プラミング検証用）
function mockResponse(rule, biz) {
  const checks = reg.filterChecks(rule, biz);
  const hasManual = checks.some(c => (c.group || 'nev') === 'manual');
  const mk = arr => arr.map(c => ({ id: c.id, status: 'pass', found_text: 'MOCK', detail: 'MOCK' }));
  const resp = {
    detected_info: { drawing_title: rule.meta.drawingName },
    overall_comment: 'MOCK応答（プラミング検証）',
    _usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500, totalTokenCount: 1500 },
    _model: 'mock',
  };
  if (hasManual) {
    resp.nev_results = mk(checks.filter(c => (c.group || 'nev') === 'nev'));
    resp.manual_results = mk(checks.filter(c => (c.group || 'nev') === 'manual'));
  } else {
    resp.results = mk(checks);
  }
  return resp;
}

function buildVerdict(rule, biz, result) {
  // 3-A: 本番(app.js/batch.js)と同一実装 core/verdict.js を使用（従来の再実装＝乖離リスクを解消）
  const groupAggs = verdictCore.computeGroupAggs(rule, result, biz);
  const verdict = { items: {}, deterministic: [], detectedInfo: result.detected_info || {}, notes: {} };
  groupAggs.forEach(({ group: g, agg: a, deterministicIds }) => {
    verdict.deterministic = verdict.deterministic.concat(deterministicIds || []);
    verdict[g + 'Overall'] = a.overall;
    verdict[g + 'RequiredFail'] = a.requiredFail;
    a.items.forEach(it => {
      verdict.items[it.id] = it.status;
      // 非pass項目の根拠を記録（回帰候補の診断用）
      if (it.status !== 'pass' && it.status !== 'na') {
        verdict.notes[it.id] = { status: it.status, found: it.found_text || '', detail: (it.detail || '').slice(0, 200) };
      }
    });
  });
  return verdict;
}

async function main() {
  const args = parseArgs(process.argv);
  loadEnvLocal();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!args.mock && !apiKey) {
    console.error('[regression] GEMINI_API_KEY が未設定です。プラミング検証なら --mock を付けてください。');
    process.exit(1);
  }

  let entries;
  if (args.manifest) {
    // ラベル付きマニフェスト: [{file, type, biz, expect:{items:{id:status}, overall?}}]
    const mp = path.resolve(process.cwd(), args.manifest);
    const list = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const base = path.dirname(mp);
    entries = list
      .filter(m => m && m.file && m.type)   // 解説用エントリ(_guide/_comment等)はスキップ
      .map(m => ({
        type: m.type, biz: m.biz || 'kiso',
        file: path.isAbsolute(m.file) ? m.file : path.resolve(base, m.file),
        expect: m.expect || null,
      })).filter(e => !args.type || e.type === args.type);
  } else {
    entries = discover(args.type, args.biz);
  }
  if (entries.length === 0) { console.error('[regression] 対象が見つかりません（--manifest か 正解事例フォルダを確認）。'); process.exit(1); }
  // FM-2: --offset で開始位置をローテーション（--limit 固定でも日替わりで全件を巡回できる）
  if (args.offset > 0 && entries.length) {
    const o = args.offset % entries.length;
    entries = entries.slice(o).concat(entries.slice(0, o));
  }
  if (args.limit > 0) entries = entries.slice(0, args.limit);

  console.log(`[regression] 対象 ${entries.length} 件 / mode=${args.mock ? 'MOCK' : args.model}`);
  const results = [];
  let okCount = 0, regressionCount = 0, errCount = 0;
  const capTracker = new cost.CapTracker({ capJpy: 0 });

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const rule = reg.getRule(e.type);
    const label = `[${i + 1}/${entries.length}] ${e.type}/${e.biz} ${path.basename(e.file)}`;
    process.stdout.write(label + ' … ');
    try {
      const promptText = prompt.buildPrompt(rule, e.biz);
      let result;
      if (args.mock) {
        result = mockResponse(rule, e.biz);
      } else {
        const base64 = fs.readFileSync(e.file).toString('base64');
        const images = [{ base64, mimeType: 'application/pdf' }];
        result = await gemini.callGeminiWithRetry(apiKey, images, promptText, args.model, null, { pass: 1, total: 1 }, { maxOutputTokens: rule.settings.maxOutputTokens });
      }
      const c = cost.estimateCost(result._usageMetadata, result._model === 'mock' ? 'gemini-2.5-flash' : result._model);
      if (c) capTracker.addCost(c);
      const verdict = buildVerdict(rule, e.biz, result);
      // 正解事例なので nev/manual とも pass 期待。fail が出たら回帰候補。
      const overalls = Object.keys(verdict).filter(k => k.endsWith('Overall')).map(k => verdict[k]);
      const isRegression = overalls.some(o => o === 'fail');
      if (isRegression) regressionCount++; else okCount++;
      results.push({ ...e, ok: true, verdict, isRegression });
      process.stdout.write(overalls.join('/') + (isRegression ? '  ⚠回帰候補' : '') + '\n');
      if (!args.mock && args.sleep) await gemini.sleep(args.sleep);
    } catch (err) {
      errCount++;
      results.push({ ...e, ok: false, error: String(err && err.message || err) });
      process.stdout.write('ERROR: ' + (err && err.message || err) + '\n');
    }
  }

  // recall測定: expect を持つ結果があればメトリクス算出
  const labeled = results.filter(r => r.ok && r.expect && r.expect.items);
  let metrics = null;
  if (labeled.length) {
    metrics = computeMetrics(labeled);
  }

  const payload = {
    meta: { generatedAt: new Date().toISOString(), mode: args.mock ? 'mock' : args.model, total: entries.length, pass: okCount, regression: regressionCount, error: errCount, estCostJpy: capTracker.getTotalJpy() },
    metrics,
    results,
  };
  const outPath = args.out ? path.resolve(process.cwd(), args.out) : path.join(__dirname, 'results', `reg-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`\n[regression] 完了: 期待通り(pass/warn) ${okCount} / 回帰候補(fail) ${regressionCount} / エラー ${errCount}`);
  if (!args.mock) console.log(`[regression] 概算コスト: 約 ${capTracker.getTotalJpy().toLocaleString()} 円`);
  if (metrics) {
    const pct = v => v == null ? '—' : (Math.round(v * 1000) / 10) + '%';
    console.log(`\n[recall測定] 不備捕捉 TP=${metrics.TP} 見逃し FN=${metrics.FN} 過剰指摘 FP=${metrics.FP} 正常判定 TN=${metrics.TN}`);
    console.log(`[recall測定] recall(不備の捕捉率)=${pct(metrics.recall)}  precision(指摘の的中率)=${pct(metrics.precision)}`);
    if (metrics.misses.length) {
      console.log(`[recall測定] ⚠見逃し（期待不備→実測見逃し）${metrics.misses.length}件:`);
      metrics.misses.slice(0, 20).forEach(m => console.log(`   ${m.type} ${path.basename(m.file)} [${m.id}] 期待:${m.expected}→実測:${m.actual}`));
    }
  }
  console.log(`[regression] 結果: ${outPath}`);
  process.exit(errCount > 0 && okCount === 0 ? 1 : 0);
}

// 直接実行時のみ main を走らせる（テストから require したときは走らせない）
if (require.main === module) {
  main().catch(e => { console.error('[regression] 予期せぬエラー:', e); process.exit(1); });
}

module.exports = { computeMetrics, buildVerdict, mockResponse };
