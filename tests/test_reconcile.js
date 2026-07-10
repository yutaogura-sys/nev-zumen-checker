/* 配線数値 三者照合の単体テスト: node tests/test_reconcile.js */
const R = require('../core/reconcile.js');
const det = require('../core/deterministic.js');
const reg = require('../core/rules-registry.js');
require('../rules/haisen.js');

let fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}\n   got:  ${g}\n   want: ${w}`); fail++; } else console.log(`✓ ${name}`);
}
function ok(cond, msg) { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) fail++; }

// 三者一致 → 不整合なし
let r = R.reconcile({
  table: [{ type: 'CVT8sq-3C', total_length_m: 13 }],
  annotation: [{ type: 'CVT8sq-3C', total_length_m: 13 }],
  drawn: [{ type: 'CVT8sq-3C', total_length_m: 13 }],
});
eq('三者一致 → ok', r.ok, true);

// 桁違い（13 vs 130）→ 不整合検出
r = R.reconcile({
  table: [{ type: 'CVT8sq-3C', total_length_m: 130 }],
  annotation: [{ type: 'CVT8sq-3C', total_length_m: 13 }],
});
eq('桁違い13↔130 → 不整合1件', r.discrepancies.length, 1);
ok(/桁違い/.test(r.discrepancies[0].note), '桁違い注記');

// 表記ゆれ（全角×・空白）は同一種別として扱う
r = R.reconcile({
  table: [{ type: 'CVT8sq-3C', total_length_m: 13 }],
  annotation: [{ type: ' cvt8sq-3c ', total_length_m: 13 }],
});
eq('表記ゆれ吸収で一致 → ok', r.ok, true);

// 1系統のみ → 読み落とし候補
r = R.reconcile({ table: [{ type: 'FEP-30', total_length_m: 2 }], annotation: [], drawn: [] });
eq('1系統のみ → 不整合(読み落とし候補)', r.discrepancies.length, 1);

// 小さな差(1m)は許容
r = R.reconcile({
  table: [{ type: 'CVT8sq-3C', total_length_m: 13 }],
  annotation: [{ type: 'CVT8sq-3C', total_length_m: 13.5 }],
});
eq('1m未満の差は許容 → ok', r.ok, true);

// deterministic経由（haisen wire_reconcile）
// noteOnly（未発火注記）は status を変えないので 'none' 扱いにする
function wr(di) { const o = det.run(reg.getRule('haisen'), di, {}); return (o.total_length && !o.total_length.noteOnly) ? o.total_length.status : 'none'; }
eq('wire_reconcile 一致 → pass', wr({
  wire_table_totals: [{ type: 'CVT100sq', total_length_m: 10 }],
  wire_annotation_sums: [{ type: 'CVT100sq', total_length_m: 10 }],
}), 'pass');
eq('wire_reconcile 桁違い → warn', wr({
  wire_table_totals: [{ type: 'CVT100sq', total_length_m: 100 }],
  wire_annotation_sums: [{ type: 'CVT100sq', total_length_m: 10 }],
}), 'warn');
// ⑤ 2系統未満は三者照合不能 → status は変えず noteOnly注記（旧: 無反応）
eq('wire_reconcile 2系統未満 → status変更なし(none)', wr({ wire_table_totals: [{ type: 'CVT100sq', total_length_m: 10 }] }), 'none');
const ovWr1 = det.run(reg.getRule('haisen'), { wire_table_totals: [{ type: 'CVT100sq', total_length_m: 10 }] }, {});
ok(ovWr1.total_length && ovWr1.total_length.noteOnly && /自動検算未実施/.test(ovWr1.total_length.detail), '⑤wire_reconcile 2系統未満 → noteOnly注記が出る');

// 共入れ分解: 旗上げの複合表記 "CV38sq-2C+IV8sq" を各ケーブルに分解して照合
// （実図面で確認済み: 分解しないと統括表〔ケーブル別〕とキーが合わず誤warn 3件が出る）
const rKumi = R.reconcile({
  table: [{ type: 'CV38sq-2C', total_length_m: 27 }, { type: 'IV8sq', total_length_m: 27 }, { type: 'CV8sq-3C', total_length_m: 51 }],
  annotation: [{ type: 'CV38sq-2C+IV8sq', total_length_m: 27 }, { type: 'CV8sq-3C', total_length_m: 51 }],
});
eq('共入れ分解: 複合表記でも不整合0（誤warn根絶）', rKumi.discrepancies.length, 0);
// 分解後に本当の乖離があれば従来どおり検出（安全網は維持）
const rKumi2 = R.reconcile({
  table: [{ type: 'CV38sq-2C', total_length_m: 100 }, { type: 'IV8sq', total_length_m: 27 }],
  annotation: [{ type: 'CV38sq-2C+IV8sq', total_length_m: 27 }],
});
ok(rKumi2.discrepancies.some(d => /CV38/i.test(d.type)), '共入れ分解後も桁違い乖離は検出される');
// 同一種別の分割記載は加算される
const rSum = R.reconcile({
  table: [{ type: 'CV8sq-3C', total_length_m: 10 }],
  annotation: [{ type: 'CV8sq-3C', total_length_m: 6 }, { type: 'CV8sq-3C', total_length_m: 4 }],
});
eq('同一種別の分割記載は合算して照合', rSum.discrepancies.length, 0);

// ── B: 旗上げ一覧(wire_annotations)からのコード再集計（AI申告合算より優先） ──
function wrFull(di) { return det.run(reg.getRule('haisen'), di, {}).total_length; }
// 一覧→コード合算→照合一致: AIの自己申告合算(130=誤)は無視され、コード集計(5+8=13)が統括表13と一致→pass
{
  const o = wrFull({
    wire_table_totals: [{ type: 'CVT8sq-3C', total_length_m: 13 }],
    wire_annotation_sums: [{ type: 'CVT8sq-3C', total_length_m: 130 }], // AIの合算誤り（無視されるべき）
    wire_annotations: [
      { cable: 'CVT8sq-3C', conduit: '', method: '露出', length_m: 5, note: '' },
      { cable: 'CVT8sq-3C', conduit: '', method: '露出 立上げ', length_m: 8, note: '' },
    ],
  });
  eq('B: 旗上げ一覧のコード合算がAI申告合算より優先され一致 → pass', o && o.status, 'pass');
  ok(/コード集計（旗上げ2件/.test(o.detail || ''), 'B: detailに「旗上げ合算はコード集計(N件)」を明記');
}
// 桁違い検出: コード合算13 vs 統括表130 → warn（安全網は維持）
{
  const o = wrFull({
    wire_table_totals: [{ type: 'CVT8sq-3C', total_length_m: 130 }],
    wire_annotations: [
      { cable: 'CVT8sq-3C', length_m: 5 },
      { cable: 'CVT8sq-3C', length_m: 8 },
    ],
  });
  eq('B: コード合算13 vs 統括表130（桁違い）→ warn', o && o.status, 'warn');
  ok(/コード集計/.test(o.detail || ''), 'B: 桁違い警告にもコード集計の注記');
}
// 配管側の照合: 共入れ2の重複エントリは note「共入れ2」で物理長に按分され、統括表の配管行と一致
{
  const o = wrFull({
    wire_table_totals: [
      { type: 'CV38sq-2C', total_length_m: 10 }, { type: 'IV8sq', total_length_m: 10 },
      { type: 'PFD-28', total_length_m: 10 }, // 統括表の配管行
    ],
    wire_annotations: [
      { cable: 'CV38sq-2C', conduit: 'PFD-28', method: '露出配管', length_m: 10, note: '共入れ2' },
      { cable: 'IV8sq', conduit: 'PFD-28', method: '露出配管', length_m: 10, note: '共入れ2' },
    ],
  });
  eq('B: 配管の共入れ按分（10/2+10/2=10）が統括表の配管行と一致 → pass', o && o.status, 'pass');
}
// 配管按分をしないと 20 vs 10 で誤warnになるケースが、按分により根絶されることの対照:
// 統括表に無い配管種別は照合対象に加えない（配管行の無い統括表で過剰warnを出さない）
{
  const o = wrFull({
    wire_table_totals: [{ type: 'CV8sq-3C', total_length_m: 10 }],
    wire_annotations: [{ cable: 'CV8sq-3C', conduit: 'E25', method: '露出配管', length_m: 10, note: '' }],
  });
  eq('B: 統括表に配管行が無ければ配管は照合対象外（過剰warnなし）→ pass', o && o.status, 'pass');
}
// 一覧が空/数値なしの場合は従来どおり wire_annotation_sums にフォールバック
{
  const o = wrFull({
    wire_table_totals: [{ type: 'CVT100sq', total_length_m: 10 }],
    wire_annotation_sums: [{ type: 'CVT100sq', total_length_m: 10 }],
    wire_annotations: [],
  });
  eq('B: 一覧が空ならAI申告合算にフォールバック → pass', o && o.status, 'pass');
  ok(!/コード集計/.test(o.detail || ''), 'B: フォールバック時はコード集計の注記なし');
}
// 本数不明の共入れ（「共入れ」のみ）は按分不能 → その配管種別は照合から除外（誤warn防止）
{
  const o = wrFull({
    wire_table_totals: [
      { type: 'CV38sq-2C', total_length_m: 10 }, { type: 'IV8sq', total_length_m: 10 },
      { type: 'PFD-28', total_length_m: 10 },
    ],
    wire_annotations: [
      { cable: 'CV38sq-2C', conduit: 'PFD-28', length_m: 10, note: '共入れ' }, // 本数なし
      { cable: 'IV8sq', conduit: 'PFD-28', length_m: 10, note: '共入れ' },
    ],
  });
  // PFD-28 は annotation 側から除外 → table のみ=「1系統にのみ記載」warn が出る（読み落とし系の安全側）
  // ここで確認したいのは「20 vs 10 の桁違い誤warnを出さない」こと
  ok(!/桁違い/.test((o && o.detail) || ''), 'B: 本数不明の共入れは按分せず、誤った桁違いwarnを出さない');
}

console.log(fail === 0 ? '\n✅ reconcile 全テスト合格' : `\n❌ reconcile ${fail}件 失敗`);
process.exit(fail === 0 ? 0 : 1);
