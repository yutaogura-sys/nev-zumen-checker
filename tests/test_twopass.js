/* 波③: 配線ルート図の2パス方式（Pass1抽出専用→Pass2判定専用）のプロンプト生成検証（Node実行）
   node tests/test_twopass.js
   検証点:
     1. Pass1 スキーマに色観測・旗上げ・統括表フィールドが含まれ、判定を禁止している
     2. Pass2 に Pass1 データ(JSON)が埋め込まれ、全チェック項目を含み、detected_info を再要求しない
     3. 1パス(buildPrompt)は従来どおり（pass1Extra が混入しない＝batch.js 経路の不変） */
'use strict';
const reg = require('../core/rules-registry.js');
const prompt = require('../core/prompt.js');
['mitori', 'heimen', 'haisen', 'keitou'].forEach(t => require('../rules/' + t + '.js'));

let fail = 0;
function ok(cond, msg) { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) fail++; }

const haisen = reg.getRule('haisen');

// 0) twoPass 設定は配線ルート図のみ
ok(haisen.settings.twoPass === true, 'haisen: settings.twoPass=true');
['mitori', 'heimen', 'keitou'].forEach(t => {
  ok(!reg.getRule(t).settings.twoPass, `${t}: twoPass は無効（配線のみ2パス）`);
});

// 1) Pass1（抽出専用）プロンプト
{
  const p1 = prompt.buildPass1Prompt(haisen, 'mokutekichi');
  ok(p1.includes('要件の合否判定は行いません'), 'Pass1: 判定禁止の宣言を含む');
  ok(p1.includes('"detected_info"'), 'Pass1: detected_info スキーマを含む');
  // 色観測フィールド（サニティ降格の入力）
  ['is_color_drawing', 'color_observation_summary', 'color_legend_observed',
   'color_legend_location', 'wire_color_distinction', 'hatching_colors_observed', 'hatching_locations']
    .forEach(f => ok(p1.includes(`"${f}"`), `Pass1: 色観測フィールド ${f} を要求`));
  // 旗上げ・統括表・検算用フィールド（既存 requires/extraDetectedInfo との整合＝重複でなく集約）
  ['wire_annotations', 'wire_table_totals', 'wire_annotation_sums', 'wire_drawn_lengths', 'cable_conduit_pairs']
    .forEach(f => ok(p1.includes(`"${f}"`), `Pass1: 抽出フィールド ${f} を要求`));
  // 共通6種
  ok(p1.includes('"facility_name"') && p1.includes('"charging_count"'), 'Pass1: 共通 detected_info 6種を要求');
  // 数値読み取りノウハウ（readingGuidance）が Pass1 に載る
  ok(p1.includes('15↔150'), 'Pass1: 桁検証ディシプリンを含む');
  ok(p1.includes('カラー観測'), 'Pass1: 色観測手順（pass1Guidance）を含む');
  // 判定用の出力キーは要求しない
  ok(!p1.includes('"nev_results"') && !p1.includes('"manual_results"'), 'Pass1: 判定結果キーを要求しない');
}

// 2) Pass2（判定専用）プロンプト: Pass1 データの埋め込み
{
  const pass1Data = {
    facility_name: '○○マンション',
    wire_color_distinction: ['赤', '青'],
    color_legend_observed: '赤線=新設配線、青線=既設配線',
    wire_table_totals: [{ type: 'CVT8sq-3C', total_length_m: 13 }],
    wire_annotations: [{ cable: 'CVT8sq-3C', conduit: 'PFD-28', method: '露出配管', length_m: 13, note: '' }],
    _internalKey: 'should-not-appear',
  };
  const p2 = prompt.buildPass2Prompt(haisen, 'mokutekichi', pass1Data);
  ok(p2.includes('Pass 1 読み取り結果'), 'Pass2: Pass1参考データブロックを含む');
  ok(p2.includes('"CVT8sq-3C"'), 'Pass2: Pass1の統括表データがJSON埋め込みされる');
  ok(p2.includes('"赤"') && p2.includes('赤線=新設配線、青線=既設配線'), 'Pass2: Pass1の色観測データが埋め込まれる');
  ok(!p2.includes('_internalKey') && !p2.includes('should-not-appear'), 'Pass2: 内部キー(_始まり)は添付しない');
  ok(p2.includes('合否判定のみに集中'), 'Pass2: 判定専任の宣言を含む');
  ok(p2.includes('Pass 1 で抽出済みのため、このパスでは出力しない'), 'Pass2: detected_info の再抽出を禁止');
  ok(!p2.includes('"facility_name": "読み取れた設置場所/施設名"'), 'Pass2: detected_info 抽出スキーマを含まない');
  ok(p2.includes('矛盾自己チェック'), 'Pass2: 矛盾自己チェック（pass2Guidance）を含む');
  ok(p2.includes('"nev_results"') && p2.includes('"manual_results"'), 'Pass2: 判定結果キー(nev/manual)を要求');
  // 全チェック項目が漏れなく含まれる（buildPrompt と同等の網羅性）
  const checks = reg.filterChecks(haisen, 'mokutekichi');
  const missing = checks.filter(c => !p2.includes('[' + c.id + ']')).map(c => c.id);
  ok(missing.length === 0, `Pass2: 全${checks.length}項目のIDを含む${missing.length ? '（欠落:' + missing.join(',') + '）' : ''}`);
  // 基礎充電でも生成できる
  const p2k = prompt.buildPass2Prompt(haisen, 'kiso', pass1Data);
  ok(p2k.includes('基礎充電'), 'Pass2: kiso でも生成できる');
  // pass1Data が空でも例外にならない（フォールバックは app.js 側だが生成自体は防御）
  const p2e = prompt.buildPass2Prompt(haisen, 'kiso', null);
  ok(p2e.includes('Pass 1 読み取り結果'), 'Pass2: pass1Data=null でも生成できる（空JSON）');
}

// 3) 1パス(buildPrompt)の不変（batch.js 経路）: pass1Extra の色観測フィールドが混入しない
{
  const p = prompt.buildPrompt(haisen, 'mokutekichi');
  ok(!p.includes('"wire_color_distinction"'), '1パス: 色観測フィールドが混入しない（batch挙動の不変）');
  ok(!p.includes('"is_color_drawing"'), '1パス: is_color_drawing が混入しない');
  ok(p.includes('"wire_annotations"') && p.includes('"wire_table_totals"'), '1パス: 従来の抽出フィールドは維持');
  ok(p.includes('15↔150'), '1パス: readingGuidance が従来どおり連結される（guidance分割の回帰なし）');
  ok(p.includes('## この図面の要点'), '1パス: guidance（要点）が維持される');
  ok(p.includes('"detected_info"') || p.includes('"facility_name"'), '1パス: detected_info スキーマは従来どおり要求');
}

console.log(fail === 0 ? '\n✅ twopass 全テスト合格' : `\n❌ twopass ${fail}件 失敗`);
process.exit(fail === 0 ? 0 : 1);
