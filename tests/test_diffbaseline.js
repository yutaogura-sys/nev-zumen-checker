/* baseline-diff の単体テスト: node tests/test_diffbaseline.js */
const { computeDiff } = require('./diff-baseline.js');

let fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}\n   got:  ${g}\n   want: ${w}`); fail++; } else console.log(`✓ ${name}`);
}

const base = { results: [
  { type: 'heimen', biz: 'kiso', file: 'a.pdf', verdict: { items: { x: 'pass', y: 'warn', z: 'pass' } } },
  { type: 'keitou', biz: 'kiso', file: 'b.pdf', verdict: { items: { p: 'fail' } } },
] };
const cur = { results: [
  { type: 'heimen', biz: 'kiso', file: 'a.pdf', verdict: { items: { x: 'fail', y: 'warn', z: 'na' } } }, // x:pass→fail(stricter), z:pass→na(na-change)
  { type: 'keitou', biz: 'kiso', file: 'b.pdf', verdict: { items: { p: 'warn' } } }, // p:fail→warn(looser)
] };

const d = computeDiff(base, cur);
eq('変化総数', d.counts.total, 3);
eq('厳格化1(x pass→fail)', d.counts.stricter, 1);
eq('緩和1(p fail→warn)', d.counts.looser, 1);
eq('na変化1(z pass→na)', d.counts.naChange, 1);
eq('比較対象2図面', d.comparedFiles, 2);

// 片方にしかない図面は無視
const cur2 = { results: [{ type: 'mitori', biz: 'kiso', file: 'new.pdf', verdict: { items: { q: 'fail' } } }] };
eq('未対応図面は比較しない', computeDiff(base, cur2).counts.total, 0);

// エラー行(ok:false)は除外
const base3 = { results: [{ type: 'heimen', biz: 'kiso', file: 'a.pdf', ok: false }] };
eq('ok:falseは無視', computeDiff(base3, cur).counts.total, 0);

console.log(fail === 0 ? '\n✅ diff-baseline 全テスト合格' : `\n❌ diff-baseline ${fail}件 失敗`);
process.exit(fail === 0 ? 0 : 1);
