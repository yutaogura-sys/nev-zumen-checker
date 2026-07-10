#!/usr/bin/env node
/* ============================================================
   tests/coverage-report.js — 決定論「安全網」カバレッジ報告（API不要）
   各図面×事業区分で、チェック項目のうち「コード側の決定論チェックで裏取り
   される項目（＝AI単独判定に依存しない項目）」がどれだけあるかを静的に集計する。
   AIを呼ばずに、再現性100%で守られている検出範囲を可視化する。
   使い方: node tests/coverage-report.js
   ============================================================ */
'use strict';
const reg = require('../core/rules-registry.js');
['mitori', 'heimen', 'haisen', 'keitou'].forEach(t => require('../rules/' + t + '.js'));

// pure関数: rule と businessType から {total, backed, backedIds, ratio}
function coverageFor(rule, biz) {
  const checks = reg.filterChecks(rule, biz);
  const backedIds = new Set();
  (rule.deterministic || []).forEach(d => (d.targets || []).forEach(id => backedIds.add(id)));
  const present = checks.filter(c => backedIds.has(c.id)).map(c => c.id);
  return { total: checks.length, backed: present.length, backedIds: present, ratio: checks.length ? present.length / checks.length : 0 };
}

function report() {
  const TYPES = ['mitori', 'heimen', 'haisen', 'keitou'];
  const lines = ['# 決定論チェックの安全網カバレッジ（API不要・静的集計）', '',
    '「コード側の決定論チェックで裏取りされる項目」＝AIが数値を読めば結果が確定する項目。',
    '残りはAI判定のみ（無料枠バッチ or 人手で別途検証が必要）。', ''];
  const out = {};
  for (const type of TYPES) {
    const rule = reg.getRule(type);
    lines.push(`## ${type}（${rule.meta.drawingName}）`);
    for (const biz of ['kiso', 'mokutekichi']) {
      const c = coverageFor(rule, biz);
      out[`${type}/${biz}`] = c;
      lines.push(`- ${biz === 'kiso' ? '基礎' : '目的地'}: 決定論裏取り ${c.backed}/${c.total} 項目（${Math.round(c.ratio * 1000) / 10}%）` +
        (c.backedIds.length ? ` … ${c.backedIds.join(', ')}` : ''));
    }
    lines.push('');
  }
  lines.push('※ カバレッジが低いのは正常（多くの項目は図面の視覚判断でありコード検算に馴染まない）。');
  lines.push('  数値・仕様・整合など「コードで検算できる項目」を優先的に決定論化している。');
  return { text: lines.join('\n'), data: out };
}

if (require.main === module) {
  console.log(report().text);
}
module.exports = { coverageFor, report };
