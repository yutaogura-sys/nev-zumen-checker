/* 波④-4: 月次コスト管理（core/cost.js CapTracker の月別キー）の回帰テスト（Node実行）
   node tests/test_cost_monthly.js
   検証点:
     - store キーが nev_cost_total_YYYYMM（月別）
     - 月替わりで自動的に0から再計上（自動リセット）。過去月のキーは監査用に残る
     - 旧キー nev_cost_total_jpy（無期限累計）は初回アクセスで当月へ移行・旧キー削除
     - store 注入・localStorage 無し環境は従来どおり（後方互換） */
'use strict';

// localStorage モック（cost.js の require より前に定義すること）
const mem = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; },
};

const cost = require('../core/cost.js');

let fail = 0;
function ok(cond, msg) { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) fail++; }
function eq(msg, got, want) { ok(got === want, `${msg}（got: ${JSON.stringify(got)} / want: ${JSON.stringify(want)}）`); }

// 0) キー生成
eq('currentMonthKey 形式', cost.currentMonthKey(() => new Date(2026, 6, 10)), 'nev_cost_total_202607');
eq('currentMonthKey 1桁月の0埋め', cost.currentMonthKey(() => new Date(2026, 0, 5)), 'nev_cost_total_202601');

// 1) 月別キーへの加算
{
  let fake = new Date(2026, 6, 10); // 2026-07
  const t = new cost.CapTracker({ capJpy: 100, now: () => fake });
  t.addCost({ totalCostJpy: 40 });
  eq('7月に40円計上', t.getTotalJpy(), 40);
  eq('月別キーに保存', mem['nev_cost_total_202607'], '40');

  // 2) 月替わり → 自動リセット（0から再計上）・過去月キーは残る
  fake = new Date(2026, 7, 1); // 2026-08
  eq('月替わりで今月の累計は0', t.getTotalJpy(), 0);
  t.addCost({ totalCostJpy: 10 });
  eq('8月に10円計上', t.getTotalJpy(), 10);
  eq('8月キーに保存', mem['nev_cost_total_202608'], '10');
  eq('7月キーは監査用に残る', mem['nev_cost_total_202607'], '40');

  // 上限判定も今月分で行われる
  const s = t.getState();
  eq('上限判定は今月分（10/100=ok）', s.status, 'ok');
}

// 3) 旧キー（無期限累計）の初回移行
{
  Object.keys(mem).forEach(k => delete mem[k]);
  mem['nev_cost_total_jpy'] = '123.45';
  const fake = new Date(2026, 6, 15);
  const t = new cost.CapTracker({ capJpy: 100, now: () => fake });
  eq('旧累計が当月へ移行される', t.getTotalJpy(), 123.45);
  ok(!('nev_cost_total_jpy' in mem), '旧キーは削除される');
  eq('当月キーに移行値', mem['nev_cost_total_202607'], '123.45');
  // 移行後も上限超過の表示（組織方針: 何円オーバーか）が正しく出る
  const msg = t.getMessage();
  ok(msg && msg.level === 'error' && msg.text.includes('23.45 円 オーバー'), '移行後の超過額表示が正しい');
  ok(msg.text.includes('今月の累計'), 'メッセージに「今月の累計」を明示');
}

// 3b) 旧キー＋当月キーが両方ある場合は合算
{
  Object.keys(mem).forEach(k => delete mem[k]);
  mem['nev_cost_total_jpy'] = '50';
  mem['nev_cost_total_202607'] = '25';
  const t = new cost.CapTracker({ now: () => new Date(2026, 6, 20) });
  eq('旧累計と当月分を合算', t.getTotalJpy(), 75);
}

// 4) リセットは今月分のみ0にする
{
  Object.keys(mem).forEach(k => delete mem[k]);
  mem['nev_cost_total_202607'] = '99';
  const t = new cost.CapTracker({ now: () => new Date(2026, 6, 20) });
  t.reset();
  eq('リセット後は0', t.getTotalJpy(), 0);
}

// 5) 後方互換: store 注入時は月別キーを使わない（既存テスト・regression.js の呼び出し形を維持）
{
  let v = 0;
  const t = new cost.CapTracker({ capJpy: 100, store: { get: () => v, set: x => { v = x; } } });
  t.addCost({ totalCostJpy: 30 });
  eq('store注入: 従来どおり動作', t.getTotalJpy(), 30);
  ok(!('nev_cost_total_undefined' in mem), 'store注入: localStorage に触れない');
}

// 6) 後方互換: localStorage 無し環境（メモリストア）
{
  const saved = global.localStorage;
  delete global.localStorage;
  delete require.cache[require.resolve('../core/cost.js')];
  const cost2 = require('../core/cost.js');
  const t = new cost2.CapTracker({ capJpy: 0 });
  t.addCost({ totalCostJpy: 5 });
  eq('localStorage無し: メモリストアで動作', t.getTotalJpy(), 5);
  global.localStorage = saved;
}

console.log(fail === 0 ? '\n✅ cost_monthly 全テスト合格' : `\n❌ cost_monthly ${fail}件 失敗`);
process.exit(fail === 0 ? 0 : 1);
