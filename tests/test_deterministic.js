/* 決定論チェックの単体テスト（Node実行）: node tests/test_deterministic.js */
const det = require('../core/deterministic.js');
const reg = require('../core/rules-registry.js');
['heimen', 'keitou', 'haisen'].forEach(t => require('../rules/' + t + '.js'));

let fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}\n   got:  ${g}\n   want: ${w}`); fail++; } else console.log(`✓ ${name}`);
}
function ok(cond, msg) { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) fail++; }

// ── ratedCountFor（定格動作台数テーブル）──
eq('ratedCountFor(100)=3', det.ratedCountFor(100), 3);
eq('ratedCountFor(90)=2（75以上100未満）', det.ratedCountFor(90), 2);
eq('ratedCountFor(250)=8', det.ratedCountFor(250), 8);
eq('ratedCountFor(30)=null（40未満）', det.ratedCountFor(30), null);

// ── space_width_2500 ──
eq('幅 [2500,2500] → pass', det.registry.space_width_2500({ charging_space_widths_mm: [2500, 2500] }).status, 'pass');
eq('幅 [2400,2500] → warn（未満は要確認）', det.registry.space_width_2500({ charging_space_widths_mm: [2400, 2500] }).status, 'warn');
// 複数値は配列で受け取る前提（プロンプトが配列指定）。単一文字列のカンマは桁区切りとして扱う。
eq('幅 [2500,2300] 配列 → warn（2300が未満）', det.registry.space_width_2500({ charging_space_widths_mm: [2500, 2300] }).status, 'warn');
// ⑤ 幅が抽出できない場合は検算不能 → unfired（run側でnoteOnly注記へ変換）
ok(det.registry.space_width_2500({ charging_space_widths_mm: [] }).unfired === true, '幅 空 → unfired（検算不能の注記へ）');
// カンマ桁区切りの誤分割を防ぐ
eq('幅 "約2,500mm"（2500の意）→ pass', det.registry.space_width_2500({ charging_space_widths_mm: '約2,500mm' }).status, 'pass');
eq('幅 ["2,400","2,500"] → warn（2400が未満）', det.registry.space_width_2500({ charging_space_widths_mm: ['2,400', '2,500'] }).status, 'warn');
eq('幅 "2500 2500"（空白区切り）→ pass', det.registry.space_width_2500({ charging_space_widths_mm: '2500 2500' }).status, 'pass');
// F3: 区画数(charging_count)より読取幅が少ない＝部分抽出 → passにせず warn（未確認区画の見逃し防止）
eq('F3 幅[2500]だが区画3 → warn（部分抽出）', det.registry.space_width_2500({ charging_space_widths_mm: [2500], charging_count: 3 }).status, 'warn');
eq('F3 幅[2500,2500,2500]で区画3 → pass（全区画検証済）', det.registry.space_width_2500({ charging_space_widths_mm: [2500, 2500, 2500], charging_count: 3 }).status, 'pass');
eq('F3 幅[2500,2500]で区画2 → pass', det.registry.space_width_2500({ charging_space_widths_mm: [2500, 2500], charging_count: '2' }).status, 'pass');
eq('F3 区画数不明なら従来どおりpass（過剰warn防止）', det.registry.space_width_2500({ charging_space_widths_mm: [2500] }).status, 'pass');
// 未満は区画数に関わらず warn（未満優先）
eq('F3 幅[2400]区画3 → warn（未満優先）', det.registry.space_width_2500({ charging_space_widths_mm: [2400], charging_count: 3 }).status, 'warn');

// ── demand_rated_count ──
// ①【最重要・false fail防止】決定論チェックは強制的に fail にしない（最大でも warn）。
// 主幹100AT(定格3) < 同時運転4台 → 必要。naと矛盾でも fail ではなく warn で提示。
eq('デマンド必要 & na → warn提示（強制failしない）①', det.registry.demand_rated_count({ main_breaker_at: 100, charger_count: 4 }, { currentStatus: 'na' }).status, 'warn');
ok(det.registry.demand_rated_count({ main_breaker_at: 100, charger_count: 4 }, { currentStatus: 'na' }).status !== 'fail', '①デマンドは決してfailを強制しない');
eq('デマンド必要 & pass → passのまま', det.registry.demand_rated_count({ main_breaker_at: 100, charger_count: 4 }, { currentStatus: 'pass' }).status, 'pass');
// 主幹150AT(定格5) ≥ 設置3台 → 不要。failなら na へ緩和
eq('デマンド不要 & fail → na緩和', det.registry.demand_rated_count({ main_breaker_at: 150, charger_count: 3 }, { currentStatus: 'fail' }).status, 'na');
// ①【LB/同時運転台数】8台設置でもLBで同時2台なら、定格内 → na（正しいnaをfailにしない）
eq('①LB: 125AT(定格4) 総8台/同時2台 → 定格内でna', det.registry.demand_rated_count({ main_breaker_at: 125, charger_count: 8, simultaneous_count: 2 }, { currentStatus: 'na' }).status, 'na');
eq('①LB: 100AT(定格3) 総8台/同時2台 & fail → na緩和', det.registry.demand_rated_count({ main_breaker_at: 100, charger_count: 8, simultaneous_count: 2 }, { currentStatus: 'fail' }).status, 'na');
// ①同時運転台数が定格超なら、総台数に関わらず要確認（warn）
eq('①LB: 100AT(定格3) 同時4台 & na → warn', det.registry.demand_rated_count({ main_breaker_at: 100, charger_count: 4, simultaneous_count: 4 }, { currentStatus: 'na' }).status, 'warn');
// ⑤ 数値欠落は検算不能 → unfired（noteOnly注記へ）
ok(det.registry.demand_rated_count({ main_breaker_at: null, charger_count: 4 }, {}).unfired === true, '⑤主幹AT欠落 → unfired');
ok(det.registry.demand_rated_count({ main_breaker_at: 100 }, {}).unfired === true, '⑤台数欠落（同時/総数とも空）→ unfired');
// simultaneous_count だけ有り主幹AT欠落 → 検算不能（⑤: 一部だけ抽出でもnote）
ok(det.registry.demand_rated_count({ simultaneous_count: 2 }, {}).unfired === true, '⑤同時台数のみ・主幹AT欠落 → unfired');

// ── run(): heimen rule で space_width_check の上書きが出る ──
const heimen = reg.getRule('heimen');
const ovH = det.run(heimen, { charging_space_widths_mm: [2400] }, {});
ok(ovH.space_width_check && ovH.space_width_check.status === 'warn', 'run(heimen): space_width_check を warn 上書き');

// ── apply(): rawResults にマージ ──
const raw = [{ id: 'space_width_check', status: 'pass', detail: 'AI: OK' }, { id: 'other', status: 'pass' }];
const merged = det.apply(raw, ovH);
eq('apply: space_width_check が warn に上書き', merged.find(r => r.id === 'space_width_check').status, 'warn');
eq('apply: 無関係項目は不変', merged.find(r => r.id === 'other').status, 'pass');

// ── requiredFields(): プロンプトへ要求する数値フィールド ──
ok(Object.keys(det.requiredFields(heimen)).includes('charging_space_widths_mm'), 'requiredFields(heimen): charging_space_widths_mm を要求');
const keitou = reg.getRule('keitou');
ok(Object.keys(det.requiredFields(keitou)).includes('main_breaker_at'), 'requiredFields(keitou): main_breaker_at を要求');

// ── cable_conduit_match（配線: ケーブル⇔配管サイズ適合）──
const haisen = reg.getRule('haisen');
// noteOnly（未発火注記）は status 変更ではないので 'none' 扱いにする
const sv = (o, id) => (o[id] && !o[id].noteOnly) ? o[id].status : 'none';
function ccm(pairs) { return sv(det.run(haisen, { cable_conduit_pairs: pairs }, {}), 'mc_cable_conduit_match'); }
// 2-B: 仕様表が原本未検証のため、適合でも pass を確定しない（参考注記のみ）。不適合の warn は維持。
eq('2-B 適合 [CVT8sq-3C,PFD-28] → pass確定しない(注記のみ)', ccm([['CVT8sq-3C', 'PFD-28']]), 'none');
ok(/原本未検証/.test((det.run(haisen, { cable_conduit_pairs: [['CVT8sq-3C', 'PFD-28']] }, {}).mc_cable_conduit_match || {}).detail || ''), '2-B 適合時は「原本未検証」の参考注記が付く');
eq('不適合 [CVT8sq-3C,PFD-54] → warn', ccm([['CVT8sq-3C', 'PFD-54']]), 'warn');
eq('2-B 大小文字/空白ゆれ吸収も注記のみ', ccm([[' cvt8sq-3c ', 'pfd-28']]), 'none');
eq('仕様表に無いケーブルのみ → 検算対象外(none)', ccm([['UNKNOWN-CABLE', 'XYZ']]), 'none');
eq('空配列 → 上書きしない(none)', ccm([]), 'none');
eq('2-B オブジェクト形式 {cable,conduit} 適合も注記のみ', ccm([{ cable: 'CVT100sq', conduit: 'PFD-54' }]), 'none');
eq('オブジェクト形式の不適合 → warn', ccm([{ cable: 'CVT100sq', conduit: 'PFD-28' }]), 'warn');

// ── branch_le_main（電気系統: 分岐AT≤主幹AT）──
const keitou2 = reg.getRule('keitou');
function blm(di) { return sv(det.run(keitou2, di, {}), 'nev_branch_breaker_capacity'); }
eq('分岐[20,30]≤主幹100 → pass', blm({ main_breaker_at: 100, branch_breaker_ats: [20, 30] }), 'pass');
eq('分岐[20,150]>主幹100 → warn', blm({ main_breaker_at: 100, branch_breaker_ats: [20, 150] }), 'warn');
eq('主幹欠落 → 上書きしない(none)', blm({ branch_breaker_ats: [20] }), 'none');

// ── main_af_ge_at（AF≥AT不変則）──
function afat(di) { return sv(det.run(keitou2, di, {}), 'nev_main_breaker_capacity'); }
eq('AF100≥AT75 → pass', afat({ main_breaker_af: 100, main_breaker_at: 75 }), 'pass');
eq('AF50<AT75(あり得ない) → warn', afat({ main_breaker_af: 50, main_breaker_at: 75 }), 'warn');
eq('AF欠落 → 上書きしない(none)', afat({ main_breaker_at: 75 }), 'none');

// ── P0-3: charger_count 未取得時に charging_count へフォールバック ──
eq('demand: charger_count空→charging_count採用(8>定格3→required, na矛盾→warn)',
  det.registry.demand_rated_count({ main_breaker_at: 100, charger_count: '', charging_count: '8' }, { currentStatus: 'na' }).status, 'warn');

// ── P0-4: 決定論チェック未発火の注記（noteOnly） ──
const ovNote = det.run(keitou2, { /* main_breaker_at等すべて空 */ }, {});
ok(ovNote.nev_demand && ovNote.nev_demand.noteOnly, 'run: 数値未抽出でnev_demandにnoteOnly注記');
ok(ovNote.nev_main_breaker_capacity && ovNote.nev_main_breaker_capacity.noteOnly, 'run: nev_main_breaker_capacityにnoteOnly注記');
// apply: noteOnlyはstatusを変えずdetailに追記（既存項目がある場合のみ）
const raw2 = [{ id: 'nev_demand', status: 'pass', detail: 'AI: OK' }];
const merged2 = det.apply(raw2, { nev_demand: { fn: 'demand_rated_count', noteOnly: true, detail: '【自動検算未実施】...' } });
eq('apply noteOnly: statusは不変', merged2[0].status, 'pass');
ok(/自動検算未実施/.test(merged2[0].detail), 'apply noteOnly: detailに注記追記');
// noteOnly対象がAI結果に無ければ追加しない（既定fail扱いのまま）
eq('apply noteOnly: 対象不在なら何もしない', det.apply([], { x: { noteOnly: true, detail: 'n' } }).length, 0);

// ── ⑤ 一部だけ未抽出でも noteOnly が発火する（旧: 全部空のときだけ発火するバグ） ──
// AF だけ有り AT が無い → main_af_ge_at は検算不能 → nev_main_breaker_capacity に noteOnly
const ovPartAf = det.run(keitou2, { main_breaker_af: 100 /* main_breaker_at 欠落 */ }, {});
ok(ovPartAf.nev_main_breaker_capacity && ovPartAf.nev_main_breaker_capacity.noteOnly, '⑤AF有・AT欠落 → nev_main_breaker_capacityにnoteOnly');
// simultaneous_count だけ有り 主幹AT/台数が無い → demand 検算不能 → nev_demand に noteOnly
const ovPartDem = det.run(keitou2, { simultaneous_count: 2 /* main_breaker_at/charger_count 欠落 */ }, {});
ok(ovPartDem.nev_demand && ovPartDem.nev_demand.noteOnly, '⑤同時台数のみ・主幹AT欠落 → nev_demandにnoteOnly');
// 分岐ATだけ有り主幹AT欠落 → branch_le_main 検算不能 → noteOnly
const ovPartBr = det.run(keitou2, { branch_breaker_ats: [20, 30] /* main_breaker_at 欠落 */ }, {});
ok(ovPartBr.nev_branch_breaker_capacity && ovPartBr.nev_branch_breaker_capacity.noteOnly, '⑤分岐AT有・主幹AT欠落 → noteOnly');

// ── 辞書補正（旧ツール復元）: 1文字誤読 PFP→PFD を補正し誤warnを防ぐ ──
{
  const rr = { meta: { spec: { cableConduitMatch: { 'CVT8sq-3C': ['PFD-28'] } } } };
  const okC = det.registry.cable_conduit_match({ cable_conduit_pairs: [['CVT8sq-3C', 'PFP-28']] }, { rule: rr });
  ok(okC.unfired === true && /表記補正/.test(okC.detail) && /PFP-28→PFD-28/.test(okC.detail), '辞書補正: PFP-28→PFD-28 で適合扱い＋補正注記');
  const ng = det.registry.cable_conduit_match({ cable_conduit_pairs: [['CVT8sq-3C', 'PFD-54']] }, { rule: rr });
  eq('辞書補正: 2文字以上差(PFD-54)は補正せずwarn維持', ng.status, 'warn');
}
// ── main_at_per_count（D-2復元・LB対応）──
eq('AT充足: 75AT×4台→warn(必要125AT)', det.registry.main_at_per_count({ main_breaker_at: 75, charger_count: 4 }, {}).status, 'warn');
ok(det.registry.main_at_per_count({ main_breaker_at: 125, charger_count: 4 }, {}).unfired === true, 'AT充足: 125AT×4台→参考注記(passは付与しない)');
ok(det.registry.main_at_per_count({ main_breaker_at: 75, charger_count: 8, simultaneous_count: 2 }, {}).unfired === true, 'AT充足: LB同時2台なら75ATで充足（参考注記）');
ok(det.registry.main_at_per_count({ main_breaker_at: 100 }, {}).unfired === true, 'AT充足: 台数欠落→unfired');

console.log(fail === 0 ? '\n✅ deterministic 全テスト合格' : `\n❌ deterministic ${fail}件 失敗`);
process.exit(fail === 0 ? 0 : 1);
