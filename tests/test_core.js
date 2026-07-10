/* core モジュールの単体テスト（Node実行）: node tests/test_core.js */
const util = require('../core/util.js');
const agg = require('../core/aggregate.js');
const cost = require('../core/cost.js');
const rules = require('../core/rules-registry.js');

let fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}\n   got:  ${g}\n   want: ${w}`); fail++; }
  else console.log(`✓ ${name}`);
}

// ── util ──
eq('normalizeKey 全角×・空白・小文字', util.normalizeKey(' cv8sq×3c '), 'CV8SQX3C');
eq('normalizeKey ダッシュ統一', util.normalizeKey('PFD−54'), 'PFD-54');
eq('escapeHtml', util.escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
eq('formatFileSize KB', util.formatFileSize(2048), '2.0 KB');
eq('editDistance1 1置換', util.editDistance1('PFP', 'PFD'), 1);
eq('editDistance1 2以上打切り', util.editDistance1('ABC', 'XYZ'), 2);

// ── aggregate ──
const checks = [
  { id: 'a', category: 'c1', label: 'A', required: true },
  { id: 'b', category: 'c1', label: 'B', required: true },
  { id: 'c', category: 'c2', label: 'C', required: false },
];
eq('aggregate 総合pass', agg.aggregateResults([{ id: 'a', status: 'pass', found_text: 'x' }, { id: 'b', status: 'pass', found_text: 'x' }, { id: 'c', status: 'fail' }], checks).overall, 'pass');
eq('aggregate 任意failはwarn降格', agg.aggregateResults([{ id: 'c', status: 'fail' }], checks).items.find(i => i.id === 'c').status, 'warn');
eq('aggregate 未回答はfail', agg.aggregateResults([], checks).items.find(i => i.id === 'a').status, 'fail');
eq('aggregate 必須fail1でwarn', agg.aggregateResults([{ id: 'a', status: 'fail' }, { id: 'b', status: 'pass' }], checks).overall, 'warn');
const c3 = [0, 1, 2].map(i => ({ id: 'r' + i, category: 'c', label: 'R' + i, required: true }));
eq('aggregate 必須fail3でfail', agg.aggregateResults(c3.map(c => ({ id: c.id, status: 'fail' })), c3).overall, 'fail');
// na: 必須naは判定対象外（S2以降: condition/naAllowed が明示された正当なnaのみ。無条件必須のnaはwarn矯正される）
const checksNa = [
  { id: 'a', category: 'c1', label: 'A', required: true },
  { id: 'b', category: 'c1', label: 'B', required: true, condition: '該当設備がある場合' },
  { id: 'c', category: 'c2', label: 'C', required: false },
];
const rna = agg.aggregateResults([{ id: 'a', status: 'pass', found_text: 'x' }, { id: 'b', status: 'na' }, { id: 'c', status: 'pass', found_text: 'x' }], checksNa);
eq('aggregate na必須は除外→pass', rna.overall, 'pass');
eq('aggregate na必須はrequiredTotalから除外', rna.requiredTotal, 1);
eq('aggregate totalNa', rna.totalNa, 1);
// ステータス正規化: 大小文字吸収・未知値はwarnへ
eq('aggregate 大文字PASS→pass', agg.aggregateResults([{ id: 'a', status: 'PASS', found_text: 'x' }, { id: 'b', status: 'pass', found_text: 'x' }, { id: 'c', status: 'pass', found_text: 'x' }], checks).items.find(i => i.id === 'a').status, 'pass');
eq('aggregate 未知statusはwarnに正規化（無色バッジ防止）', agg.aggregateResults([{ id: 'a', status: 'ok' }, { id: 'b', status: 'pass' }], checks).items.find(i => i.id === 'a').status, 'warn');
eq('aggregate 全角/空白statusも吸収', agg.aggregateResults([{ id: 'a', status: ' Fail ' }], [{ id: 'a', category: 'c', required: true }]).items[0].status, 'fail');
// 確信度low → 断定(pass/fail)をwarnへ降格
eq('aggregate 確信度low+pass→warn', agg.aggregateResults([{ id: 'a', status: 'pass', confidence: 'low' }], [{ id: 'a', category: 'c', required: true }]).items[0].status, 'warn');
eq('aggregate 確信度low+fail→warn', agg.aggregateResults([{ id: 'a', status: 'fail', confidence: 'low' }], [{ id: 'a', category: 'c', required: true }]).items[0].status, 'warn');
eq('aggregate 確信度high+passはそのまま', agg.aggregateResults([{ id: 'a', status: 'pass', confidence: 'high', found_text: 'x' }], [{ id: 'a', category: 'c', required: true }]).items[0].status, 'pass');
eq('aggregate abstain無効化オプション', agg.aggregateResults([{ id: 'a', status: 'pass', confidence: 'low', found_text: 'x' }], [{ id: 'a', category: 'c', required: true }], { abstainLowConfidence: false }).items[0].status, 'pass');
// A: 根拠なき合格の禁止
eq('aggregate pass+found_text空→warn（根拠未提示）', agg.aggregateResults([{ id: 'a', status: 'pass', found_text: '' }], [{ id: 'a', category: 'c', required: true }]).items[0].status, 'warn');
eq('aggregate pass+found_textあり→pass維持', agg.aggregateResults([{ id: 'a', status: 'pass', found_text: '次世代モール' }], [{ id: 'a', category: 'c', required: true }]).items[0].status, 'pass');
eq('aggregate 根拠必須の無効化オプション', agg.aggregateResults([{ id: 'a', status: 'pass', found_text: '' }], [{ id: 'a', category: 'c', required: true }], { requireEvidenceForPass: false }).items[0].status, 'pass');
eq('aggregate fail+found_text空はそのままfail（根拠必須はpassのみ対象）', agg.aggregateResults([{ id: 'a', status: 'fail', found_text: '' }], [{ id: 'a', category: 'c', required: true }]).items[0].status, 'fail');
// H1: 決定論チェックが確定させたpass(_deterministic)は found_text 空でも降格しない（検算結果が根拠）
eq('aggregate 決定論pass+found_text空→pass維持', agg.aggregateResults([{ id: 'a', status: 'pass', found_text: '', _deterministic: 'wire_reconcile' }], [{ id: 'a', category: 'c', required: true }]).items[0].status, 'pass');
// ②: 決定論チェックが確定させたpass(_deterministic)は confidence:low でも warn に降格しない（コード検算が根拠でAI確信度と無関係）
eq('aggregate ②決定論pass+confidence:low→pass維持', agg.aggregateResults([{ id: 'a', status: 'pass', confidence: 'low', found_text: '検算OK', _deterministic: 'space_width_2500' }], [{ id: 'a', category: 'c', required: true }]).items[0].status, 'pass');
eq('aggregate ②決定論fail+confidence:low→fail維持', agg.aggregateResults([{ id: 'a', status: 'fail', confidence: 'low', found_text: '検算NG', _deterministic: 'branch_le_main' }], [{ id: 'a', category: 'c', required: true }]).items[0].status, 'fail');
// 非決定論の pass+confidence:low は従来通り warn へ降格（回帰確認）
eq('aggregate 非決定論pass+confidence:low→warn（従来動作）', agg.aggregateResults([{ id: 'a', status: 'pass', confidence: 'low', found_text: 'x' }], [{ id: 'a', category: 'c', required: true }]).items[0].status, 'warn');
// F1: 必須項目に要確認(warn)があれば総合を合格にしない（品質最優先・false PASS是正）
const f1 = agg.aggregateResults([{ id: 'a', status: 'pass', found_text: 'x' }, { id: 'b', status: 'warn', found_text: 'y' }], [{ id: 'a', category: 'c', required: true }, { id: 'b', category: 'c', required: true }]);
eq('F1 必須warnあり→総合warn（合格にしない）', f1.overall, 'warn');
eq('F1 requiredWarn件数を返す', f1.requiredWarn, 1);
eq('F1 必須全passのみ総合pass', agg.aggregateResults([{ id: 'a', status: 'pass', found_text: 'x' }, { id: 'b', status: 'pass', found_text: 'y' }], [{ id: 'a', category: 'c', required: true }, { id: 'b', category: 'c', required: true }]).overall, 'pass');
// 任意(optional)のwarnは総合に影響しない
eq('F1 任意warnは総合passのまま', agg.aggregateResults([{ id: 'a', status: 'pass', found_text: 'x' }, { id: 'b', status: 'warn', found_text: 'y' }], [{ id: 'a', category: 'c', required: true }, { id: 'b', category: 'c', required: false }]).overall, 'pass');
// F1 決定論の安全網がwarnを出した必須項目でも総合は合格にしない
eq('F1 決定論warn（安全網の疑義）でも総合warn', agg.aggregateResults([{ id: 'a', status: 'pass', found_text: 'x' }, { id: 'b', status: 'warn', found_text: 'z', _deterministic: 'space_width_2500' }], [{ id: 'a', category: 'c', required: true }, { id: 'b', category: 'c', required: true }]).overall, 'warn');
// F2: 必須naの件数を requiredNa として返す（分母から消えるのを可視化する集計値）
// S2以降: condition付き（正当なna）で検証。無条件必須のnaはwarn矯正される（test_pipeline.jsで検証）。
const f2 = agg.aggregateResults([{ id: 'a', status: 'pass', found_text: 'x' }, { id: 'b', status: 'na' }], [{ id: 'a', category: 'c', required: true }, { id: 'b', category: 'c', required: true, condition: '該当時のみ' }]);
eq('F2 requiredNa件数を返す', f2.requiredNa, 1);
eq('F2 必須naは合否分母から除外され総合pass（従来）', f2.overall, 'pass');
// 4-C: critical必須の確定failが1件でもあれば総合「不合格」（B-guard: 降格を生き延びたfailのみ）
const f4c = agg.aggregateResults([{ id: 'a', status: 'fail', found_text: 'x' }, { id: 'b', status: 'pass', found_text: 'y' }], [{ id: 'a', category: 'c', required: true, critical: true }, { id: 'b', category: 'c', required: true }]);
eq('4-C critical fail 1件→総合fail（要確認に埋もれない）', f4c.overall, 'fail');
eq('4-C criticalFail件数を返す', f4c.criticalFail, 1);
// critical でも確信度low なら warn 降格済み → 総合は要確認止まり（B-guard）
const f4g = agg.aggregateResults([{ id: 'a', status: 'fail', confidence: 'low' }, { id: 'b', status: 'pass', found_text: 'y' }], [{ id: 'a', category: 'c', required: true, critical: true }, { id: 'b', category: 'c', required: true }]);
eq('4-C B-guard: critical fail が確信度lowなら総合warn（即不合格にしない）', f4g.overall, 'warn');
// 非critical の必須fail 1件は従来どおり要確認
eq('4-C 非criticalの必須fail1件は要確認（従来維持）', agg.aggregateResults([{ id: 'a', status: 'fail' }, { id: 'b', status: 'pass', found_text: 'y' }], [{ id: 'a', category: 'c', required: true }, { id: 'b', category: 'c', required: true }]).overall, 'warn');

// ── cost ──
// 2026-07 公式価格: 2.5-flash 入力$0.30/出力$2.50 per 1M。入力1M+出力1M=2.80USD*150=420JPY
const est = cost.estimateCost({ promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 }, 'gemini-2.5-flash', 150);
eq('estimateCost JPY', est.totalCostJpy, 420);
// 思考(thinking)トークンを出力に算入: 入力1M(0.30)＋出力(候補1M＋思考1M=2M→5.00)=5.30USD*150=795JPY
const estT = cost.estimateCost({ promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000, thoughtsTokenCount: 1_000_000 }, 'gemini-2.5-flash', 150);
eq('estimateCost 思考トークンを出力に算入', estT.totalCostJpy, 795);
function memTracker(cap, ratio) {
  let mem = 0;
  return new cost.CapTracker({ capJpy: cap, warnRatio: ratio, store: { get: () => mem, set: v => { mem = v; } } });
}
const t = memTracker(100, 0.8);
t.addCost({ totalCostJpy: 85 });
eq('cap 85/100 → warn', t.getState().status, 'warn');
const s = t.addCost({ totalCostJpy: 30 });
eq('cap 115/100 → over', s.status, 'over');
eq('cap 超過額15円', s.overageJpy, 15);
eq('cap メッセージerror', t.getMessage().level, 'error');
eq('cap 上限なし=disabled', new cost.CapTracker({ store: { get: () => 999, set: () => {} } }).getState().status, 'disabled');

// ── rules-registry（登録なし状態の基本動作）──
eq('rules 未登録はnull', rules.getRule('__none__'), null);

// ── D: pdf.resolveTargetPages（多ページPDFのページ選択。純関数のみNodeで検証）──
const pdf = require('../core/pdf.js');
eq('pages未指定 → 先頭maxPages（従来挙動＝回帰ゼロ）', pdf.resolveTargetPages(10, 5), [1, 2, 3, 4, 5]);
eq('pages未指定・総ページ<max → 全ページ', pdf.resolveTargetPages(3, 5), [1, 2, 3]);
eq('pages指定 [1,3,5] → そのまま', pdf.resolveTargetPages(10, 5, [1, 3, 5]), [1, 3, 5]);
eq('pages指定は昇順・一意化', pdf.resolveTargetPages(10, 5, [5, 3, 3, 1]), [1, 3, 5]);
eq('pages指定は範囲外(0/11/小数)を除去', pdf.resolveTargetPages(10, 5, [0, 2, 11, 2.5]), [2]);
eq('pages指定はmaxPagesで打ち切り', pdf.resolveTargetPages(10, 3, [1, 2, 3, 4, 5]), [1, 2, 3]);
eq('pages全て無効 → 先頭Nへフォールバック（解析不能にしない）', pdf.resolveTargetPages(10, 5, [0, 99]), [1, 2, 3, 4, 5]);
eq('pages空配列 → 先頭N（従来挙動）', pdf.resolveTargetPages(10, 5, []), [1, 2, 3, 4, 5]);

console.log(fail === 0 ? '\n✅ core 全テスト合格' : `\n❌ core ${fail}件 失敗`);
process.exit(fail === 0 ? 0 : 1);
