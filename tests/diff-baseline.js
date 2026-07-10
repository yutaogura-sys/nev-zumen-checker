#!/usr/bin/env node
/* ============================================================
   tests/diff-baseline.js — 判定結果の差分（回帰検知）
   2つの regression.js 出力(JSON)を項目単位で突き合わせ、
   プロンプト/ルール変更の前後で判定がどう変わったかを可視化する。
   厳しくなった(stricter)/緩くなった(looser)を数え、デグレの早期検知に使う。

   使い方: node tests/diff-baseline.js <baseline.json> <current.json>
   ============================================================ */
'use strict';

const SEV = { pass: 0, warn: 1, fail: 2 }; // 重大度（na は別扱い）

function keyOf(r) {
  const base = String(r.file || '').replace(/\\/g, '/').split('/').pop();
  return `${r.type || ''}/${r.biz || ''}/${base}`;
}
function itemsOf(r) { return (r.verdict && r.verdict.items) || {}; }

// baseline / current: regression.js の payload（{results:[...]}）
function computeDiff(baseline, current) {
  const bMap = {}; (baseline.results || []).forEach(r => { if (r.ok !== false) bMap[keyOf(r)] = r; });
  const cMap = {}; (current.results || []).forEach(r => { if (r.ok !== false) cMap[keyOf(r)] = r; });
  const changed = [];
  let stricter = 0, looser = 0, naChange = 0;

  Object.keys(cMap).forEach(k => {
    if (!bMap[k]) return; // 両方に存在するものだけ比較
    const bi = itemsOf(bMap[k]), ci = itemsOf(cMap[k]);
    const ids = new Set([].concat(Object.keys(bi), Object.keys(ci)));
    ids.forEach(id => {
      const from = bi[id], to = ci[id];
      if (from == null || to == null || from === to) return;
      let direction;
      if (from === 'na' || to === 'na') { direction = 'na-change'; naChange++; }
      else if ((SEV[to] ?? 1) > (SEV[from] ?? 1)) { direction = 'stricter'; stricter++; }
      else { direction = 'looser'; looser++; }
      changed.push({ key: k, id, from, to, direction });
    });
  });

  return { changed, counts: { total: changed.length, stricter, looser, naChange }, comparedFiles: Object.keys(cMap).filter(k => bMap[k]).length };
}

if (require.main === module) {
  const fs = require('fs');
  const [, , basePath, curPath] = process.argv;
  if (!basePath || !curPath) { console.error('使い方: node tests/diff-baseline.js <baseline.json> <current.json>'); process.exit(1); }
  const baseline = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  const current = JSON.parse(fs.readFileSync(curPath, 'utf8'));
  const d = computeDiff(baseline, current);
  console.log(`[baseline-diff] 比較対象 ${d.comparedFiles} 図面 / 変化 ${d.counts.total} 項目（厳格化 ${d.counts.stricter} / 緩和 ${d.counts.looser} / na変化 ${d.counts.naChange}）`);
  d.changed.slice(0, 50).forEach(c => console.log(`  [${c.direction}] ${c.key} ${c.id}: ${c.from} → ${c.to}`));
  process.exit(0);
}

module.exports = { computeDiff };
