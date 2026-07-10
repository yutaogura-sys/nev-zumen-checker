/* 波③: 色観測サニティ（core/colorsanity.js）の回帰テスト（Node実行）
   node tests/test_colorsanity.js
   仕様（P1の明示的例外・組織承認済み）:
     - Pass1 が「色観測不能(0色)/1色のみ」を報告した場合に限り、色依存3項目
       (mc_color_coding / mc_burial_hatching / new_existing_distinction) の fail を warn に降格
     - pass への変更は一切しない（warn/na/pass は不変）
     - 観測OK（2色以上）は無介入
     - 観測フィールド自体が無い（1パス/batch経路）は無介入 */
'use strict';
const sanity = require('../core/colorsanity.js');

let fail = 0;
function ok(cond, msg) { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) fail++; }
function eq(msg, got, want) { ok(got === want, `${msg}（got: ${JSON.stringify(got)} / want: ${JSON.stringify(want)}）`); }

function mkResult(colors, statuses) {
  // statuses: {mc_color_coding, mc_burial_hatching, new_existing_distinction, other...}
  const di = {};
  if (colors !== undefined) di.wire_color_distinction = colors;
  return {
    detected_info: di,
    nev_results: [
      { id: 'new_existing_distinction', status: statuses.new_existing_distinction || 'pass', detail: '元詳細N' },
      { id: 'drawing_name', status: statuses.drawing_name || 'fail', detail: '図面名不備' },
    ],
    manual_results: [
      { id: 'mc_color_coding', status: statuses.mc_color_coding || 'pass', detail: '元詳細C' },
      { id: 'mc_burial_hatching', status: statuses.mc_burial_hatching || 'pass', detail: '元詳細B' },
      { id: 'mc_cable_protector', status: statuses.mc_cable_protector || 'fail', detail: 'プロテクター' },
    ],
  };
}

// 1) 色観測不能（空配列）→ 色依存3項目の fail を warn に降格
{
  const r = mkResult([], { mc_color_coding: 'fail', mc_burial_hatching: 'fail', new_existing_distinction: 'fail' });
  const s = sanity.apply(r);
  eq('0色: 降格件数', s.count, 3);
  eq('0色: mc_color_coding fail→warn', r.manual_results[0].status, 'warn');
  eq('0色: mc_burial_hatching fail→warn', r.manual_results[1].status, 'warn');
  eq('0色: new_existing_distinction fail→warn', r.nev_results[0].status, 'warn');
  ok(r.manual_results[0].detail.includes('色観測不能のため要目視（モノクロ誤認防止）'), '0色: 指定文言を detail に付す');
  ok(r.manual_results[0].detail.includes('元詳細C'), '0色: 元の判定理由を保持');
  eq('0色: original_status を保持', r.manual_results[0].original_status, 'fail');
  // 対象外項目の fail は不変（drawing_name / mc_cable_protector はタスク仕様の対象外）
  eq('0色: 対象外(drawing_name)の fail は不変', r.nev_results[1].status, 'fail');
  eq('0色: 対象外(mc_cable_protector)の fail は不変', r.manual_results[2].status, 'fail');
}

// 2) 1色のみ → 同様に降格
{
  const r = mkResult(['赤'], { mc_color_coding: 'fail' });
  const s = sanity.apply(r);
  eq('1色: 降格件数', s.count, 1);
  eq('1色: mc_color_coding fail→warn', r.manual_results[0].status, 'warn');
  ok(r.manual_results[0].detail.includes('「赤」の1色のみ観測'), '1色: 観測内容を detail に明記');
}

// 3) pass / warn / na は一切変更しない（pass化の禁止＋不必要な介入なし）
{
  const r = mkResult([], { mc_color_coding: 'pass', mc_burial_hatching: 'warn', new_existing_distinction: 'na' });
  const s = sanity.apply(r);
  eq('pass/warn/na: 降格件数0', s.count, 0);
  eq('pass は不変', r.manual_results[0].status, 'pass');
  eq('warn は不変', r.manual_results[1].status, 'warn');
  eq('na は不変', r.nev_results[0].status, 'na');
  ok(!r.manual_results[0].detail.includes('自動降格'), 'pass の detail に降格文言を付さない');
}

