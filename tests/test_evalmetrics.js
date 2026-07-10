/* recall測定メトリクスの単体テスト: node tests/test_evalmetrics.js */
const { computeMetrics } = require('./regression.js');

let fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}\n   got:  ${g}\n   want: ${w}`); fail++; } else console.log(`✓ ${name}`);
}

// 期待: a=fail(不備), b=pass(正常), c=warn(不備)
// 実測: a=fail(捕捉TP), b=pass(正常TN), c=pass(見逃しFN)
let m = computeMetrics([{
  type: 'heimen', file: 'x.pdf',
  expect: { items: { a: 'fail', b: 'pass', c: 'warn' } },
  verdict: { items: { a: 'fail', b: 'pass', c: 'pass' } },
}]);
eq('TP', m.TP, 1);
eq('FN(見逃し)', m.FN, 1);
eq('FP', m.FP, 0);
eq('TN', m.TN, 1);
eq('recall = TP/(TP+FN) = 1/2', m.recall, 0.5);
eq('precision = TP/(TP+FP) = 1/1', m.precision, 1);
eq('見逃しリストにc', m.misses.map(x => x.id), ['c']);

// 過剰指摘(FP): 期待pass だが実測 warn
m = computeMetrics([{
  type: 'mitori', file: 'y.pdf',
  expect: { items: { d: 'pass' } },
  verdict: { items: { d: 'warn' } },
}]);
eq('FP(過剰指摘)', m.FP, 1);
eq('過剰指摘リストにd', m.overflags.map(x => x.id), ['d']);

// 実測に無いidはpass扱い（未回答→見逃し判定）
m = computeMetrics([{
  type: 'keitou', file: 'z.pdf',
  expect: { items: { e: 'fail' } },
  verdict: { items: {} },
}]);
eq('実測欠落→見逃しFN', m.FN, 1);

// na期待は正常扱い（不備でない）
m = computeMetrics([{
  type: 'keitou', file: 'w.pdf',
  expect: { items: { f: 'na' } },
  verdict: { items: { f: 'na' } },
}]);
eq('na期待&na実測→TN', m.TN, 1);
eq('na期待でFNなし', m.FN, 0);

console.log(fail === 0 ? '\n✅ evalmetrics 全テスト合格' : `\n❌ evalmetrics ${fail}件 失敗`);
process.exit(fail === 0 ? 0 : 1);
