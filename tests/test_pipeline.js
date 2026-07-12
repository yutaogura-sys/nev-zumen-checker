/* ============================================================
   tests/test_pipeline.js — 結線部（vote→deterministic→aggregate）の安全性テスト
   2026-07-09 テコ入れの目標挙動を固定する（TDD: 実装前は一部失敗が正）。
   背骨: P1 安全網の単調性 / P2 精度モードの単調安全 / P3 迷えば要確認
   ============================================================ */
'use strict';
const vote = require('../core/vote.js');
const det = require('../core/deterministic.js');
const agg = require('../core/aggregate.js');

let fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}\n   got:  ${g}\n   want: ${w}`); fail++; } else console.log(`✓ ${name}`);
}
function ok(cond, msg) { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) fail++; }

// app.js computeAggs 相当の最小結線
function pipeline(runs, rule, checks) {
  const merged = vote.mergeRuns(runs);
  const raw = merged.results || [];
  const rawById = {}; raw.forEach(r => { if (r && r.id != null) rawById[r.id] = r; });
  const ov = det.run(rule, merged.detected_info || {}, rawById);
  const applied = det.apply(raw, ov);
  return { merged, applied, agg: agg.aggregateResults(applied, checks) };
}
const CK = (id, extra) => Object.assign({ id, category: 'c', label: id, required: true }, extra);

// ══ FA-A: currentStatus の大文字小文字（'NA'）でも na→warn 矯正が効く ══
{
  const rule = { deterministic: [{ fn: 'demand_rated_count', targets: ['demand'], requires: { main_breaker_at: '', charger_count: '', simultaneous_count: '' } }] };
  const runs = [{ results: [{ id: 'demand', status: 'NA', found_text: '', detail: '' }], detected_info: { main_breaker_at: 100, charger_count: 4 } }];
  const r = pipeline(runs, rule, [CK('demand', { condition: 'デマンド該当時' })]);
  eq('FA-A: status「NA」でもデマンド必要ならwarn矯正（総合passにしない）', r.agg.items[0].status, 'warn');
}

// ══ N1: 多数決マージ後も confidence が伝播し、low→warn 降格が効く ══
{
  const runs = [0, 1, 2].map(() => ({ results: [{ id: 'a', status: 'pass', confidence: 'low', found_text: 'x' }] }));
  const r = pipeline(runs, { deterministic: [] }, [CK('a')]);
  eq('N1: 3回一致pass(conf:low)→warn（単発と同じ安全網）', r.agg.items[0].status, 'warn');
}
{ // confidence 表記ゆれの正規化（medium/日本語は low 扱いにしない・「低」は low）
  const one = agg.aggregateResults([{ id: 'a', status: 'pass', confidence: '低', found_text: 'x' }], [CK('a')]);
  eq('N1補: confidence「低」→low正規化でwarn', one.items[0].status, 'warn');
}

// ══ FA-C: 同一run内のid重複で partial 検知が無効化されない ══
{
  const runs = [
    { results: [{ id: 'x', status: 'pass', found_text: 'r' }, { id: 'x', status: 'pass', found_text: 'r' }] },
    { results: [] }, // run2 は欠落
  ];
  const m = vote.mergeRuns(runs);
  eq('FA-C: run内重複でも片方欠落はwarn降格', m.results[0].status, 'warn');
  eq('FA-C: 判定ゆれに記録', m._voteDisagreements, ['x']);
}

// ══ N2: 配列 detected_info が run 間で割れたら決定論passを保留（上書きしない）══
{
  const rule = { deterministic: [{ fn: 'space_width_2500', targets: ['w'], requires: { charging_space_widths_mm: '' } }] };
  const runs = [
    { results: [{ id: 'w', status: 'warn', found_text: '', detail: 'AI:幅不明瞭' }], detected_info: { charging_space_widths_mm: [2500, 2500] } },
    { results: [{ id: 'w', status: 'warn', found_text: '' }], detected_info: { charging_space_widths_mm: [2400, 2500] } },
    { results: [{ id: 'w', status: 'warn', found_text: '' }], detected_info: { charging_space_widths_mm: [2400, 2500] } },
  ];
  const r = pipeline(runs, rule, [CK('w')]);
  ok(r.agg.items[0].status !== 'pass', 'N2: 幅の読取が割れたらpassにしない（現状=1回目採用でpass）');
}

// ══ N3: 数値 detected_info の2値割れは平均(中央値)で潰さない ══
{
  const runs = [
    { results: [{ id: 'demand', status: 'na', found_text: '' }], detected_info: { main_breaker_at: '100', charger_count: '4' } },
    { results: [{ id: 'demand', status: 'na', found_text: '' }], detected_info: { main_breaker_at: '200', charger_count: '4' } },
  ];
  const m = vote.mergeRuns(runs);
  ok(m.detected_info.main_breaker_at !== 150, 'N3: AT 100/200 の割れを150に平均しない');
  const rule = { deterministic: [{ fn: 'demand_rated_count', targets: ['demand'], requires: { main_breaker_at: '', charger_count: '', simultaneous_count: '' } }] };
  const rawById = { demand: { status: 'na' } };
  const ov = det.run(rule, m.detected_info, rawById);
  ok(!(ov.demand && !ov.demand.noteOnly && (ov.demand.status === 'na' || ov.demand.status === 'pass')),
    'N3: 割れた入力から緩い側(na/pass)の確定を出さない');
}

// ══ H1/H2: 決定論の pass は AI の fail/warn を上書きしない（緩め禁止）══
{
  const rule = { deterministic: [{ fn: 'wire_reconcile', targets: ['section_details'], requires: { wire_table_totals: '', wire_annotation_sums: '', wire_drawn_lengths: '' } }] };
  const runs = [{
    results: [{ id: 'section_details', status: 'fail', found_text: '区間2 配管未記載', detail: 'AI:配管欠落' }],
    detected_info: { wire_table_totals: [{ type: 'CVT8sq-3C', total_length_m: 10 }], wire_annotation_sums: [{ type: 'CVT8sq-3C', total_length_m: 10 }] },
  }];
  const r = pipeline(runs, rule, [CK('section_details')]);
  eq('H1: wire_reconcile一致でもAIのfailはfailのまま', r.agg.items[0].status, 'fail');
}
{
  const rule = { deterministic: [{ fn: 'branch_le_main', targets: ['cap'], requires: { branch_breaker_ats: '' } }] };
  const runs = [{ results: [{ id: 'cap', status: 'fail', found_text: '3台目AT未記載' }], detected_info: { main_breaker_at: 100, branch_breaker_ats: [20, 30] } }];
  const r = pipeline(runs, rule, [CK('cap')]);
  eq('H2: branch_le_main passでもAIのfailはfailのまま', r.agg.items[0].status, 'fail');
}

// ══ trustLoosen: スコープ完全一致のfnは（入力が割れていなければ）緩め方向も可 ══
{
  const rule = { deterministic: [{ fn: 'space_width_2500', targets: ['w'], requires: { charging_space_widths_mm: '' } }] };
  const runs = [{ results: [{ id: 'w', status: 'warn', found_text: '' }], detected_info: { charging_space_widths_mm: [2600, 2600], charging_count: 2 } }];
  const r = pipeline(runs, rule, [CK('w')]);
  eq('trustLoosen: 幅チェック(スコープ一致)はAI warn→pass確定を許可', r.agg.items[0].status, 'pass');
}
{
  const rule = { deterministic: [{ fn: 'demand_rated_count', targets: ['demand'], requires: { main_breaker_at: '', charger_count: '', simultaneous_count: '' } }] };
  const runs = [{ results: [{ id: 'demand', status: 'fail', found_text: '' }], detected_info: { main_breaker_at: 150, charger_count: 3 } }];
  const r = pipeline(runs, rule, [CK('demand', { condition: 'デマンド該当時' })]);
  eq('trustLoosen: デマンド不要が数値で確定ならfail→na緩和は維持', r.agg.items[0].status, 'na');
}

// ══ 締め方向はこれまで通り効く（回帰確認）══
{
  const rule = { deterministic: [{ fn: 'space_width_2500', targets: ['w'], requires: { charging_space_widths_mm: '' } }] };
  const runs = [{ results: [{ id: 'w', status: 'pass', found_text: '2.4m' }], detected_info: { charging_space_widths_mm: [2400] } }];
  const r = pipeline(runs, rule, [CK('w')]);
  eq('締め方向: 幅2400読取ならAI passでもwarn', r.agg.items[0].status, 'warn');
}
// N4: 0mm は「2500未満」として扱う
{
  const st = det.registry.space_width_2500({ charging_space_widths_mm: [2500, 0] });
  eq('N4: 幅[2500,0]はpassにしない', st.status, 'warn');
}

// ══ N6: AI未回答の項目に決定論passを新規注入しない ══
{
  const rule = { deterministic: [{ fn: 'wire_reconcile', targets: ['total_length'], requires: { wire_table_totals: '', wire_annotation_sums: '', wire_drawn_lengths: '' } }] };
  const runs = [{ results: [], detected_info: { wire_table_totals: [{ type: 'A', total_length_m: 10 }], wire_annotation_sums: [{ type: 'A', total_length_m: 10 }] } }];
  const r = pipeline(runs, rule, [CK('total_length')]);
  eq('N6: 未回答項目へのpass注入なし（既定failのまま）', r.agg.items[0].status, 'fail');
}

// ══ S2: condition/naAllowed の無い必須項目の na は warn へ矯正 ══
{
  const r = agg.aggregateResults([{ id: 'a', status: 'na', found_text: '' }], [CK('a')]);
  eq('S2: 条件なし必須のna→warn矯正', r.items[0].status, 'warn');
}
{
  const r = agg.aggregateResults([{ id: 'a', status: 'na', found_text: '' }], [CK('a', { condition: '壁面設置の場合はna' })]);
  eq('S2: condition付き必須のnaは維持', r.items[0].status, 'na');
}
{
  const r = agg.aggregateResults([{ id: 'a', status: 'na', found_text: '' }], [CK('a', { naAllowed: true })]);
  eq('S2: naAllowed明示の必須naは維持', r.items[0].status, 'na');
}
{ // 決定論が確定させた na は正当（demandの緩和等）
  const r = agg.aggregateResults([{ id: 'a', status: 'na', found_text: '', _deterministic: 'demand_rated_count' }], [CK('a')]);
  eq('S2: 決定論由来のnaは維持', r.items[0].status, 'na');
}

// ══ N7: na過半でも少数派に fail があれば warn（見逃し防止）══
{
  const m = vote.mergeRuns([
    { results: [{ id: 'a', status: 'na' }] },
    { results: [{ id: 'a', status: 'na' }] },
    { results: [{ id: 'a', status: 'fail', found_text: 'x' }] },
  ]);
  eq('N7: [na,na,fail]→warn（failを握り潰さない）', m.results[0].status, 'warn');
  const m2 = vote.mergeRuns([
    { results: [{ id: 'a', status: 'na' }] },
    { results: [{ id: 'a', status: 'na' }] },
    { results: [{ id: 'a', status: 'pass', found_text: 'x' }] },
  ]);
  eq('N7: [na,na,pass]→na維持（従来）', m2.results[0].status, 'na');
}

// ══ B-2旧来: 同statusのエコー上書きは _deterministic を付けない（ゲートバイパス防止）══
{
  const rule = { deterministic: [{ fn: 'wire_reconcile', targets: ['total_length'], requires: { wire_table_totals: '', wire_annotation_sums: '', wire_drawn_lengths: '' } }] };
  // AI が根拠なし(found_text空)で pass、コード検算も一致=pass → スタンプでゲートを外さず、根拠必須が効いて warn
  const runs = [{ results: [{ id: 'total_length', status: 'pass', found_text: '' }], detected_info: { wire_table_totals: [{ type: 'A', total_length_m: 10 }], wire_annotation_sums: [{ type: 'A', total_length_m: 10 }] } }];
  const r = pipeline(runs, rule, [CK('total_length')]);
  eq('B-2: 同status一致検算でも無根拠passはwarn（スタンプで根拠ゲートを外さない）', r.agg.items[0].status, 'warn');
  ok(/自動検算・同判定/.test(r.agg.items[0].detail || ''), 'B-2: 検算一致は参考注記として残る');
}
{ // status を実際に変える上書き（warn→pass, trustLoosen）は従来どおりスタンプされゲート免除
  const rule = { deterministic: [{ fn: 'space_width_2500', targets: ['w'], requires: { charging_space_widths_mm: '' } }] };
  const runs = [{ results: [{ id: 'w', status: 'warn', found_text: '' }], detected_info: { charging_space_widths_mm: [2600, 2600], charging_count: 2 } }];
  const r = pipeline(runs, rule, [CK('w')]);
  eq('B-2: status変更を伴うtrustLoosen上書きは従来どおりpass確定', r.agg.items[0].status, 'pass');
}

// ══ Suite P: status/confidence「__proto__」等がObject.prototype経由で安全網を素通りしない ══
{
  const r = agg.aggregateResults([{ id: 'a', status: '__proto__', found_text: 'x', confidence: 'high' }], [CK('a')]);
  eq('P: status「__proto__」→ warn矯正（false-PASS防止）', r.items[0].status, 'warn');
  const r2 = agg.aggregateResults([{ id: 'a', status: 'constructor', found_text: 'x', confidence: 'high' }], [CK('a')]);
  eq('P: status「constructor」→ warn矯正', r2.items[0].status, 'warn');
}
{
  const merged2 = det.apply([{ id: 'k', status: '__proto__', found_text: 'x' }], { k: { fn: 'wire_reconcile', status: 'pass', detail: 'd' } });
  ok(merged2[0].status !== 'pass' && !merged2[0]._deterministic, 'P: status「__proto__」でも非trustLoosenのpass緩め・スタンプ付与を遮断');
}
{
  const runs = [
    { results: [{ id: 'a', status: 'pass', confidence: '__proto__', found_text: 'x' }] },
    { results: [{ id: 'a', status: 'pass', confidence: 'low', found_text: 'x' }] },
  ];
  const m = vote.mergeRuns(runs);
  eq('P: confidence「__proto__」混入でもlowが最悪値として伝播', m.results[0].confidence, 'low');
}

// ══ F-4/F-1: trustLoosenの同statusエコーは権威スタンプ（非trustLoosenのB-2は維持）══
{
  const rule = { deterministic: [{ fn: 'space_width_2500', targets: ['w'], requires: { charging_space_widths_mm: '' } }] };
  const runs = [{ results: [{ id: 'w', status: 'pass', found_text: '' }], detected_info: { charging_space_widths_mm: [2500, 2600], charging_count: 2 } }];
  const r = pipeline(runs, rule, [CK('w')]);
  eq('F-4: 幅を実測検証したpassエコーはスタンプされ根拠ゲート免除', r.agg.items[0].status, 'pass');
}
{
  const rule = { deterministic: [{ fn: 'demand_rated_count', targets: ['demand'], requires: { main_breaker_at: '', charger_count: '', simultaneous_count: '' } }] };
  const runs = [{ results: [{ id: 'demand', status: 'na', found_text: '' }], detected_info: { main_breaker_at: 150, charger_count: 3 } }];
  const r = pipeline(runs, rule, [CK('demand')]);
  eq('F-1: デマンド不要をコード確認したnaエコーはS2ゲートで維持', r.agg.items[0].status, 'na');
}

// ══ 2-B: cable_conduit_match は一致でも pass を確定しない（spec未検証のため）══
{
  const rule = { meta: { spec: { cableConduitMatch: { 'CVT8SQ-3C': ['PFD-28'] } } }, deterministic: [{ fn: 'cable_conduit_match', targets: ['cc'], requires: { cable_conduit_pairs: '' } }] };
  const runs = [{ results: [{ id: 'cc', status: 'warn', found_text: '' }], detected_info: { cable_conduit_pairs: [['CVT8sq-3C', 'PFD-28']] } }];
  const r = pipeline(runs, rule, [CK('cc')]);
  ok(r.agg.items[0].status !== 'pass', '2-B: 仕様表一致でもpass確定しない（原本未検証）');
  const mm = det.registry.cable_conduit_match({ cable_conduit_pairs: [['CVT8sq-3C', 'PFD-54']] }, { rule: rule });
  eq('2-B: 不適合の警告(warn)は維持', mm.status, 'warn');
}

console.log(fail === 0 ? '\n✅ pipeline 全テスト合格' : `\n❌ pipeline ${fail}件 失敗`);
process.exit(fail === 0 ? 0 : 1);
