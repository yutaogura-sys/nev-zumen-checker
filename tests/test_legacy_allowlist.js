/* tests/test_legacy_allowlist.js — 旧基準デグレード対象（承認済み例外②・2026-07-17）の許可リスト固定テスト。
   目的: 旧基準デグレード（fail→warn 格下げ）は「manual群 ＋ src:'社内基準'」に適用される。
   このテストは適用対象の項目集合をスナップショットとして固定し、
     (a) 誤って NeV 要件の項目に src:'社内基準' が付く等で不合格断定が黙って消える（false-PASS方向の緩み）
     (b) 逆に旧基準項目の指定が外れて fail 断定が復活する（配布文書 C-8 の約束と矛盾）
   のどちらの事故もルール編集時に即検出する。旧基準項目を意図して増減する場合は、
   ユーザー決定を確認のうえ DECISIONS.md に記録し、このスナップショットを更新すること。 */
'use strict';
const R = require('../core/rules-registry.js');
require('../rules/mitori.js');
require('../rules/heimen.js');
require('../rules/haisen.js');
require('../rules/keitou.js');

let fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}\n   got:  ${g}\n   want: ${w}`); fail++; }
  else console.log(`✓ ${name}`);
}

// 承認済みスナップショット（2026-07-23 時点・計 68 項目）
const APPROVED = {
  mitori: ['charging_count_kiso', 'charging_count_moku'],
  heimen: ['equipment_labels', 'ground_marking_surface', 'surface_material'],
  haisen: [
    'length_breakdown', 'mc_annotation_format', 'mc_burial_conduit_type', 'mc_burial_dimension',
    'mc_burial_hatching', 'mc_cable_conduit_match', 'mc_cable_excess_length', 'mc_cable_protector',
    'mc_color_coding', 'mc_length_unit', 'mc_new_existing_prefix', 'mc_pullbox_dimension',
    'mc_pullbox_placement', 'mc_pullbox_size_spec', 'mc_summary_cable_breakdown', 'mc_summary_order',
    'mc_summary_table', 'mc_vvf_exposure', 'total_length',
  ],
  keitou: [
    'man_k_author', 'man_k_branch_breaker', 'man_k_cable_count', 'man_k_capacity_note',
    'man_k_color_exist', 'man_k_color_new', 'man_k_date', 'man_k_demand_note', 'man_k_demand_required',
    'man_k_equip_spec', 'man_k_existing', 'man_k_ground', 'man_k_lb_rule', 'man_k_location',
    'man_k_main_breaker', 'man_k_new_panel', 'man_k_no_mixed', 'man_k_panel_name', 'man_k_power_type',
    'man_k_scale', 'man_k_simultaneous', 'man_k_spare_breaker', 'man_k_subsidy_label', 'man_k_title',
    'man_m_author', 'man_m_branch_breaker_capacity', 'man_m_cable_type', 'man_m_capacity_note',
    'man_m_color_exist', 'man_m_color_new', 'man_m_date', 'man_m_equip_spec', 'man_m_ground',
    'man_m_loadbalance', 'man_m_location', 'man_m_main_breaker_spec', 'man_m_new_panel',
    'man_m_no_mixed', 'man_m_panel_name', 'man_m_power_type', 'man_m_scale', 'man_m_spare_breaker',
    'man_m_subsidy_label', 'man_m_title',
  ],
};

Object.keys(APPROVED).forEach(type => {
  const rule = R.getRule(type);
  const got = rule.checks
    .filter(c => (c.group === 'manual') || (c.src === '社内基準'))
    .map(c => c.id)
    .sort();
  eq(`旧基準デグレード対象の固定: ${type}`, got, APPROVED[type]);
  // critical な旧基準項目は禁止（格下げが critical fail を隠す経路を作らない）
  const crit = rule.checks.filter(c => ((c.group === 'manual') || (c.src === '社内基準')) && c.critical).map(c => c.id);
  eq(`旧基準×critical の禁止: ${type}`, crit, []);
});

if (fail) { console.log(`\n${fail} 件失敗`); process.exit(1); }
console.log('\ntest_legacy_allowlist: 全合格');
