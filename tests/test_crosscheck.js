/* 図面間クロスチェックの単体テスト（Node実行）: node tests/test_crosscheck.js */
const cc = require('../core/crosscheck.js');

let fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}\n   got:  ${g}\n   want: ${w}`); fail++; } else console.log(`✓ ${name}`);
}
function find(res, field) { return res.find(f => f.field === field); }

// 全一致
let r = cc.crossCheck({
  mitori: { detectedInfo: { facility_name: '次世代モール', creator: '次世代商事', charging_count: '4' } },
  heimen: { detectedInfo: { facility_name: '次世代モール', creator: '次世代商事', charging_count: '4' } },
  keitou: { detectedInfo: { facility_name: '次世代モール', creator: '次世代商事', charging_count: '4' } },
});
eq('全一致: 施設名 pass', find(r, 'facility_name').status, 'pass');
eq('全一致: 作成者 pass', find(r, 'creator').status, 'pass');
eq('全一致: 台数 pass', find(r, 'charging_count').status, 'pass');
eq('全一致: サマリ pass', cc.summarize(r), 'pass');

// 施設名不一致 → fail（表記ゆれは吸収）
r = cc.crossCheck({
  mitori: { detectedInfo: { facility_name: '次世代モール', creator: 'A社', charging_count: '4' } },
  heimen: { detectedInfo: { facility_name: '別のモール', creator: 'A社', charging_count: '4' } },
});
eq('施設名不一致 → fail', find(r, 'facility_name').status, 'fail');
eq('施設名不一致 サマリ fail', cc.summarize(r), 'fail');

// 表記ゆれ（スペース・括弧）は一致扱い
r = cc.crossCheck({
  mitori: { detectedInfo: { facility_name: '次世代 モール（本館）' } },
  heimen: { detectedInfo: { facility_name: '次世代モール本館' } },
});
eq('表記ゆれ吸収 → pass', find(r, 'facility_name').status, 'pass');

// 作成者不一致 → warn
r = cc.crossCheck({
  mitori: { detectedInfo: { facility_name: 'X', creator: '田中' } },
  heimen: { detectedInfo: { facility_name: 'X', creator: '佐藤' } },
});
eq('作成者不一致 → warn', find(r, 'creator').status, 'warn');

// 台数不一致 → warn
r = cc.crossCheck({
  mitori: { detectedInfo: { facility_name: 'X', charging_count: '8' } },
  keitou: { detectedInfo: { facility_name: 'X', charging_count: '4' } },
});
eq('台数不一致 → warn', find(r, 'charging_count').status, 'warn');

// 一部未記載 → warn（一致している分は）
r = cc.crossCheck({
  mitori: { detectedInfo: { facility_name: 'X', creator: 'A社' } },
  heimen: { detectedInfo: { facility_name: 'X', creator: '' } },
});
eq('作成者 一部未記載 → warn', find(r, 'creator').status, 'warn');

// 1図面のみ → 比較不可(na)
r = cc.crossCheck({ mitori: { detectedInfo: { facility_name: 'X' } } });
eq('1図面のみ → 空配列', r, []);

console.log(fail === 0 ? '\n✅ crosscheck 全テスト合格' : `\n❌ crosscheck ${fail}件 失敗`);
process.exit(fail === 0 ? 0 : 1);
