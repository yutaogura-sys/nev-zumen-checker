#!/usr/bin/env node
/* ============================================================
   tests/aggregate-results.js — 複数の結果JSONを累積してメトリクス集計
   無料枠は1日で上限に達するため、日次で少しずつ回した結果(tests/results/*.json)を
   まとめて recall/precision を算出する。同一図面が複数回ある場合は最新(mtime)を採用。
   使い方:
     node tests/aggregate-results.js tests/results/*.json
     node tests/aggregate-results.js               # 省略時は tests/results/ 内の reg/synth/prec を全部
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { computeMetrics } = require('./regression.js');

function keyOf(r) {
  const base = String(r.file || '').replace(/\\/g, '/').split('/').pop();
  return `${r.type || ''}/${r.biz || ''}/${base}`;
}

function main() {
  let files = process.argv.slice(2);
  if (files.length === 0) {
    const dir = path.join(__dirname, 'results');
    if (fs.existsSync(dir)) files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f));
  }
  if (files.length === 0) { console.error('結果JSONがありません。'); process.exit(1); }

  // 同一図面キーは最新ファイルの結果で上書き（重複計上を防ぐ）
  const byKey = {};
  let skippedMock = 0;
  files.map(f => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => a.m - b.m).forEach(({ f }) => {
    let payload; try { payload = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return; }
    // mockモードの結果は実測ではないので除外（メトリクス汚染防止）
    if (payload.meta && payload.meta.mode === 'mock') { skippedMock++; return; }
    (payload.results || []).forEach(r => {
      // プレースホルダ（存在しないファイルパス）や expect無しは除外
      if (r.ok && r.expect && r.expect.items && !/差し替え|placeholder/.test(String(r.file))) byKey[keyOf(r)] = r;
    });
  });
  if (skippedMock) console.log(`[累積集計] mock結果 ${skippedMock} ファイルを除外（実測のみ集計）`);

  const results = Object.values(byKey);
  if (results.length === 0) { console.error('expect付きの結果がありません（--manifest で測定した結果を集計対象にしてください）。'); process.exit(1); }

  const m = computeMetrics(results);
  const pct = v => v == null ? '—' : (Math.round(v * 1000) / 10) + '%';
  console.log(`[累積集計] 対象 ${files.length} ファイル / ラベル付き ${results.length} 図面`);
  console.log(`[累積集計] TP=${m.TP} FN(見逃し)=${m.FN} FP(過剰指摘)=${m.FP} TN=${m.TN}`);
  console.log(`[累積集計] recall(不備の捕捉率)=${pct(m.recall)}  precision(指摘の的中率)=${pct(m.precision)}`);
  if (m.misses.length) {
    console.log(`[累積集計] ⚠見逃し ${m.misses.length}件:`);
    m.misses.slice(0, 30).forEach(x => console.log(`   ${x.type} [${x.id}] 期待${x.expected}→実測${x.actual} (${path.basename(x.file)})`));
  }
  if (m.overflags.length) {
    console.log(`[累積集計] △過剰指摘 ${m.overflags.length}件:`);
    m.overflags.slice(0, 30).forEach(x => console.log(`   ${x.type} [${x.id}] 期待${x.expected}→実測${x.actual} (${path.basename(x.file)})`));
  }
}

if (require.main === module) main();