// 4) 観測OK（2色以上）→ 旧ツール準拠の「矛盾降格」: 色を観測できているのに色分け系がfail
//    ＝Pass2の見落とし/矛盾の可能性 → fail→warn（残存差分①の復元。パリティ再監査で承認）
{
  const r = mkResult(['赤', '青'], { mc_color_coding: 'fail', new_existing_distinction: 'fail' });
  const s = sanity.apply(r);
  eq('2色×fail: 矛盾降格3件(指定2＋fixture既定のmc_cable_protector)', s.count, 3);
  eq('2色×fail: warnへ降格', r.manual_results[0].status, 'warn');
}
// 4b) 重複色は1色と数える（['赤','赤'] を2色と誤認しない）
{
  const r = mkResult(['赤', '赤'], { mc_color_coding: 'fail' });
  const s = sanity.apply(r);
  eq('重複色: 1色扱いで降格', s.count, 1);
}

// 5) 観測フィールド自体が無い（1パス/batch経路）→ 完全無介入
{
  const r = mkResult(undefined, { mc_color_coding: 'fail', new_existing_distinction: 'fail' });
  const s = sanity.apply(r);
  eq('フィールドなし: 降格件数0', s.count, 0);
  eq('フィールドなし: fail は不変', r.manual_results[0].status, 'fail');
}

// 6) 防御: 文字列で返された観測値（"赤、青"）は2色として解釈→矛盾降格の対象
{
  const r = mkResult('赤、青', { mc_color_coding: 'fail' });
  const s = sanity.apply(r);
  eq('文字列2色: 矛盾降格2件(指定1＋fixture既定のmc_cable_protector)', s.count, 2);
}

// 7) 防御: result/detected_info が壊れていても例外にしない
{
  ok(sanity.apply(null).count === 0, 'null 入力で例外なし');
  ok(sanity.apply({}).count === 0, 'detected_info なしで例外なし');
  const r = { detected_info: { wire_color_distinction: [] }, nev_results: 'broken', manual_results: [null, { id: 'mc_color_coding', status: 'FAIL ', detail: '' }] };
  const s = sanity.apply(r);
  eq('壊れた配列/状態表記ゆれ: FAIL も降格', s.count, 1);
  eq('表記ゆれ: warn へ', r.manual_results[1].status, 'warn');
}

// ── 矛盾降格（旧5項目セット）: 複数色を観測済みなのに色分け系がfail → warn ──
{
  const res = { detected_info: { wire_color_distinction: ['赤', '青'] }, manual_results: [
    { id: 'mc_color_coding', status: 'fail', detail: 'x' },
    { id: 'mc_new_existing_prefix', status: 'fail', detail: 'x' },
    { id: 'mc_cable_protector', status: 'fail', detail: 'x' },
    { id: 'mc_summary_table', status: 'fail', detail: 'x' }, // 非色依存は不変
    { id: 'mc_burial_hatching', status: 'pass', detail: 'x' }, // passは不変
  ] };
  const out = sanity.apply(res);
  ok(out.reason === 'contradiction' && out.count === 3, '矛盾降格: 観測2色×fail3件→3件降格(reason=contradiction)');
  ok(res.manual_results[0].status === 'warn' && /矛盾/.test(res.manual_results[0].detail), 'mc_color_coding が warn＋矛盾注記');
  ok(res.manual_results[3].status === 'fail', '非色依存(mc_summary_table)は不変');
  ok(res.manual_results[4].status === 'pass', 'passは昇格も降格もしない');
}

console.log(fail === 0 ? '\n✅ colorsanity 全テスト合格' : `\n❌ colorsanity ${fail}件 失敗`);
process.exit(fail === 0 ? 0 : 1);
