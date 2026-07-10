/* 自己一致（多数決）マージの単体テスト: node tests/test_vote.js */
const vote = require('../core/vote.js');

let fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}\n   got:  ${g}\n   want: ${w}`); fail++; } else console.log(`✓ ${name}`);
}
function ok(cond, msg) { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) fail++; }

// 単一runはそのまま
eq('1runはそのまま返す', vote.mergeRuns([{ results: [{ id: 'a', status: 'pass' }] }]).results[0].status, 'pass');

// 全一致 → その値
let m = vote.mergeRuns([
  { results: [{ id: 'a', status: 'pass' }] },
  { results: [{ id: 'a', status: 'pass' }] },
  { results: [{ id: 'a', status: 'pass' }] },
]);
eq('全一致pass', m.results[0].status, 'pass');
eq('全一致は割れ記録なし', m._voteDisagreements, []);

// 割れ（pass/fail/pass）→ warn ＋ 割れ記録
m = vote.mergeRuns([
  { results: [{ id: 'a', status: 'pass' }] },
  { results: [{ id: 'a', status: 'fail' }] },
  { results: [{ id: 'a', status: 'pass' }] },
]);
eq('割れ→warn', m.results[0].status, 'warn');
ok(m.results[0].detail.indexOf('判定ゆれ') >= 0, '割れ→detailに判定ゆれ注記');
eq('割れ→_voteDisagreementsに記録', m._voteDisagreements, ['a']);

// na が過半 → na 維持
m = vote.mergeRuns([
  { results: [{ id: 'a', status: 'na' }] },
  { results: [{ id: 'a', status: 'na' }] },
  { results: [{ id: 'a', status: 'pass' }] },
]);
eq('na過半→na維持', m.results[0].status, 'na');

// nev_results + manual_results 両方マージ
m = vote.mergeRuns([
  { nev_results: [{ id: 'n', status: 'pass' }], manual_results: [{ id: 'm', status: 'fail' }] },
  { nev_results: [{ id: 'n', status: 'pass' }], manual_results: [{ id: 'm', status: 'pass' }] },
]);
eq('nev一致pass', m.nev_results[0].status, 'pass');
eq('manual割れ(2run)→warn', m.manual_results[0].status, 'warn');

// ④ 2モデル一致で片方が項目を欠落 → 突き合わせ不成立につき warn 降格＋判定ゆれ記録
m = vote.mergeRuns([
  { results: [{ id: 'x', status: 'pass', found_text: '根拠あり' }] },
  { results: [/* runB は id 'x' を欠落 */] },
]);
eq('④片方欠落のpass → warn降格', m.results[0].status, 'warn');
ok(m.results[0].detail.indexOf('未回答') >= 0, '④片方欠落 → detailに未回答注記');
eq('④片方欠落 → _voteDisagreementsに記録', m._voteDisagreements, ['x']);
ok(m.results[0].found_text === '根拠あり', '④欠落時も回答したrunの根拠(found_text)を保持');
// ④ 断定でない na/warn は片方欠落でも降格しない（disagreementには記録）
m = vote.mergeRuns([
  { results: [{ id: 'y', status: 'na' }] },
  { results: [] },
]);
eq('④片方欠落のna → naのまま', m.results[0].status, 'na');
eq('④na欠落もdisagreement記録', m._voteDisagreements, ['y']);
// ④ 両モデルとも返す項目は従来通り（誤検出しない）
m = vote.mergeRuns([
  { results: [{ id: 'z', status: 'pass', found_text: 'a' }] },
  { results: [{ id: 'z', status: 'pass', found_text: 'b' }] },
]);
eq('④両方回答のpass一致 → passのまま（誤降格しない）', m.results[0].status, 'pass');
eq('④両方回答一致 → 判定ゆれ記録なし', m._voteDisagreements, []);

// B-1: 前後空白付き ' fail' でも fail 検知が効く（na過半でもwarnへ＝false PASS防止）
m = vote.mergeRuns([
  { results: [{ id: 'x', status: ' fail', found_text: 'f' }] },
  { results: [{ id: 'x', status: 'na' }] },
  { results: [{ id: 'x', status: 'na' }] },
]);
eq('B-1: [\' fail\',na,na]→warn（trim漏れでnaに化けない）', m.results[0].status, 'warn');
// B-2: confidence 日本語表記「低」も最悪値として伝播（多数決モードで安全網が消えない）
m = vote.mergeRuns([
  { results: [{ id: 'y', status: 'pass', confidence: '低', found_text: 'a' }] },
  { results: [{ id: 'y', status: 'pass', confidence: 'high', found_text: 'a' }] },
]);
eq('B-2: confidence「低」を最悪値で伝播', m.results[0].confidence, '低');

// detected_info: 数値は中央値、テキストは最頻値
m = vote.mergeRuns([
  { results: [], detected_info: { charger_count: '4', facility_name: 'モールA' } },
  { results: [], detected_info: { charger_count: '4', facility_name: 'モールA' } },
  { results: [], detected_info: { charger_count: '8', facility_name: 'モールB' } },
]);
eq('detected数値=中央値(4,4,8→4)', m.detected_info.charger_count, 4);
eq('detectedテキスト=最頻値', m.detected_info.facility_name, 'モールA');

// 配列(幅リスト)は最初の非空を採用
m = vote.mergeRuns([
  { results: [], detected_info: { charging_space_widths_mm: [2500, 2500] } },
  { results: [], detected_info: { charging_space_widths_mm: [2400, 2500] } },
]);
eq('配列は最初の非空', m.detected_info.charging_space_widths_mm, [2500, 2500]);

// 空/null耐性
eq('空配列→null', vote.mergeRuns([]), null);

console.log(fail === 0 ? '\n✅ vote 全テスト合格' : `\n❌ vote ${fail}件 失敗`);
process.exit(fail === 0 ? 0 : 1);
