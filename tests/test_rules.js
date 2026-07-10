/* rules 定義の構造検証（Node実行）: node tests/test_rules.js */
const rulesReg = require('../core/rules-registry.js');
['mitori', 'heimen', 'haisen', 'keitou'].forEach(t => require('../rules/' + t + '.js'));

let fail = 0;
function ok(cond, msg) { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) fail++; }
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}  got=${g} want=${w}`); fail++; } else console.log(`✓ ${name} = ${g}`);
}

eq('登録済み種別', rulesReg.listTypes().map(d => d.type).sort(), ['haisen', 'heimen', 'keitou', 'mitori']);

// 期待項目数（既存4ツール分析値と突合）
// 注: P0-5でrecall向上のため任意(required:false)チェックを追加済み。旧ツール比で項目数は意図的に増えている。
//   mitori +parking_layout(kiso)/+signboard_height(moku)、heimen +8(共通)、haisen +dedicated_wiring_scope(共通)
const expected = [
  ['mitori', 'kiso', 14], ['mitori', 'mokutekichi', 19],
  ['heimen', 'kiso', 28], ['heimen', 'mokutekichi', 30],
  ['haisen', 'kiso', 44], ['haisen', 'mokutekichi', 45],
  ['keitou', 'kiso', 54], ['keitou', 'mokutekichi', 50],
];
for (const [type, bt, want] of expected) eq(`${type}/${bt} 項目数`, rulesReg.resolveChecks(type, bt).length, want);

for (const type of ['mitori', 'heimen', 'haisen', 'keitou']) {
  const rule = rulesReg.getRule(type);
  const ids = rule.checks.map(c => c.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  ok(dup.length === 0, `${type}: id重複なし`);
  const idSet = new Set(ids);
  const dangling = Object.values(rule.businessTypeBranch || {}).flat().filter(id => !idSet.has(id));
  ok(dangling.length === 0, `${type}: branch内idが全てchecksに存在`);
  const catSet = new Set(Object.keys(rule.categories || {}));
  const badCat = rule.checks.filter(c => !catSet.has(c.category)).map(c => c.id);
  ok(badCat.length === 0, `${type}: 全checkのcategoryが定義済み`);
  const mism = rule.checks.filter(c => (c.group || 'nev') !== ((rule.categories[c.category] || {}).group || 'nev')).map(c => c.id);
  ok(mism.length === 0, `${type}: check.group と category.group が整合`);
  ok(rule.meta && rule.meta.drawingName && rule.meta.sourceYear === 'R7補正', `${type}: meta 妥当`);
}

ok(rulesReg.getRule('heimen').checks.some(c => c.id === 'space_width_check' && c.required), 'heimen: 幅2.5m以上チェックが必須で存在');
ok(rulesReg.getRule('mitori').checks.filter(c => c.id.startsWith('charging_count')).length === 2, 'mitori: charging_count が一意ID2件に分離');

// E: 系統図のcritical付与（B-guard対象）。付与セットを固定して回帰検知（選定理由は rules/keitou.js のコメント参照）
eq('keitou: critical項目セット',
  rulesReg.getRule('keitou').checks.filter(c => c.critical).map(c => c.id),
  ['nev_title', 'nev_location', 'nev_main_breaker_capacity', 'nev_branch_breaker_capacity']);
ok(rulesReg.getRule('keitou').checks.filter(c => c.critical).every(c => c.required && !c.condition),
  'keitou: critical項目は全て無条件の必須項目（条件付き項目には付けない）');
// critical確定fail 1件で総合「不合格」になる（B-guard結線の確認）
{
  const agg = require('../core/aggregate.js');
  const rule = rulesReg.getRule('keitou');
  const checks = rulesReg.resolveChecks('keitou', 'kiso').filter(c => (c.group || 'nev') === 'nev');
  const raw = checks.map(c => ({ id: c.id, status: c.id === 'nev_title' ? 'fail' : (c.condition ? 'na' : 'pass'), found_text: 'x', detail: 'd', confidence: 'high' }));
  const a = agg.aggregateResults(raw, checks, { requiredFailForWarn: rule.settings.requiredFailForWarn });
  eq('keitou: 図面名称の確定fail 1件 → 総合「不合格」（旧ツールの厳格性を復元）', a.overall, 'fail');
  // 対照: critical でない必須項目の fail 1件は従来どおり「要確認」（中間案＝全項目一発不合格には戻さない）
  const raw2 = checks.map(c => ({ id: c.id, status: c.id === 'nev_scale' ? 'fail' : (c.condition ? 'na' : 'pass'), found_text: 'x', detail: 'd', confidence: 'high' }));
  const a2 = agg.aggregateResults(raw2, checks, { requiredFailForWarn: rule.settings.requiredFailForWarn });
  eq('keitou: 非critical必須のfail 1件 → 「要確認」のまま（過剰不合格を防止）', a2.overall, 'warn');
}

console.log(fail === 0 ? '\n✅ rules 全テスト合格' : `\n❌ rules ${fail}件 失敗`);
process.exit(fail === 0 ? 0 : 1);
