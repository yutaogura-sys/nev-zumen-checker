/* tests/fuzz.js — 全量ファジング（低速・手動実行）: node tests/fuzz.js
   名前を test_*.js にしていないのは意図的（run-all の自動発見対象外＝遅いため）。
   エンジン改修時（特に aggregate/vote/deterministic）は必ず実行すること。
   旧基準不変則（suiteC）は 2026-07-23 第4Rで追加。 */
/* ============================================================
   final_fuzz.js — NeV図面チェックツール 最終ファジングハーネス
   対象: core/{vote,deterministic,aggregate,verdict,colorsanity,reconcile,prompt,cost}.js + rules/*.js
   乱数: mulberry32 シード固定（SEED=20260710）→ 完全再現可能
   実行: node final_fuzz.js
   前回ハーネス fuzz.js（SEED=20260709）の Suite A〜D を継承し、
   colorsanity(F)・辞書補正(G)・main_at_per_count(H)・reconcile(I)・prompt(J)・
   crash/cost(K)・回帰プローブ(R) を追加。
   ============================================================ */
'use strict';
const path = require('path');
const BASE = require('path').resolve(__dirname, '..');

const NevRules = require(path.join(BASE, 'core', 'rules-registry.js'));
const ruleMitori = require(path.join(BASE, 'rules', 'mitori.js'));
const ruleHeimen = require(path.join(BASE, 'rules', 'heimen.js'));
const ruleHaisen = require(path.join(BASE, 'rules', 'haisen.js'));
const ruleKeitou = require(path.join(BASE, 'rules', 'keitou.js'));
const Vote = require(path.join(BASE, 'core', 'vote.js'));
const Det = require(path.join(BASE, 'core', 'deterministic.js'));
const Agg = require(path.join(BASE, 'core', 'aggregate.js'));
const Verdict = require(path.join(BASE, 'core', 'verdict.js'));
const ColorSanity = require(path.join(BASE, 'core', 'colorsanity.js'));
const Reconcile = require(path.join(BASE, 'core', 'reconcile.js'));
const Prompt = require(path.join(BASE, 'core', 'prompt.js'));
const Cost = require(path.join(BASE, 'core', 'cost.js'));
const Util = require(path.join(BASE, 'core', 'util.js'));

const RULES = { mitori: ruleMitori, heimen: ruleHeimen, haisen: ruleHaisen, keitou: ruleKeitou };
const SEED = 20260710;

// ── プロトタイプ汚染カナリア ─────────────────────────────
const PROTO_BEFORE = Object.getOwnPropertyNames(Object.prototype).sort().join(',');

// ── seeded PRNG ──────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rnd = mulberry32(SEED);
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const chance = p => rnd() < p;
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

// ── 失敗収集（シグネチャでdedup、初回reproを保存）────────────
const failures = new Map();
const notes = [];   // 破れではないが報告すべき観察
let totalChecks = 0, totalCases = 0;
const caseCounts = {};
function addCases(suite, n) { caseCounts[suite] = (caseCounts[suite] || 0) + n; totalCases += n; }
function show(v) {
  try {
    return JSON.stringify(v, (k, x) => x === undefined ? '«undefined»' :
      (typeof x === 'string' && x.length > 160 ? x.slice(0, 80) + `…(len ${x.length})` : x));
  } catch (e) { return '<unserializable: ' + e.message + '>'; }
}
function fail(suite, inv, msg, repro) {
  const sig = suite + '|' + inv + '|' + msg;
  if (!failures.has(sig)) failures.set(sig, { suite, inv, msg, repro: show(repro), count: 0 });
  failures.get(sig).count++;
}
function check(cond, suite, inv, msg, repro) { totalChecks++; if (!cond) fail(suite, inv, msg, repro); }
function note(tag, msg) { notes.push({ tag, msg }); }

// ── オラクル用正規化（aggregate.js と同じ基準）───────────────
// 全テーブルを null-prototype 化: '__proto__'/'constructor'等の status/conf 文字列が
// Object.prototype 経由で truthy を返してオラクル自体が誤判定するのを防ぐ（本体の同型バグは Suite P で検査）。
const NP = o => Object.assign(Object.create(null), o);
const SEV = NP({ pass: 0, na: 0, warn: 1, fail: 2 });
const norm = s => String(s == null ? '' : s).trim().toLowerCase();
const sevOf = s => SEV[norm(s)] != null ? SEV[norm(s)] : 1;
const KNOWN_ST = NP({ pass: 1, fail: 1, warn: 1, na: 1 });
const CONF_STRICT = NP({ low: 1, mid: 1, medium: 1, high: 1, '低': 1, '低い': 1, '中': 1, '高': 1, '高い': 1 }); // vote.js CONF_RANK 定義域(B-2修正後)
const CONF_AGG = NP({ low: 'low', '低': 'low', '低い': 'low', mid: 'mid', medium: 'mid', '中': 'mid', high: 'high', '高': 'high', '高い': 'high' });

// ── 値プール ─────────────────────────────────────────────────
const HUGE = 'あ🔥x'.repeat(700); // ~2100 chars
const WEIRD = [null, undefined, 0, 1, -1, 3.14, true, false, '', ' ', '🔥🚗', 'ｆａｉｌ', '全角テキスト', { a: 1 }, {}, ['pass'], [], HUGE, '２５００', 1e308, NaN];
const STATUS_POOL = ['pass', 'fail', 'warn', 'na', 'pass', 'fail', 'warn', 'na', 'pass', 'fail',
  'PASS', 'Fail', 'WARN', 'NA', ' fail', 'na ', ' pass ', 'fail\n', ' FAIL ', 'ok', 'unknown', '合格', '不合格'].concat(WEIRD);
const CONF_POOL = ['low', 'mid', 'high', 'medium', 'low', 'high', 'LOW', ' low ', '低', '中', '高', '低い', null, undefined, 3, ['low'], '', 'なし'];
const TEXT_POOL = ['', '', '根拠テキストあり', '幅2500mm', null, undefined, 0, {}, ['a'], HUGE, '🔥全角　テキスト', ' '];

function randRow(idPool) {
  const row = { id: pick(idPool), status: pick(STATUS_POOL) };
  if (chance(0.8)) row.confidence = pick(CONF_POOL);
  if (chance(0.9)) row.found_text = pick(TEXT_POOL);
  if (chance(0.9)) row.detail = pick(TEXT_POOL);
  if (chance(0.05)) row._deterministic = pick(['space_width_2500', 'zzz', true]);
  return row;
}

/* ════════════════════════════════════════════════════════════
   Suite A — vote.mergeRuns（多数決の安全性・注入禁止・クラッシュ耐性）
   ════════════════════════════════════════════════════════════ */
function suiteA(N) {
  const S = 'A:vote';
  addCases(S, N);
  for (let c = 0; c < N; c++) {
    rnd = mulberry32(SEED + 1000000 + c);
    const nRuns = int(2, 5);
    const ids = ['a', 'b', 'c', 'd', '__proto__'].slice(0, int(2, 5));
    const keys = chance(0.7) ? ['nev_results'] : (chance(0.5) ? ['results'] : ['nev_results', 'manual_results']);
    const runs = [];
    for (let r = 0; r < nRuns; r++) {
      const run = { detected_info: {}, overall_comment: 'c' + r };
      keys.forEach(key => {
        if (chance(0.06)) { run[key] = pick([null, undefined, 'notarray', 5]); return; }
        const arr = [];
        ids.forEach(id => {
          if (chance(0.82)) arr.push(randRow([id]));
          if (chance(0.15)) arr.push(randRow([id]));
        });
        if (chance(0.1)) arr.push({ id: null, status: 'fail' });
        if (chance(0.1)) arr.push(pick([null, 5, 'junk']));
        run[key] = arr;
      });
      runs.push(chance(0.03) ? null : run);
    }
    let merged;
    try { merged = Vote.mergeRuns(runs); }
    catch (e) { fail(S, 'inv9:クラッシュ耐性', 'mergeRuns threw: ' + e.message, { case: c, runs }); continue; }
    if (!merged) continue;
    const liveRuns = runs.filter(Boolean);
    if (liveRuns.length < 2) continue;

    keys.forEach(key => {
      const outArr = merged[key];
      // id には '__proto__' を含むため null-prototype 必須（{} だと obj[k]=obj[k]||{...} が
      // Object.prototype を掴んで .statuses が undefined → 前回セッションのクラッシュ原因）
      const inRows = Object.create(null);
      liveRuns.forEach((run, ri) => {
        const arr = Array.isArray(run[key]) ? run[key] : [];
        arr.forEach(row => {
          if (!row || row.id == null) return;
          const k = String(row.id);
          (inRows[k] = inRows[k] || { statuses: [], confs: [], runsSeen: {}, dup: false }).statuses.push(row.status);
          inRows[k].confs.push(row.confidence);
          if (inRows[k].runsSeen[ri]) inRows[k].dup = true;
          inRows[k].runsSeen[ri] = (inRows[k].runsSeen[ri] || 0) + 1;
        });
      });
      const anyArray = liveRuns.some(r => Array.isArray(r[key]));
      if (!anyArray) { check(outArr == null, S, 'inv2', '入力に配列が無いのに出力キーが出現', { case: c, key }); return; }
      check(Array.isArray(outArr), S, 'inv9:出力型', '出力キーが配列でない', { case: c, key, outArr });
      if (!Array.isArray(outArr)) return;
      const outById = Object.create(null); outArr.forEach(o => { outById[String(o.id)] = o; }); // 同上: '__proto__' id 行を own key として保持
      Object.keys(outById).forEach(k => check(inRows[k] != null, S, 'inv2:注入禁止', `入力に無いid「${k}」が出力に出現`, { case: c, key, out: outById[k] }));
      Object.keys(inRows).forEach(k => {
        const inn = inRows[k], out = outById[k];
        check(out != null, S, 'inv2:id欠落', `入力にあるid「${k}」が出力から消失`, { case: c, key, in: inn.statuses });
        if (!out) return;
        const anyFail = inn.statuses.some(s => norm(s) === 'fail');
        if (anyFail) {
          const o = norm(out.status);
          check(o === 'fail' || o === 'warn', S, 'inv1:fail票保全',
            `runにfailがあるのに出力status=「${String(out.status)}」`, { case: c, key, id: k, inputStatuses: inn.statuses, out });
        }
        const fullNoDup = !inn.dup && Object.keys(inn.runsSeen).length === liveRuns.length;
        if (fullNoDup) {
          const allExactPass = inn.statuses.every(s => s === 'pass');
          if (allExactPass) {
            check(norm(out.status) === 'pass', S, 'inv1:全会一致pass維持', `全run'pass'なのに出力=「${String(out.status)}」`, { case: c, key, id: k, out });
            const anyLow = inn.confs.some(cf => CONF_AGG[norm(cf)] === 'low');
            if (anyLow) check(out.confidence != null && CONF_AGG[norm(out.confidence)] === 'low', S, 'inv1:low伝播(表記ゆれ込み)',
              `全run pass + low系confを含むのに出力confidence=「${String(out.confidence)}」`, { case: c, key, id: k, confs: inn.confs, out });
          }
          const anyValidConf = inn.confs.some(cf => CONF_STRICT[norm(cf)]);
          if (anyValidConf) check(out.confidence != null, S, 'inv1:confidence保持', 'confidenceが出力で消失', { case: c, key, id: k, confs: inn.confs, out });
        }
      });
    });
  }
}

/* ════════════════════════════════════════════════════════════
   Suite B — deterministic.run/apply（単調性・注入禁止・クラッシュ耐性）
   ════════════════════════════════════════════════════════════ */
const TRUST_LOOSEN = NP({ space_width_2500: 1, demand_rated_count: 1 });
const DI_POOLS = {
  charging_space_widths_mm: [[2500, 2500], [2400], [2500, 0], [], [null], ['2,500mm', '2400'], '2500 2400', '幅2,500mm', {}, [{}], HUGE, '２５００', -1, [1e308], [2500, 2500, 2500]],
  charging_count: [1, 2, 3, 8, '4台', 0, -2, '', null, {}, [2], 'abc', 1e9],
  main_breaker_at: [40, 75, 100, 125, 250, 30, 300, '100AT', 0, -50, '', null, {}, NaN, '１００'],
  charger_count: [1, 2, 4, 8, '8台', '', null, 0, [8]],
  simultaneous_count: [1, 2, 3, '', null, 0, '2台', {}],
  branch_breaker_ats: [[20, 20], [200], [], [null], '20/20/30', [{}], '20AT 30AT', 5, HUGE],
  main_breaker_af: [100, 150, 50, '', null, '100AF', 0, {}],
  cable_conduit_pairs: [[['CVT8sq-3C', 'PFD-28']], [['CVT22sq', 'PFD-36']], [null], [undefined], [['CVT8sq-3C']], [{ cable: 'CVT38sq', conduit: 'PFD-36' }], [{ cable: null, conduit: null }], [5, 'x'], 'notarray', [], [['CVT100sq', 'PFD-54'], null], [['CVT8sq-2C', 'PFD-26']], [['CVT8sq-3C', 'PFD-38']]],
  wire_table_totals: [[{ type: 'CVT8sq-3C', total_length_m: 13 }], [{ type: 'CVT8sq-3C', total_length_m: 150 }], [null], [{ type: {}, total_length_m: '13m' }], [], 'x', [{ type: 'A', length_m: 5 }], [{ type: 'A+B', total_length_m: 10 }], [{ type: 'CVT8sq-3C', total_length_m: 0 }]],
  wire_annotation_sums: [[{ type: 'CVT8sq-3C', total_length_m: 13 }], [{ type: 'CVT8sq-3C', total_length_m: 15 }], [null], [], [{ type: 'B', total_length_m: 0 }]],
  wire_drawn_lengths: [[{ type: 'CVT8sq-3C', total_length_m: 13 }], [], [null], [{ type: 'CVT8sq-3C', total_length_m: '１３' }]],
  wire_annotations: [[{ cable: 'CVT8sq-3C', conduit: 'PFD-28', length_m: 13, note: '' }], [{ cable: 'CVT8sq-3C', length_m: 5 }, { cable: 'CVT8sq-3C', length_m: 8 }],
    [{ cable: 'CV38sq-2C+IV8sq', length_m: 10 }], [{ conduit: 'PFD-28', length_m: 10, note: '共入れ2' }, { cable: 'X', conduit: 'PFD-28', length_m: 10, note: '共入れ' }],
    [null, 5, 'x'], 'notarray', [], [{ type: 'CVT8sq-3C', length_m: 7 }], [{ cable: 'CVT8sq-3C', length_m: '13m' }]],
};
function randDetectedInfo(rule, extraKeys) {
  const di = {};
  const fields = Object.keys(Det.requiredFields(rule)).concat(extraKeys || []);
  fields.forEach(f => { if (chance(0.85)) di[f] = pick(DI_POOLS[f] || WEIRD); });
  if (chance(0.15)) di['junk_field'] = pick(WEIRD);
  if (chance(0.3)) di._disputedFields = pick([fields.slice(0, 1), fields, [], ['nothing'], 'main_breaker_at', 5, null, {}]);
  return di;
}
function suiteB(N) {
  const S = 'B:deterministic';
  addCases(S, N);
  const types = Object.keys(RULES);
  for (let c = 0; c < N; c++) {
    rnd = mulberry32(SEED + 2000000 + c);
    const type = types[c % types.length];
    const rule = RULES[type];
    const di = randDetectedInfo(rule, type === 'haisen' ? ['wire_annotations'] : []);
    const idPool = rule.checks.map(x => x.id).concat(['ghost_1', '__proto__']);
    const raw = [];
    idPool.forEach(id => { if (chance(0.6)) raw.push(randRow([id])); if (chance(0.05)) raw.push(randRow([id])); });
    if (chance(0.1)) raw.push(pick([null, 7, { status: 'fail' }]));
    // 注意: 本番（verdict.js L32）と同じ素の {} を使う。'__proto__' id 行は own key にならず
    // プロトタイプ差し替えになるが、これが本番到達可能な状態（own key 化は本番で発生し得ない）。
    const rawById = {}; raw.forEach(r => { if (r && r.id != null) rawById[r.id] = r; });
    let overrides, applied;
    try { overrides = Det.run(rule, di, rawById); }
    catch (e) { fail(S, 'inv9:run例外', `[${type}] det.run threw: ${e.message}`, { case: c, type, di }); continue; }
    try { applied = Det.apply(raw, overrides); }
    catch (e) { fail(S, 'inv9:apply例外', `[${type}] det.apply threw: ${e.message}`, { case: c, type, di, overrides }); continue; }
    check(applied.length === raw.length, S, 'inv2:行数', `[${type}] apply前後で行数が変化`, { case: c, type, before: raw.length, after: applied.length });
    for (let i = 0; i < Math.min(raw.length, applied.length); i++) {
      const b = raw[i], a = applied[i];
      const bid = b && b.id != null ? String(b.id) : null;
      const aid = a && a.id != null ? String(a.id) : null;
      check(bid === aid, S, 'inv2:id注入/変化', `[${type}] index${i} id変化 ${bid}→${aid}`, { case: c, type, before: b, after: a });
      if (!b || !a) continue;
      const sb = sevOf(b.status), sa = sevOf(a.status);
      if (sa < sb) {
        check(a._deterministic && TRUST_LOOSEN[a._deterministic], S, 'inv1:単調性',
          `[${type}] id=${aid} が ${String(b.status)}→${String(a.status)} に緩和されたが _deterministic=${String(a._deterministic)}（trustLoosen外）`,
          { case: c, type, di, before: b, after: a });
      }
      // 追加不変則(今回指示): 同statusエコーは _deterministic スタンプが付かない。
      // 対偶で検査: _deterministic が新規付与された行は必ず status(正規化) が変化している。
      // （randRowが5%で偽の_deterministicを事前付与するため「新規付与」= before と異なる場合のみ）
      if (a._deterministic && a._deterministic !== b._deterministic) {
        // F-1/F-4修正後の仕様: trustLoosen宣言fnは同statusエコーでも権威スタンプを付与する
        // （コード検証済みの正当なpass/naが根拠ゲート/S2ゲートで覆されるのを防ぐ）。非trustLoosenは従来どおり非スタンプ。
        check(norm(a.status) !== norm(b.status) || TRUST_LOOSEN[a._deterministic], S, 'inv1:同statusエコー非スタンプ(非trustLoosen)',
          `[${type}] id=${aid} status「${String(b.status)}」のまま _deterministic=${String(a._deterministic)} が新規付与（エコーは_deterministicNoteであるべき）`,
          { case: c, type, di, before: b, after: a });
        check(Det.registry[a._deterministic] != null, S, 'inv1:スタンプfn実在',
          `[${type}] _deterministic=${String(a._deterministic)} がregistry外`, { case: c, after: a });
      }
      // note付与（noteOnly/エコー/緩め拒否のいずれか）は status を一切変えない
      if (a._deterministicNote && a._deterministicNote !== b._deterministicNote) {
        check(String(a.status) === String(b.status), S, 'inv1:note付与はstatus不変',
          `[${type}] note付与でstatus変化 ${String(b.status)}→${String(a.status)}`, { case: c, type, before: b, after: a });
      }
    }
  }
  // 静的: trustLoosen を持つ fn は宣言済みの2つのみ
  const loosenFns = Object.keys(Det.registry).filter(f => Det.registry[f].trustLoosen);
  check(loosenFns.sort().join(',') === 'demand_rated_count,space_width_2500', S, 'inv1:trustLoosen集合',
    `trustLoosen fn集合が想定外: ${loosenFns.join(',')}`, { loosenFns });
}

/* ════════════════════════════════════════════════════════════
   Suite C — aggregateResults（集計安全性・クラッシュ耐性・S2ゲート）
   ════════════════════════════════════════════════════════════ */
function suiteC(N) {
  const S = 'C:aggregate';
  addCases(S, N);
  const combos = [];
  Object.keys(RULES).forEach(t => ['kiso', 'mokutekichi'].forEach(bt => combos.push([t, bt])));
  for (let c = 0; c < N; c++) {
    rnd = mulberry32(SEED + 3000000 + c);
    const [type, bt] = combos[c % combos.length];
    const rule = RULES[type];
    const checks = NevRules.filterChecks(rule, bt);
    const groups = [...new Set(checks.map(x => x.group || 'nev'))];
    const g = pick(groups);
    const groupChecks = checks.filter(x => (x.group || 'nev') === g);
    const raw = [];
    groupChecks.forEach(ch => { if (chance(0.75)) raw.push(randRow([ch.id])); if (chance(0.05)) raw.push(randRow([ch.id])); });
    if (chance(0.15)) raw.push(randRow(['alien_id', '__proto__']));
    if (chance(0.1)) raw.push(pick([null, 3, 'junk']));
    if (chance(0.05)) { // 非配列 rawResults（B-3d回帰）
      let agg2;
      try { agg2 = Agg.aggregateResults(pick([null, 'bad', 5, {}]), groupChecks, {}); }
      catch (e) { fail(S, 'inv9:非配列raw例外', `[${type}/${bt}] threw: ${e.message}`, { case: c }); }
    }
    let agg;
    try { agg = Agg.aggregateResults(raw, groupChecks, { requiredFailForWarn: rule.settings.requiredFailForWarn }); }
    catch (e) { fail(S, 'inv9:例外', `[${type}/${bt}/${g}] threw: ${e.message}`, { case: c, type, bt, g, raw }); continue; }
    const items = agg.items;
    check(items.length === groupChecks.length, S, 'inv4:項目数', `[${type}/${bt}/${g}] items数 ≠ checks数`, { case: c, got: items.length, want: groupChecks.length });
    const reqFail = items.filter(i => i.required && i.status === 'fail').length;
    const reqWarn = items.filter(i => i.required && i.status === 'warn').length;
    const critFail = items.filter(i => i.critical && i.required && i.status === 'fail').length;
    if (reqFail > 0) check(agg.overall !== 'pass', S, 'inv4:必須fail≠pass', `[${type}/${bt}/${g}] 必須fail=${reqFail}件でoverall=pass`, { case: c, raw });
    if (critFail > 0) check(agg.overall === 'fail', S, 'inv4:critical必須fail=fail', `[${type}/${bt}/${g}] criticalFail=${critFail}件でoverall=${agg.overall}`, { case: c, raw });
    if (reqWarn > 0) check(agg.overall !== 'pass', S, 'inv4:必須warn≠pass', `[${type}/${bt}/${g}] 必須warn=${reqWarn}件でoverall=pass`, { case: c, raw });
    items.forEach(i => check(KNOWN_ST[i.status], S, 'inv4:status正規化', `未知status「${String(i.status)}」が集計を通過`, { case: c, item: { id: i.id, status: i.status } }));
    const rawLast = {}; raw.forEach(r => { if (r && r.id != null && String(r.id) !== '__proto__') rawLast[r.id] = r; });
    groupChecks.forEach(ch => {
      const r = rawLast[ch.id];
      if (!r || norm(r.status) !== 'na') return;
      if (ch.required && !ch.condition && !ch.naAllowed && !r._deterministic) {
        const it = items.find(i => i.id === ch.id);
        check(it && it.status === 'warn', S, 'inv4:S2 naゲート', `[${type}/${bt}] 常時必須「${ch.id}」のnaがwarn化されず status=${it && it.status}`, { case: c, row: r });
      }
    });
    // 旧基準デグレード不変則（承認済み例外②・2026-07-17）: manual群/src:社内基準の項目は出力でfailにならない
    items.forEach(i => {
      const ch = groupChecks.find(x => x.id === i.id) || {};
      const legacy = (ch.group === 'manual') || (ch.src === '社内基準');
      if (legacy) {
        // fail許容は未回答（AI応答欠落＝合成fail）のみ。実judgmentのfailは必ずwarn化される
        if (i.status === 'fail') {
          check(!rawLast[ch.id], S, 'inv-legacy:fail禁止', `[${type}/${bt}/${g}] 回答済みの旧基準項目「${i.id}」がfailで出力`, { case: c, item: { id: i.id, status: i.status } });
        }
        if (i.original_status === 'fail') {
          // 任意×旧基準は「任意項目・自動降格」が先に効く（どちらの注記でも warn＋監査可能なら不変則は満たす）
          const noted = /旧基準・自動格下げ/.test(String(i.detail)) || (!ch.required && /任意項目・自動降格/.test(String(i.detail)));
          check(i.status === 'warn' && noted, S, 'inv-legacy:格下げ注記', `[${type}] 格下げの注記/warn不整合 id=${i.id}`, { case: c, item: { id: i.id, status: i.status } });
        }
      } else {
        check(!i.legacy, S, 'inv-legacy:誤フラグ', `非旧基準「${i.id}」にlegacyフラグ`, { case: c });
      }
    });
    const expected = Agg.decideOverall({ requiredFail: agg.requiredFail, requiredWarn: agg.requiredWarn, criticalFail: agg.criticalFail, requiredFailForWarn: rule.settings.requiredFailForWarn });
    check(agg.overall === expected, S, 'inv4:decideOverall整合', `overall=${agg.overall} ≠ 再計算=${expected}`, { case: c, agg: { requiredFail: agg.requiredFail, requiredWarn: agg.requiredWarn, criticalFail: agg.criticalFail } });
  }
}

/* ════════════════════════════════════════════════════════════
   Suite D — verdict.computeGroupAggs ⇔ 独立再実装の等価性（inv5）
   ════════════════════════════════════════════════════════════ */
function refComputeGroupAggs(rule, result, businessType) {
  const checks = NevRules.filterChecks(rule, businessType);
  const seen = new Set(); const groups = [];
  for (const ch of checks) { const g = ch.group || 'nev'; if (!seen.has(g)) { seen.add(g); groups.push(g); } }
  const ordered = groups.slice().sort((a, b) => (a === 'nev' ? 0 : 1) - (b === 'nev' ? 0 : 1));
  const allRaw = [].concat(result.nev_results || [], result.manual_results || [], result.results || []);
  const rawById = {}; for (const r of allRaw) { if (r && r.id != null) rawById[r.id] = r; }
  const overrides = Det.run(rule, result.detected_info || {}, rawById);
  return ordered.map(g => {
    const groupChecks = checks.filter(ch => (ch.group || 'nev') === g);
    const ids = new Set(groupChecks.map(ch => ch.id));
    const gov = {}; for (const k of Object.keys(overrides)) { if (ids.has(k)) gov[k] = overrides[k]; }
    let raw = g === 'manual' ? (result.manual_results || []) : (result.nev_results || result.results || []);
    if (Object.keys(gov).length) raw = Det.apply(raw, gov);
    const agg = Agg.aggregateResults(raw, groupChecks, { requiredFailForWarn: rule.settings.requiredFailForWarn });
    return { group: g, agg, deterministicIds: Object.keys(gov) };
  });
}
function suiteD(N) {
  const S = 'D:verdict';
  addCases(S, N);
  const types = Object.keys(RULES);
  const bts = ['kiso', 'mokutekichi', undefined, 'weird'];
  for (let c = 0; c < N; c++) {
    rnd = mulberry32(SEED + 4000000 + c);
    const type = types[c % types.length];
    const bt = bts[c % bts.length];
    const rule = RULES[type];
    const idPool = rule.checks.map(x => x.id).concat(['alien']);
    const result = { detected_info: randDetectedInfo(rule), overall_comment: 'x' };
    ['nev_results', 'manual_results', 'results'].forEach(key => {
      if (!chance(0.75)) return;
      const arr = [];
      idPool.forEach(id => { if (chance(0.5)) arr.push(randRow([id])); });
      result[key] = chance(0.05) ? pick([null, 'bad']) : arr;
    });
    let got, ref, gotErr, refErr;
    try { got = Verdict.computeGroupAggs(rule, result, bt); } catch (e) { gotErr = e.message; }
    try { ref = refComputeGroupAggs(rule, result, bt); } catch (e) { refErr = e.message; }
    if (gotErr || refErr) {
      check(gotErr === refErr, S, 'inv5:例外の等価性', `verdict=「${gotErr}」/ ref=「${refErr}」`, { case: c, type, bt, result });
      if (gotErr) fail(S, 'inv9:例外', `[${type}/${bt}] computeGroupAggs threw: ${gotErr}`, { case: c, type, bt, result });
      continue;
    }
    const a = show(got), b = show(ref);
    check(a === b, S, 'inv5:等価性', `[${type}/${bt}] 出力JSON不一致`, { case: c, type, bt, got: a.slice(0, 400), ref: b.slice(0, 400) });
  }
}

/* ════════════════════════════════════════════════════════════
   Suite F — colorsanity（inv3: a〜e）
   ════════════════════════════════════════════════════════════ */
const COLOR3 = ['mc_color_coding', 'mc_burial_hatching', 'new_existing_distinction'];
const COLOR5 = COLOR3.concat(['mc_new_existing_prefix', 'mc_cable_protector']);
function refColors(v) {
  let arr;
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') arr = v.split(/[、,\/・\s]+/);
  else arr = [];
  const s = new Set();
  arr.forEach(c => { const t = String(c == null ? '' : c).trim(); if (t) s.add(t); });
  return Array.from(s);
}
const COLOR_POOL = [
  [], ['赤'], ['赤', '青'], ['赤', '赤'], ['赤', '青', '緑'], ['', ' '], ['赤', null], ['🔥'], ['赤', ['青']],
  '赤・青', '赤,青,緑', '赤', '', null, undefined, 5, 0, {}, { color: '赤' }, true, '🔥 青', HUGE, ['赤', 5, {}],
];
function suiteF(N) {
  const S = 'F:colorsanity';
  addCases(S, N);
  for (let c = 0; c < N; c++) {
    rnd = mulberry32(SEED + 5000000 + c);
    const hasField = chance(0.8);
    const di = chance(0.95) ? {} : pick([null, 'x', 5, undefined]);
    if (di && typeof di === 'object') {
      if (hasField) di.wire_color_distinction = pick(COLOR_POOL);
      if (chance(0.5)) di.color_legend_observed = pick(['赤=新設', '', null, 5, {}, HUGE]);
      if (chance(0.2)) di.junk = pick(WEIRD);
    }
    const idPool = COLOR5.concat(['total_length', 'alien', 'setting_place', '__proto__']);
    const result = chance(0.97) ? { detected_info: di } : pick([null, 5, 'x', {}]);
    let sharedRow = null;
    if (result && typeof result === 'object') {
      ['results', 'nev_results', 'manual_results'].forEach(key => {
        if (chance(0.2)) { if (chance(0.5)) result[key] = pick([null, 'bad', 5, {}]); return; }
        const arr = [];
        idPool.forEach(id => { if (chance(0.6)) arr.push(randRow([id])); });
        if (chance(0.1)) arr.push(pick([null, 5, 'junk']));
        if (chance(0.15)) { // 配列間で行オブジェクトを共有
          if (!sharedRow) sharedRow = { id: pick(COLOR5), status: 'fail', found_text: 'x', detail: 'd' };
          arr.push(sharedRow);
        }
        result[key] = arr;
      });
    }
    let snap;
    try { snap = structuredClone(result); } catch (e) { snap = JSON.parse(show(result)); }
    let out;
    try { out = ColorSanity.apply(result); }
    catch (e) { fail(S, 'inv3e:例外', 'colorsanity.apply threw: ' + e.message, { case: c, result: snap }); continue; }
    check(out && Array.isArray(out.downgrades) && typeof out.count === 'number', S, 'inv3e:戻り値形', '戻り値の形が不正', { case: c, out });
    if (!result || typeof result !== 'object') continue;
    // 修正: di 変数ではなく result に実際に付いた detected_info から導出する
    //（result が {} 等に差し替えられた3%枝で di が孤立し、オラクルが誤検知するのを防ぐ）
    const diObj = (result.detected_info && typeof result.detected_info === 'object') ? result.detected_info : null;
    const fieldPresent = !!(diObj && ('wire_color_distinction' in diObj));
    const colors = fieldPresent ? refColors(diObj.wire_color_distinction) : null;
    const allowedIds = fieldPresent ? (colors.length >= 2 ? COLOR5 : COLOR3) : [];
    let actualChanges = 0;
    ['results', 'nev_results', 'manual_results'].forEach(key => {
      const before = snap ? snap[key] : undefined;
      const after = result[key];
      if (!Array.isArray(after)) {
        check(show(before) === show(after), S, 'inv3a:非配列キー不変', `非配列の${key}が変更された`, { case: c, before, after });
        return;
      }
      check(Array.isArray(before) && before.length === after.length, S, 'inv2:行数不変', `${key}の行数が変化`, { case: c, before: before && before.length, after: after.length });
      for (let i = 0; i < after.length; i++) {
        const b = before[i], a = after[i];
        if (show(b) === show(a)) continue; // 不変
        actualChanges++;
        // 変化した行の検証
        check(fieldPresent, S, 'inv3a:観測なし不変', `wire_color_distinction不在なのに${key}[${i}]が変化`, { case: c, before: b, after: a });
        check(b && typeof b === 'object' && norm(b.status) === 'fail', S, 'inv3a:fail以外に介入',
          `変更前status=「${b && b.status}」（fail以外）の行が変更された`, { case: c, key, before: b, after: a });
        check(a.status === 'warn', S, 'inv3b:fail→warn以外の遷移', `変更後status=「${String(a.status)}」`, { case: c, key, before: b, after: a });
        check(allowedIds.indexOf(a.id) >= 0, S, 'inv3d:対象セット逸脱',
          `観測${colors ? colors.length : '?'}色なのに id=${String(a.id)} が降格（許容: ${allowedIds.join('/')}）`, { case: c, key, colors, before: b, after: a });
        check(a.original_status === b.status, S, 'inv3b:original_status保存', 'original_statusが元statusと不一致', { case: c, before: b, after: a });
        check(String(a.detail).indexOf('【自動降格 fail→warn】') === 0, S, 'inv3b:detail注記', 'detailに降格注記なし', { case: c, after: a });
        check(show(a.found_text) === show(b.found_text) && show(a.confidence) === show(b.confidence), S, 'inv3b:他フィールド不変',
          'found_text/confidenceが変化', { case: c, before: b, after: a });
      }
    });
    // detected_info は不変
    check(show(result.detected_info) === show(snap && snap.detected_info), S, 'inv3a:detected_info不変', 'detected_infoが変更された', { case: c });
    // observed の整合
    if (fieldPresent) {
      check(show(out.observed) === show(colors), S, 'inv3d:observed整合', `observed=${show(out.observed)} ≠ 再計算=${show(colors)}`, { case: c });
      const expReason = colors.length >= 2 ? 'contradiction' : 'unobserved';
      check(out.reason === expReason, S, 'inv3d:reason整合', `reason=${out.reason} ≠ ${expReason}`, { case: c, colors });
    } else {
      check(out.count === 0 && out.observed === null, S, 'inv3a:無介入時のログ', '観測なしなのにcount>0/observed非null', { case: c, out });
    }
    // ログと実変化の整合（共有行は複数配列で変化するが記録は1回 → count ≤ 実変化数）
    check(out.count === out.downgrades.length, S, 'inv3d:count整合', 'count ≠ downgrades.length', { case: c, out });
    check(out.count <= actualChanges || actualChanges === 0 && out.count === 0, S, 'inv3d:ログ≦実変化', `downgrades=${out.count} > 実変化=${actualChanges}`, { case: c, out });
    if (out.count === 0) check(actualChanges === 0, S, 'inv3d:無記録変化', `ログ0件なのに実変化${actualChanges}件`, { case: c });
  }
  // 3(c): _deterministic 付き行への介入プローブ
  {
    const row = { id: 'mc_color_coding', status: 'fail', found_text: '', detail: 'AI判定', _deterministic: 'space_width_2500' };
    const res = { detected_info: { wire_color_distinction: [] }, nev_results: [row] };
    const out = ColorSanity.apply(res);
    if (out.count === 1 && row.status === 'warn') {
      note('inv3c', 'colorsanity は _deterministic 付き行にもガードなしで介入する（fail→warn）。ただし実パイプライン順序は「vote→(2パス時)colorsanity→verdict内でdeterministic」であり、colorsanity時点の行に _deterministic は付き得ない（gemini.js FA-D がモデルecho を剥ぐ）。また色依存5項目と deterministic targets（mc_cable_conduit_match/total_length/length_breakdown/section_details 等）は非重複のため、現行ルール定義では実害なし。将来 color 系 id を deterministic targets に加える場合はガード要追加。');
    } else {
      note('inv3c', 'colorsanity は _deterministic 付き行に介入しない（ガードあり）');
    }
    // 色依存5項目 × deterministic targets の重複チェック（静的）
    const detTargets = new Set();
    Object.keys(RULES).forEach(t => (RULES[t].deterministic || []).forEach(d => (d.targets || []).forEach(id => detTargets.add(id))));
    const overlap = COLOR5.filter(id => detTargets.has(id));
    check(overlap.length === 0, 'F:colorsanity', 'inv3c:対象重複', `色依存項目とdeterministic targetsが重複: ${overlap.join(',')}`, { overlap });
  }
}

/* ════════════════════════════════════════════════════════════
   Suite G — 辞書補正（editDistance1）の安全性（inv6）
   ════════════════════════════════════════════════════════════ */
function levRef(a, b) { // 参照実装（フルDP）
  const m = a.length, n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) { dp.push([i]); }
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[m][n];
}
const G_REPORT = { ed1Pairs: [], keyLev2: [], ambiguous: [], misRescue: [], rates: {} };
const NORM_DET = s => String(s == null ? '' : s).replace(/\s+/g, '').replace(/[−–—]/g, '-').toUpperCase();
function suiteG() {
  const S = 'G:辞書補正';
  const spec = RULES.haisen.meta.spec.cableConduitMatch;
  const keys = Object.keys(spec).map(NORM_DET);
  const specNorm = {}; Object.keys(spec).forEach(k => { specNorm[NORM_DET(k)] = spec[k].map(NORM_DET); });
  const allConduits = [...new Set([].concat(...Object.values(specNorm)))];

  // (1) editDistance1 の正しさ（参照Levenshteinとの一致・20,000ペア）
  const CHARSET = [...new Set((keys.join('') + allConduits.join('')).split(''))].concat(['X', '7', '9', 'あ']);
  let edN = 20000;
  addCases(S + ':ed1検証', edN);
  rnd = mulberry32(SEED + 6000000);
  for (let c = 0; c < edN; c++) {
    const mk = () => {
      if (chance(0.4)) { // 実キー/実配管のミュータント
        let s = pick(keys.concat(allConduits)).split('');
        const edits = int(0, 2);
        for (let e = 0; e < edits; e++) {
          const op = int(0, 2), p = int(0, Math.max(0, s.length - 1));
          if (op === 0 && s.length) s[p] = pick(CHARSET);
          else if (op === 1) s.splice(p, 0, pick(CHARSET));
          else if (s.length) s.splice(p, 1);
        }
        return s.join('');
      }
      const len = int(0, 9); let s = '';
      for (let i = 0; i < len; i++) s += pick(CHARSET);
      return s;
    };
    const a = mk(), b = mk();
    const got = Util.editDistance1(a, b);
    const want = levRef(a, b);
    const wantClass = want === 0 ? 0 : want === 1 ? 1 : 2;
    check(got === wantClass, S, 'inv6:ed1参照一致', `editDistance1("${a}","${b}")=${got} ≠ Levenshtein=${want}(class ${wantClass})`, { a, b, got, want });
  }

  // (2) 実仕様表の総当たり: キー同士・配管同士の距離1ペアの列挙
  addCases(S + ':仕様表総当たり', 1);
  const pairsScan = (arr, label) => {
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const d = levRef(arr[i], arr[j]);
      if (d === 1) G_REPORT.ed1Pairs.push(`${label}: ${arr[i]} ⇔ ${arr[j]} (距離1 → 相互補正され得る)`);
      if (d === 2) G_REPORT.keyLev2.push(`${label}: ${arr[i]} ⇔ ${arr[j]} (距離2 → OCR1誤読で他方に補正され得る)`);
    }
  };
  pairsScan(keys, 'ケーブルキー');
  pairsScan(allConduits, '配管');
  // 配管が距離1で他配管に補正される直接リスク（クロス: 各cableのallowed外配管 → allowed内へ距離1か）
  keys.forEach(k => {
    const A = specNorm[k];
    allConduits.filter(d => !A.includes(d)).forEach(d => {
      const hit = A.find(c => Util.editDistance1(d, c) === 1);
      if (hit) G_REPORT.misRescue.push(`実在配管そのもの: cable=${k} の不適合配管 ${d} が ${hit} に補正され適合化（無変異で誤救済）`);
    });
  });

  // (3) 網羅ミューテーション: 不適合配管の1文字誤読が適合に化ける率
  addCases(S + ':1誤読網羅', 1);
  const mutants1 = s => {
    const out = new Set();
    for (let p = 0; p < s.length; p++) {
      CHARSET.forEach(ch => { if (ch !== s[p]) out.add(s.slice(0, p) + ch + s.slice(p + 1)); }); // 置換
      out.add(s.slice(0, p) + s.slice(p + 1)); // 削除
    }
    for (let p = 0; p <= s.length; p++) CHARSET.forEach(ch => out.add(s.slice(0, p) + ch + s.slice(p))); // 挿入
    out.delete(s);
    return [...out];
  };
  let mutTotal = 0, mutRescued = 0, mutExact = 0;
  const rescueExamples = [];
  keys.forEach(k => {
    const A = specNorm[k];
    allConduits.filter(d => !A.includes(d)).forEach(d => {
      mutants1(d).forEach(m => {
        mutTotal++;
        if (A.includes(m)) { mutExact++; if (rescueExamples.length < 8) rescueExamples.push(`cable=${k}: 不適合${d}の1誤読「${m}」=許容値そのもの`); return; }
        const hit = A.find(c => Util.editDistance1(m, c) === 1);
        if (hit) { mutRescued++; if (rescueExamples.length < 8) rescueExamples.push(`cable=${k}: 不適合${d}の1誤読「${m}」→ ${hit} に補正＝適合化`); }
      });
    });
  });
  G_REPORT.rates.mutation = { total: mutTotal, rescued: mutRescued, exact: mutExact, rate: mutTotal ? (100 * (mutRescued + mutExact) / mutTotal).toFixed(2) + '%' : 'n/a', examples: rescueExamples };

  // (4) ケーブル側: キーの1誤読ミュータントの曖昧補正（距離1で2キー以上に一致）と他キー誤補正
  keys.forEach(x => {
    mutants1(x).forEach(m => {
      if (keys.includes(m)) return;
      const hits = keys.filter(k2 => Util.editDistance1(m, k2) === 1);
      if (hits.length >= 2) G_REPORT.ambiguous.push(`「${m}」（${x}の1誤読）が ${hits.join(' と ')} の両方に距離1 → Object.keys順の先勝ちで ${hits[0]} に補正`);
    });
  });
  G_REPORT.ambiguous = [...new Set(G_REPORT.ambiguous)];

  // (5) 地上真実つきランダム型番ファジング: 「補正が不適合を適合に変える」発生率
  const N = 20000;
  addCases(S + ':ランダム型番', N);
  rnd = mulberry32(SEED + 6100000);
  const ctx = { rule: RULES.haisen };
  const classify = r => {
    if (r == null) return 'skipped';
    if (r.status === 'warn') return 'mismatch';
    if (r.unfired && r.detail && r.detail.indexOf('適合') >= 0) return 'match';
    if (r.unfired) return 'unfired';
    return 'other:' + show(r).slice(0, 60);
  };
  const noCorrection = (cable, conduit) => { // 補正なし参照（正規化のみ）
    const ck = NORM_DET(cable); const A = specNorm[ck];
    if (!A) return 'skipped';
    return A.includes(NORM_DET(conduit)) ? 'match' : 'mismatch';
  };
  const stats = { truthCompliant: { n: 0, finalMismatch: 0 }, truthNoncompliant: { n: 0, finalMatch: 0, byEdits: {} }, transitions: {}, matchDowngrade: 0 };
  const mut = (s, edits) => {
    let a = s.split('');
    for (let e = 0; e < edits; e++) {
      const op = int(0, 2), p = int(0, Math.max(0, a.length - 1));
      if (op === 0 && a.length) a[p] = pick(CHARSET);
      else if (op === 1) a.splice(p, 0, pick(CHARSET));
      else if (a.length) a.splice(p, 1);
    }
    return a.join('');
  };
  for (let c = 0; c < N; c++) {
    const trueKey = pick(keys);
    const A = specNorm[trueKey];
    const compliant = chance(0.5);
    const trueConduit = compliant ? pick(A) : pick(allConduits.filter(d => !A.includes(d)).concat(['PFD-99', 'VE-28']));
    const cEdits = pick([0, 0, 0, 1, 1, 2]);
    const dEdits = pick([0, 0, 1, 1, 2]);
    const obsCable = mut(trueKey, cEdits);
    const obsConduit = mut(trueConduit, dEdits);
    let r;
    try { r = Det.registry.cable_conduit_match({ cable_conduit_pairs: [[obsCable, obsConduit]] }, ctx); }
    catch (e) { fail(S, 'inv9:例外', 'cable_conduit_match threw: ' + e.message, { obsCable, obsConduit }); continue; }
    const withCorr = classify(r);
    const woCorr = noCorrection(obsCable, obsConduit);
    const tr = woCorr + '→' + withCorr;
    stats.transitions[tr] = (stats.transitions[tr] || 0) + 1;
    if (woCorr === 'match' && withCorr !== 'match') stats.matchDowngrade++;
    // 地上真実ベース（観測誤差を補正しきった理想は「真の適合性」）
    const truthMatch = A.includes(trueConduit);
    if (withCorr === 'match' || withCorr === 'mismatch') {
      if (truthMatch) { stats.truthCompliant.n++; if (withCorr === 'mismatch') stats.truthCompliant.finalMismatch++; }
      else {
        stats.truthNoncompliant.n++;
        if (withCorr === 'match') {
          stats.truthNoncompliant.finalMatch++;
          const kk = `c${cEdits}d${dEdits}`;
          stats.truthNoncompliant.byEdits[kk] = (stats.truthNoncompliant.byEdits[kk] || 0) + 1;
        }
      }
    }
    // 不変則: 補正は「補正なしのmatch」を壊さない
    check(!(woCorr === 'match' && withCorr === 'mismatch'), S, 'inv6:match保存', '補正が適合を不適合に変えた', { obsCable, obsConduit });
  }
  G_REPORT.rates.random = stats;
}

/* ════════════════════════════════════════════════════════════
   Suite H — main_at_per_count 全数検査 ＋ demand_rated_count 整合（inv7）
   ════════════════════════════════════════════════════════════ */
function suiteH() {
  const S = 'H:main_at_per_count';
  const DEMAND = Det.DEMAND_RATED_COUNT;
  const dKeys = Object.keys(DEMAND).map(Number).sort((a, b) => a - b);
  const minAtFor = eff => { for (const k of dKeys) if (DEMAND[k] >= eff) return k; return null; };
  const ratedFor = at => { let r = null; for (const k of dKeys) if (at >= k) r = DEMAND[k]; return r; };
  let n = 0, contradictions = 0;
  const curPool = [undefined, 'pass', 'fail', 'warn', 'na'];
  for (let at = 0; at <= 300; at++) {
    for (let count = 0; count <= 12; count++) {
      for (let simul = -1; simul <= 12; simul++) { // -1 = simul未指定
        n++;
        const di = { main_breaker_at: at, charger_count: count };
        if (simul >= 0) di.simultaneous_count = simul;
        const eff = count != null ? count : (simul >= 0 ? simul : null); // R7h(2026-07-13): 常に総台数基準。LBは容量の代替にならない
        let r;
        try { r = Det.registry.main_at_per_count(di, {}); }
        catch (e) { fail(S, 'inv9:例外', `main_at_per_count threw at=${at},count=${count},simul=${simul}: ${e.message}`, di); continue; }
        // 期待値オラクル（独立導出）
        const minKey = minAtFor(eff);
        let expect;
        if (minKey == null) expect = 'unfired';               // eff > 8（テーブル外）
        else if (at < minKey) expect = 'warn';
        else expect = 'unfired';                              // 充足＝参考注記のみ
        const got = r && r.status === 'warn' ? 'warn' : (r && r.unfired ? 'unfired' : 'other:' + show(r));
        check(got === expect, S, 'inv7:warn条件厳密一致',
          `at=${at},eff=${eff}(count=${count},simul=${simul === -1 ? 'なし' : simul}): got=${got} expect=${expect}（必要最小AT=${minKey}）`, { at, count, simul, r });
        // 戻りステータスは warn か unfired のみ（pass/na/fail を返さない）
        check(!r || r.unfired || r.status === 'warn', S, 'inv7:status限定', `想定外status=${r && r.status}`, { at, count, simul, r });
        // demand_rated_count との整合（デマンド「不要」なのにAT「不足」の矛盾がないこと）
        for (const cur of curPool) {
          let d;
          try { d = Det.registry.demand_rated_count(di, { currentStatus: cur }); }
          catch (e) { fail(S, 'inv9:demand例外', `demand threw at=${at},count=${count},simul=${simul},cur=${cur}: ${e.message}`, di); continue; }
          const rated = ratedFor(at);
          const lbInUse = simul >= 0 && count != null && simul !== count;
          // R7h: lbInUse時は容量充足でも緩め(na)を返さず unfired（記載チェックはAI/人手へ）
          if (lbInUse && rated != null && eff != null && eff <= rated && d && !d.unfired && norm(cur) === 'fail' && d.status === 'na') {
            fail(S, 'inv7:R7h-lb緩め禁止', `lbInUse(総${count}/同時${simul})で fail→na 緩めが発生`, { at, count, simul, cur, d });
          }
          const demandSaysNotNeeded = d && !d.unfired && rated != null && eff != null && eff <= rated;
          if (demandSaysNotNeeded && got === 'warn') {
            contradictions++;
            fail(S, 'inv7:demand/at_per矛盾', `at=${at},eff=${eff}: demand=不要 なのに at_per_count=不足warn`, { at, count, simul, cur, d, r });
          }
          // demand の緩め遷移は fail→na のみ（trustLoosen宣言済み）
          if (d && !d.unfired && d.status != null) {
            const curSev = cur == null ? null : sevOf(cur);
            if (curSev != null && sevOf(d.status) < curSev) {
              check(norm(cur) === 'fail' && d.status === 'na', S, 'inv7:demand緩め限定',
                `demandが ${cur}→${d.status} に緩和（fail→na以外）`, { at, count, simul, cur, d });
            }
            check(norm(d.status) !== 'fail' || norm(cur) === 'fail', S, 'inv7:demandはfailを作らない',
              `cur=${cur} なのに demand が fail を返した`, { at, count, simul, cur, d });
          }
        }
      }
    }
  }
  addCases(S, n);
  // 端数・文字列系の標的ケース
  const T = [
    [{ main_breaker_at: 39.9, charger_count: 1 }, 'warn'], [{ main_breaker_at: 40, charger_count: 1 }, 'unfired'],
    [{ main_breaker_at: 74.9, simultaneous_count: 2, charger_count: 8 }, 'warn'], [{ main_breaker_at: 75, simultaneous_count: 2, charger_count: 8 }, 'warn'], // R7h: 総8台基準で250AT必要
    [{ main_breaker_at: 249.9, charger_count: 8 }, 'warn'], [{ main_breaker_at: 250, charger_count: 8 }, 'unfired'],
    // 100AT の定格動作台数は3台（125ATで4台）→ 4台なら「125ATを下回る」warn が正
    //（前任の期待値 'unfired' は表の読み違い。網羅ループの独立オラクルと fn 出力が一致することを確認済み）
    [{ main_breaker_at: '100AT', charger_count: '4台' }, 'warn'], [{ main_breaker_at: '100AT', charger_count: '3台' }, 'unfired'], [{ main_breaker_at: '100AT', charger_count: '5台' }, 'warn'],
    [{ main_breaker_at: '１００', charger_count: 4 }, 'unfired-null'], // 全角→抽出不能→unfired(検算不能)
    [{ main_breaker_at: 100, charger_count: 9 }, 'unfired'], // テーブル外
    [{ main_breaker_at: 100 }, 'unfired-null'], // 台数なし
  ];
  addCases(S + ':標的', T.length);
  T.forEach(([di, exp]) => {
    let r; try { r = Det.registry.main_at_per_count(di, {}); } catch (e) { fail(S, 'inv9:標的例外', e.message, di); return; }
    const got = r && r.status === 'warn' ? 'warn' : (r && r.unfired ? 'unfired' : 'other');
    const expBase = exp.startsWith('unfired') ? 'unfired' : exp;
    check(got === expBase, S, 'inv7:標的', `${show(di)} → got=${got} expect=${expBase}`, { di, r });
  });
  // 負数の符号剥がし挙動の記録
  const neg = Det.registry.main_at_per_count({ main_breaker_at: 100, simultaneous_count: -3, charger_count: 8 }, {});
  note('inv7', `simultaneous_count=-3 は toNum の記号除去で 3 と解釈される（[^\\d.]除去で符号が消える）。結果=${neg && (neg.status || 'unfired')}。負数はモデル出力として非現実的だが、符号剥がしは仕様として記録。`);
}

/* ════════════════════════════════════════════════════════════
   Suite I — reconcile 境界・共入れ分解・コード集計優先（inv8）
   ════════════════════════════════════════════════════════════ */
function refReconcile(sources, absT, ratioT) { // 独立再実装
  const N = s => String(s == null ? '' : s).replace(/\s+/g, '').replace(/[×xＸ]/gi, 'x').replace(/[ー−–—]/g, '-').toUpperCase();
  const toM = v => { if (v == null) return null; const n = parseFloat(String(v).replace(/,/g, '').replace(/[^\d.]/g, '')); return isNaN(n) ? null : n; };
  const idx = {};
  ['table', 'annotation', 'drawn'].forEach(src => {
    const m = {};
    (Array.isArray(sources[src]) ? sources[src] : []).forEach(it => {
      if (!it) return;
      const v = toM(it.total_length_m != null ? it.total_length_m : it.length_m);
      if (v == null) return;
      const t = String(it.type == null ? '' : it.type);
      (t.indexOf('+') >= 0 ? t.split('+').map(x => x.trim()) : [t]).forEach(p => {
        const k = N(p); if (!k) return;
        m[k] = (m[k] || 0) + v;
      });
    });
    idx[src] = m;
  });
  const types = new Set([].concat(Object.keys(idx.table), Object.keys(idx.annotation), Object.keys(idx.drawn)));
  const disc = []; let checked = 0;
  types.forEach(t => {
    const vals = ['table', 'annotation', 'drawn'].map(s => idx[s][t] != null ? idx[s][t] : null).filter(v => v != null);
    if (vals.length < 2) { disc.push(t + ':single'); return; }
    checked++;
    const max = Math.max(...vals), min = Math.min(...vals);
    if ((max - min) >= absT || (min > 0 ? max / min : Infinity) >= ratioT) disc.push(t + ':diverge');
  });
  return { disc: disc.sort(), checked };
}
function suiteI(N) {
  const S = 'I:reconcile';
  addCases(S, N);
  const TYPE_POOL = ['CVT8sq-3C', 'cvt8SQ−3c', 'CVT 8sq×3C', 'A+B', 'A + B', 'A', 'B', 'PFD-28', '', null, 5, 'CVT22sq'];
  const LEN_POOL = [0, 5, 4.9, 13, 15, 18, '13m', '１３', null, 1e9, -5, 3.33, '2,500'];
  for (let c = 0; c < N; c++) {
    rnd = mulberry32(SEED + 7000000 + c);
    const mkArr = () => {
      if (chance(0.08)) return pick([null, 'x', 5, {}]);
      const arr = [];
      const n = int(0, 5);
      for (let i = 0; i < n; i++) {
        if (chance(0.08)) { arr.push(pick([null, 5, 'junk'])); continue; }
        const it = { type: pick(TYPE_POOL) };
        if (chance(0.85)) it.total_length_m = pick(LEN_POOL); else it.length_m = pick(LEN_POOL);
        arr.push(it);
      }
      return arr;
    };
    const sources = { table: mkArr(), annotation: mkArr(), drawn: mkArr() };
    let got;
    try { got = Reconcile.reconcile(sources); }
    catch (e) { fail(S, 'inv9:例外', 'reconcile threw: ' + e.message, { case: c, sources }); continue; }
    const ref = refReconcile(sources, 5, 1.5);
    const gotDisc = got.discrepancies.map(d => {
      const N2 = s => String(s == null ? '' : s).replace(/\s+/g, '').replace(/[×xＸ]/gi, 'x').replace(/[ー−–—]/g, '-').toUpperCase();
      return N2(d.type) + (d.note.indexOf('1系統') >= 0 ? ':single' : ':diverge');
    }).sort();
    check(show(gotDisc) === show(ref.disc), S, 'inv8:参照実装一致',
      `discrepancies不一致 got=${show(gotDisc)} ref=${show(ref.disc)}`, { case: c, sources, got: got.discrepancies });
    check(got.checkedTypes === ref.checked, S, 'inv8:checkedTypes一致', `checkedTypes ${got.checkedTypes} ≠ ${ref.checked}`, { case: c, sources });
    check(got.ok === (got.discrepancies.length === 0), S, 'inv8:okフラグ', 'okフラグ不整合', { case: c });
  }
  // ── 境界プローブ ──
  const B = [];
  const probe2 = (name, sources, expectDiscrepancy) => {
    const r = Reconcile.reconcile(sources);
    const has = r.discrepancies.length > 0;
    check(has === expectDiscrepancy, S, 'inv8:境界', `${name}: 乖離検出=${has} 期待=${expectDiscrepancy}`, { sources, r: r.discrepancies });
    B.push(`${name}: ${has ? '乖離' : 'OK'}`);
  };
  addCases(S + ':境界', 8);
  probe2('差ちょうど5m(10vs15)', { table: [{ type: 'A', total_length_m: 10 }], drawn: [{ type: 'A', total_length_m: 15 }] }, true);
  probe2('差4.9m・比1.49(10vs14.9)', { table: [{ type: 'A', total_length_m: 10 }], drawn: [{ type: 'A', total_length_m: 14.9 }] }, false);
  probe2('比ちょうど1.5(2vs3)', { table: [{ type: 'A', total_length_m: 2 }], drawn: [{ type: 'A', total_length_m: 3 }] }, true);
  probe2('比1.4999(1vs1.4999)', { table: [{ type: 'A', total_length_m: 1 }], drawn: [{ type: 'A', total_length_m: 1.4999 }] }, false);
  probe2('0vs3(比∞)', { table: [{ type: 'A', total_length_m: 0 }], drawn: [{ type: 'A', total_length_m: 3 }] }, true);
  probe2('共入れ分解(A+B 10m vs A10/B10)', { table: [{ type: 'A', total_length_m: 10 }, { type: 'B', total_length_m: 10 }], annotation: [{ type: 'A+B', total_length_m: 10 }] }, false);
  probe2('分割合算(5+8 vs 13)', { table: [{ type: 'A', total_length_m: 5 }, { type: 'A', total_length_m: 8 }], annotation: [{ type: 'A', total_length_m: 13 }] }, false);
  probe2('正規化(cvt 8sq−3c vs CVT8SQ-3C)', { table: [{ type: 'cvt 8sq−3c', total_length_m: 13 }], annotation: [{ type: 'CVT8SQ-3C', total_length_m: 13 }] }, false);
  // 0 vs 0 エッジ（両系統一致の0mが比∞で乖離扱いになるか）
  {
    const r = Reconcile.reconcile({ table: [{ type: 'A', total_length_m: 0 }], drawn: [{ type: 'A', total_length_m: 0 }] });
    if (r.discrepancies.length) note('inv8-edge', '両系統が 0m で完全一致しても ratio=Infinity 扱いで「乖離」warn になる（reconcile.js L74: min>0 でない場合 Infinity）。0m 記載が両系統で一致する実図面は稀だが、過剰warn側（安全側）のエッジとして記録。');
    else note('inv8-edge', '0m vs 0m は乖離扱いにならない');
  }
  // ── wire_reconcile: コード集計の優先・共入れ按分・種別限定 ──
  const W = (di, expStatus, name, mustInclude) => {
    let r;
    try { r = Det.registry.wire_reconcile(di, { rule: RULES.haisen }); }
    catch (e) { fail(S, 'inv9:wire_reconcile例外', name + ': ' + e.message, di); return; }
    const got = r == null ? 'null' : (r.unfired ? 'unfired' : r.status);
    check(got === expStatus, S, 'inv8:wire_reconcile', `${name}: got=${got} expect=${expStatus}`, { di, r });
    if (mustInclude && r && r.detail) check(r.detail.indexOf(mustInclude) >= 0, S, 'inv8:注記', `${name}: detailに「${mustInclude}」なし`, { r });
  };
  addCases(S + ':wire_reconcile', 8);
  // AI申告(99m)とコード集計(13m)が食い違う → コード集計優先で table=13 と一致 → pass
  W({ wire_annotations: [{ cable: 'CVT8sq-3C', length_m: 13 }], wire_annotation_sums: [{ type: 'CVT8sq-3C', total_length_m: 99 }],
      wire_table_totals: [{ type: 'CVT8sq-3C', total_length_m: 13 }] }, 'pass', 'コード集計がAI申告に優先(一致側)', 'コード集計');
  // コード集計(99m) vs table(13m) → AI申告が13で一致していてもコード集計で乖離検出 → warn
  W({ wire_annotations: [{ cable: 'CVT8sq-3C', length_m: 99 }], wire_annotation_sums: [{ type: 'CVT8sq-3C', total_length_m: 13 }],
      wire_table_totals: [{ type: 'CVT8sq-3C', total_length_m: 13 }] }, 'warn', 'コード集計がAI申告に優先(乖離側)', 'コード集計');
  // 旗上げ無し → AI申告が使われる
  W({ wire_annotation_sums: [{ type: 'CVT8sq-3C', total_length_m: 13 }], wire_table_totals: [{ type: 'CVT8sq-3C', total_length_m: 13 }] },
    'pass', '旗上げ無し時はAI申告合算を使用');
  // 共入れ2の按分: 同一配管2件×10m note共入れ2 → 10m。tableの配管行10m と一致
  W({ wire_annotations: [
      { cable: 'CV38sq-2C', conduit: 'PFD-28', length_m: 10, note: '共入れ2' }, { cable: 'IV8sq', conduit: 'PFD-28', length_m: 10, note: '共入れ2' }],
      wire_table_totals: [{ type: 'CV38sq-2C', total_length_m: 10 }, { type: 'IV8sq', total_length_m: 10 }, { type: 'PFD-28', total_length_m: 10 }] },
    'pass', '共入れ2の物理長按分');
  // 本数不明の共入れ → その配管は照合除外（ケーブルのみ照合でpass）
  W({ wire_annotations: [
      { cable: 'CV38sq-2C', conduit: 'PFD-28', length_m: 10, note: '共入れ' }, { cable: 'IV8sq', conduit: 'PFD-28', length_m: 10, note: '共入れ' }],
      wire_table_totals: [{ type: 'CV38sq-2C', total_length_m: 10 }, { type: 'IV8sq', total_length_m: 10 }, { type: 'PFD-28', total_length_m: 10 }] },
    'warn', '本数不明共入れは配管照合除外(配管行が1系統のみ記載扱い)'); // ← 期待の妥当性は実行結果で確認
  // 統括表に配管行が無い → 旗上げの配管は照合対象外（過剰warnなし）
  W({ wire_annotations: [{ cable: 'CVT8sq-3C', conduit: 'PFD-28', length_m: 13 }],
      wire_table_totals: [{ type: 'CVT8sq-3C', total_length_m: 13 }] }, 'pass', '統括表に配管行なし→配管は照合外');
  // 2系統未満 → unfired
  W({ wire_table_totals: [{ type: 'CVT8sq-3C', total_length_m: 13 }] }, 'unfired', '1系統のみ→三者照合不成立');
  // cable欄なし→type欄フォールバック
  W({ wire_annotations: [{ type: 'CVT8sq-3C', length_m: 13 }], wire_table_totals: [{ type: 'CVT8sq-3C', total_length_m: 13 }] },
    'pass', 'cable欄なし→type欄フォールバック');
  // 三者照合の5m境界（wire_reconcile経由）
  addCases(S + ':wire境界', 2);
  W({ wire_annotations: [{ cable: 'X', length_m: 18 }], wire_table_totals: [{ type: 'X', total_length_m: 13 }] }, 'warn', 'wire経由 差5m');
  W({ wire_annotations: [{ cable: 'X', length_m: 17.9 }], wire_table_totals: [{ type: 'X', total_length_m: 13 }] }, 'pass', 'wire経由 差4.9m比1.38');
}

/* ════════════════════════════════════════════════════════════
   Suite J — プロンプト整合（inv10）
   ════════════════════════════════════════════════════════════ */
function balanced(s) {
  let curly = 0, square = 0;
  for (const ch of s) {
    if (ch === '{') curly++; else if (ch === '}') curly--;
    else if (ch === '[') square++; else if (ch === ']') square--;
    if (curly < 0 || square < 0) return false;
  }
  return curly === 0 && square === 0;
}
function jsonBlocks(s) {
  const out = []; const re = /```json\s*\n([\s\S]*?)```/g; let m;
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}
function suiteJ() {
  const S = 'J:prompt';
  const types = Object.keys(RULES);
  const bts = ['kiso', 'mokutekichi', undefined];
  let n = 0;
  const jsonInvalid = [];
  types.forEach(type => bts.forEach(bt => {
    const rule = RULES[type];
    const checks = NevRules.filterChecks(rule, bt);
    const allIds = rule.checks.map(c => c.id);
    const included = new Set(checks.map(c => c.id));
    const excluded = allIds.filter(id => !included.has(id));
    // ── buildPrompt（1パス）──
    n++;
    let p1;
    try { p1 = Prompt.buildPrompt(rule, bt); }
    catch (e) { fail(S, 'inv9:buildPrompt例外', `[${type}/${bt}] ${e.message}`, {}); return; }
    checks.forEach(c => check(p1.indexOf(`- [${c.id}]`) >= 0, S, 'inv10a:id網羅(1パス)', `[${type}/${bt}] id「${c.id}」がbuildPromptに無い`, {}));
    excluded.forEach(id => check(p1.indexOf(`- [${id}]`) < 0, S, 'inv10a:除外id混入(1パス)', `[${type}/${bt}] 除外id「${id}」がチェックリストに混入`, {}));
    jsonBlocks(p1).forEach((b, i) => {
      check(balanced(b), S, 'inv10d:括弧バランス(1パス)', `[${type}/${bt}] ブロック${i}の括弧が不均衡`, { block: b.slice(0, 200) });
      try { JSON.parse(b.trim()); } catch (e) { jsonInvalid.push(`buildPrompt[${type}/${bt}]#${i}: ${e.message.slice(0, 80)}`); }
    });
    if (!rule.settings.twoPass && type !== 'haisen') { /* 2パスはhaisenのみだが全図面でビルド可能性を確認 */ }
    // ── buildPass1Prompt ──
    n++;
    let pp1;
    try { pp1 = Prompt.buildPass1Prompt(rule, bt); }
    catch (e) { fail(S, 'inv9:pass1例外', `[${type}/${bt}] ${e.message}`, {}); return; }
    check(!/^- \[/m.test(pp1), S, 'inv10c:Pass1にチェックリスト無し', `[${type}/${bt}] Pass1に「- [id]」行が存在`, {});
    check(pp1.indexOf('# チェック項目') < 0, S, 'inv10c:Pass1に判定セクション無し', `[${type}/${bt}] Pass1に判定セクション見出し`, {});
    check(pp1.indexOf('pass | fail | warn') < 0 && pp1.indexOf('"status"') < 0, S, 'inv10c:Pass1に判定スキーマ無し', `[${type}/${bt}] Pass1にstatus enum/フィールド`, {});
    check(pp1.indexOf('"detected_info"') >= 0, S, 'inv10c:Pass1は抽出専用スキーマ', `[${type}/${bt}] Pass1にdetected_infoスキーマが無い`, {});
    jsonBlocks(pp1).forEach((b, i) => {
      check(balanced(b), S, 'inv10d:括弧バランス(Pass1)', `[${type}/${bt}] Pass1ブロック${i}不均衡`, { block: b.slice(0, 200) });
      try { JSON.parse(b.trim()); } catch (e) { jsonInvalid.push(`pass1[${type}/${bt}]#${i}: ${e.message.slice(0, 80)}`); }
    });
    // Pass1フィールド網羅: requiredFields + extraDetectedInfo + pass1Extra + 共通6種
    const fields = Prompt.collectPass1Fields(rule);
    Object.keys(fields).forEach(f => check(pp1.indexOf(`"${f}"`) >= 0, S, 'inv10c:Pass1フィールド網羅', `[${type}/${bt}] Pass1にフィールド「${f}」なし`, {}));
    // ── buildPass2Prompt ──
    n++;
    const pass1Data = { facility_name: '施設A', _disputedFields: ['main_breaker_at'], _voteRuns: 3, wire_color_distinction: ['赤', '青'], junk: '値' };
    let pp2;
    try { pp2 = Prompt.buildPass2Prompt(rule, bt, pass1Data); }
    catch (e) { fail(S, 'inv9:pass2例外', `[${type}/${bt}] ${e.message}`, {}); return; }
    checks.forEach(c => check(pp2.indexOf(`- [${c.id}]`) >= 0, S, 'inv10a:id網羅(Pass2)', `[${type}/${bt}] id「${c.id}」がPass2に無い`, {}));
    excluded.forEach(id => check(pp2.indexOf(`- [${id}]`) < 0, S, 'inv10a:除外id混入(Pass2)', `[${type}/${bt}] 除外id「${id}」がPass2チェックリストに混入`, {}));
    const blocks2 = jsonBlocks(pp2);
    // 最後のブロック＝出力スキーマ。detected_info スキーマが無いこと
    const schema2 = blocks2[blocks2.length - 1] || '';
    check(schema2.indexOf('"detected_info"') < 0, S, 'inv10b:Pass2スキーマにdetected_info無し', `[${type}/${bt}] Pass2出力スキーマにdetected_info`, { schema: schema2.slice(0, 300) });
    check(pp2.indexOf('_disputedFields') < 0 && pp2.indexOf('_voteRuns') < 0, S, 'inv10b:内部キー非添付', `[${type}/${bt}] Pass2に_始まりキーが添付`, {});
    check(pp2.indexOf('facility_name') >= 0, S, 'inv10b:Pass1データ添付', `[${type}/${bt}] Pass2にPass1データが無い`, {});
    blocks2.forEach((b, i) => {
      check(balanced(b), S, 'inv10d:括弧バランス(Pass2)', `[${type}/${bt}] Pass2ブロック${i}不均衡`, { block: b.slice(0, 200) });
      if (i === blocks2.length - 1) { try { JSON.parse(b.trim()); } catch (e) { jsonInvalid.push(`pass2schema[${type}/${bt}]#${i}: ${e.message.slice(0, 80)}`); } }
    });
  }));
  addCases(S, n);
  // 変な pass1Data でのクラッシュ耐性
  let wn = 50;
  addCases(S + ':pass2堅牢性', wn);
  rnd = mulberry32(SEED + 8000000);
  for (let c = 0; c < wn; c++) {
    const type = pick(Object.keys(RULES));
    const pd = {};
    for (let i = 0; i < int(0, 6); i++) pd['k' + i] = pick(WEIRD);
    if (chance(0.3)) pd['_x'] = pick(WEIRD);
    try { Prompt.buildPass2Prompt(RULES[type], pick(['kiso', 'mokutekichi', undefined, 5]), chance(0.9) ? pd : pick([null, undefined, 5, 'x'])); }
    catch (e) { fail(S, 'inv9:pass2堅牢性', `buildPass2Prompt threw: ${e.message}`, { type, pd }); }
  }
  if (jsonInvalid.length) {
    note('inv10d-json', `スキーマ疑似JSONは括弧バランスは全て成立するが、厳密なJSONとしては ${jsonInvalid.length} ブロックがパース不能（説明文中の未エスケープ二重引用符が原因。例: ${jsonInvalid[0]}）。モデルへの出力例示としては動作実績あり＝実害未確認だが、構文上は不正であることを記録。`);
  } else {
    note('inv10d-json', '全スキーマブロックが厳密JSONとしてもパース可能');
  }
}

/* ════════════════════════════════════════════════════════════
   Suite K — 全モジュール クラッシュ耐性掃射 ＋ cost.js（inv9）
   ════════════════════════════════════════════════════════════ */
function suiteK(N) {
  const S = 'K:crash';
  addCases(S, N);
  const mkJunkDeep = () => {
    const depth = int(0, 3);
    let v = pick(WEIRD);
    for (let i = 0; i < depth; i++) v = chance(0.5) ? { x: v, y: pick(WEIRD) } : [v, pick(WEIRD)];
    return v;
  };
  for (let c = 0; c < N; c++) {
    rnd = mulberry32(SEED + 9000000 + c);
    const type = pick(Object.keys(RULES));
    const rule = RULES[type];
    const target = c % 8;
    try {
      if (target === 0) {
        const runs = []; const nr = int(0, 4);
        for (let i = 0; i < nr; i++) runs.push(chance(0.2) ? pick([null, 5, 'x']) : { detected_info: mkJunkDeep(), nev_results: mkJunkDeep(), results: mkJunkDeep(), manual_results: mkJunkDeep() });
        Vote.mergeRuns(runs);
      } else if (target === 1) {
        const di = {}; Object.keys(Det.requiredFields(rule)).forEach(f => { di[f] = mkJunkDeep(); });
        di.wire_annotations = mkJunkDeep(); di._disputedFields = mkJunkDeep();
        Det.run(rule, chance(0.9) ? di : pick([null, undefined, 5, 'x']), chance(0.8) ? {} : pick([null, undefined]));
      } else if (target === 2) {
        Det.apply(pick([[], null, 'x', 5, [null, { id: 'a', status: mkJunkDeep() }]]), pick([{}, { a: { fn: 'zzz', status: mkJunkDeep() } }, { a: { noteOnly: true, detail: 'd' } }]));
      } else if (target === 3) {
        Agg.aggregateResults(pick([[randRow(['a'])], null, 'x', [mkJunkDeep()]]), rule.checks.slice(0, int(1, 5)), pick([{}, null, undefined, { requiredFailForWarn: pick(WEIRD) }]));
      } else if (target === 4) {
        const result = { detected_info: { wire_color_distinction: mkJunkDeep() }, results: mkJunkDeep(), nev_results: mkJunkDeep(), manual_results: mkJunkDeep() };
        ColorSanity.apply(chance(0.9) ? result : pick([null, 5, 'x', undefined]));
        ColorSanity.distinctColors(mkJunkDeep());
      } else if (target === 5) {
        Reconcile.reconcile({ table: mkJunkDeep(), annotation: mkJunkDeep(), drawn: mkJunkDeep() });
      } else if (target === 6) {
        const result = { detected_info: mkJunkDeep() };
        ['nev_results', 'results', 'manual_results'].forEach(k => { if (chance(0.6)) result[k] = mkJunkDeep(); });
        Verdict.computeGroupAggs(rule, result, pick(['kiso', 'mokutekichi', undefined, 5, '🔥']));
      } else {
        const est = Cost.estimateCost(pick([null, undefined, {}, { promptTokenCount: pick(WEIRD), candidatesTokenCount: pick(WEIRD), thoughtsTokenCount: pick(WEIRD), totalTokenCount: pick(WEIRD) }]), pick(['gemini-2.5-pro', 'unknown-model', null, 5]), pick([150, 0, -1, 'x', null, NaN]));
        const store = { v: 0, get() { return this.v; }, set(x) { this.v = x; } };
        const t = new Cost.CapTracker({ capJpy: pick([1000, 0, -5, 'x', NaN]), warnRatio: pick([0.8, 'x', null, 2]), store });
        t.addCost(pick([est, null, { totalCostJpy: pick(WEIRD) }]));
        t.getState(); t.getMessage();
      }
    } catch (e) {
      fail(S, 'inv9:例外', `target=${target} threw: ${e.message}`, { case: c, target, type });
    }
  }
  // 内部到達不能だが export されている入口の縮退挙動（記録のみ）
  const smoke = [];
  [['reconcile(null)', () => Reconcile.reconcile(null)],
   ['buildPrompt(null)', () => Prompt.buildPrompt(null, 'kiso')],
   ['buildPass1Prompt(null)', () => Prompt.buildPass1Prompt(null, 'kiso')],
   ['mergeDetectedInfo([null])', () => Vote.mergeDetectedInfo([null])],
   ['aggregateResults(raw, null)', () => Agg.aggregateResults([], null)],
   ['computeGroupAggs(null,{},bt)', () => Verdict.computeGroupAggs(null, {}, 'kiso')],
  ].forEach(([name, fn]) => {
    try { fn(); smoke.push(name + ': OK'); } catch (e) { smoke.push(name + ': throw(' + e.message.slice(0, 60) + ')'); }
  });
  note('inv9-contract', '本番非到達のプログラマ契約違反入口（null rule等）: ' + smoke.join(' / '));
  // cost.js NaN 伝播プローブ（組織方針: 上限警告の信頼性）
  {
    const mem = { v: 0, get() { return this.v; }, set(x) { this.v = x; } };
    const t = new Cost.CapTracker({ capJpy: 1000, store: mem });
    t.addCost({ totalCostJpy: 900 });
    const before = t.getState().status; // warn (0.9)
    const bad = Cost.estimateCost({ promptTokenCount: 'abc' }, 'gemini-2.5-pro');
    t.addCost(bad);
    const after = t.getState();
    if (before === 'warn' && (after.status !== 'warn' && after.status !== 'over')) {
      note('cost-NaN', `estimateCost にトークン数が非数値の usage が渡ると totalCostJpy=NaN となり、addCost で月次累計が NaN 汚染 → getState().status が「${after.status}」に化けて上限警告が消える（メモリストア時）。localStorage ストアは読み出し時の parseFloat(...)||0 で 0 に自己修復するため、当月累計が黙って 0 リセットされる（警告遅発方向）。API の usageMetadata は通常数値のため発生確率は低いが、組織方針（上限警告・超過表示）の信頼性に関わるため防御推奨: estimateCost 冒頭で数値化（Number(...)||0）。`);
    } else {
      note('cost-NaN', `NaN usage 混入後も status=${after.status}（警告維持）`);
    }
  }
}

/* ════════════════════════════════════════════════════════════
   Suite P — proto系文字列（'__proto__'/'constructor'等）の正規化バイパス標的検査
   本体の plain-object 参照（aggregate.js KNOWN/CONF_MAP・deterministic.js SEVERITY・
   vote.js CONF_RANK/mode）が、Object.prototype 経由の truthy で素通りしないかを
   少数の決定的ケースで検査する（乱数プールに混ぜると報告が氾濫するため分離）。
   ════════════════════════════════════════════════════════════ */
function suiteP() {
  const S = 'P:proto文字列';
  const PROTO_STRS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
  addCases(S, PROTO_STRS.length * 3 + 2);
  // (1) aggregate: 必須項目の status がproto系文字列 → 未知statusとして warn に正規化されるべき
  PROTO_STRS.forEach(st => {
    const checks = [{ id: 'a', category: 'c', label: 'l', required: true }];
    const agg = Agg.aggregateResults([{ id: 'a', status: st, found_text: 'x', confidence: 'high' }], checks, {});
    const item = agg.items[0];
    check(typeof item.status === 'string' && KNOWN_ST[item.status], S, 'inv4:proto系status正規化',
      `status「${st}」が正規化(KNOWN)を素通り: item.status=${typeof item.status === 'string' ? item.status : '(' + typeof item.status + ')'}`,
      { st, itemStatus: String(item.status), overall: agg.overall });
    check(agg.overall !== 'pass', S, 'inv4:proto系status必須≠pass',
      `必須項目が確定不能status「${st}」なのに overall=pass（分母から静かに消える false-PASS 経路）`, { st, overall: agg.overall });
  });
  // (2) deterministic.apply: cur.status がproto系のとき、非trustLoosen fn の pass 上書き（緩め）が通るか
  PROTO_STRS.forEach(st => {
    const raw = [{ id: 'k', status: st, found_text: 'x' }];
    let a;
    try { a = Det.apply(raw, { k: { fn: 'branch_le_main', status: 'pass', detail: 'd' } })[0]; }
    catch (e) { fail(S, 'inv9:apply例外', `status=${st}: ${e.message}`, { st }); return; }
    const loosened = sevOf(a.status) < sevOf(st); // オラクル基準: 未知status=warn級(1) → pass(0)は緩め
    check(!(loosened && a._deterministic && !TRUST_LOOSEN[a._deterministic]), S, 'inv1:proto系statusの単調性',
      `cur.status「${st}」を非trustLoosen fnが「${String(a.status)}」へ緩め上書き（SEVERITY plain参照の素通り）`, { st, after: a });
  });
  // (3) vote: confidence にproto系文字列があると low の最悪値集約を遮蔽しないか
  PROTO_STRS.forEach(cf => {
    const runs = [
      { nev_results: [{ id: 'x', status: 'pass', confidence: cf, found_text: 'e' }] },
      { nev_results: [{ id: 'x', status: 'pass', confidence: 'low', found_text: 'e' }] },
    ];
    let out;
    try { out = Vote.mergeRuns(runs).nev_results[0]; }
    catch (e) { fail(S, 'inv9:vote例外', `conf=${cf}: ${e.message}`, { cf }); return; }
    check(CONF_AGG[norm(out.confidence)] === 'low', S, 'inv1:proto系confのlow遮蔽',
      `confidence=[${cf}, low] の最悪値集約が「${String(out.confidence)}」（low が伝播せず確信度ゲートが失効）`, { cf, out });
  });
  // (4) vote→aggregate E2E: 全run status='__proto__'（mode計数不能）でも overall≠pass に落ちるか
  {
    const runs = [
      { nev_results: [{ id: 'x', status: '__proto__', found_text: 'e' }] },
      { nev_results: [{ id: 'x', status: '__proto__', found_text: 'e' }] },
    ];
    const out = Vote.mergeRuns(runs).nev_results[0];
    const agg = Agg.aggregateResults([out], [{ id: 'x', category: 'c', label: 'l', required: true }], {});
    check(agg.overall !== 'pass', S, 'inv4:proto系status E2E',
      `全run status='__proto__' → vote=${String(out.status)} → overall=${agg.overall}`, { out, overall: agg.overall });
    note('proto-vote', `全run status='__proto__' の多数決: merged status=${String(out.status)}（modeの計数が壊れ不一致扱い→warnなら安全側）`);
  }
  // (5) reconcile: type='__proto__' は norm() の大文字化で '__PROTO__' になり素通り不能なことの確認
  {
    const r = Reconcile.reconcile({ table: [{ type: '__proto__', total_length_m: 10 }], drawn: [{ type: '__proto__', total_length_m: 10 }] });
    check(r.checkedTypes === 1 && r.discrepancies.length === 0, S, 'inv8:protoキー正常集計',
      `type='__proto__' の照合結果が異常: ${show({ checked: r.checkedTypes, disc: r.discrepancies })}`, { r });
  }
}

/* ════════════════════════════════════════════════════════════
   Suite R — 前回指摘（B-1〜B-5）の回帰確認プローブ
   ════════════════════════════════════════════════════════════ */
const probes = [];
function probe(name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = { verdict: 'THREW', detail: e.message }; }
  probes.push(Object.assign({ name }, r));
}
function suiteR() {
  addCases('R:回帰', 13);
  // 追加不変則(今回指示)の正方向プローブ: エコー→note化 / trustLoosen緩め / サブセット検算の緩め拒否
  probe('P1エコー: space_width warn×AI warn → _deterministicNote', () => {
    const raw = [{ id: 'space_width_check', status: 'warn', found_text: 'x', detail: 'AI' }];
    const ov = Det.run(RULES.heimen, { charging_space_widths_mm: [2400] }, { space_width_check: raw[0] });
    const a = Det.apply(raw, ov)[0];
    // F-1/F-4修正後: trustLoosen fnのエコーは権威スタンプ（_deterministic）が付く
    const ok = a.status === 'warn' && a._deterministic === 'space_width_2500' && !a._deterministicNote;
    return { verdict: ok ? 'OK(trustLoosenエコーは権威スタンプ)' : 'NG', detail: show(a) };
  });
  probe('P1緩め許可: space_width pass×AI fail → trustLoosenで緩和', () => {
    const raw = [{ id: 'space_width_check', status: 'fail', found_text: 'x', detail: 'AI' }];
    const ov = Det.run(RULES.heimen, { charging_space_widths_mm: [2500, 2500] }, { space_width_check: raw[0] });
    const a = Det.apply(raw, ov)[0];
    const ok = a.status === 'pass' && a._deterministic === 'space_width_2500';
    return { verdict: ok ? 'OK(trustLoosen fnのみ緩め可)' : 'NG', detail: show(a) };
  });
  probe('P1緩め禁止: wire_reconcile pass×AI fail → fail維持+参考注記', () => {
    const di = { wire_annotations: [], wire_table_totals: [{ type: 'CVT8sq-3C', total_length_m: 13 }], wire_annotation_sums: [{ type: 'CVT8sq-3C', total_length_m: 13 }] };
    const raw = [{ id: 'total_length', status: 'fail', found_text: 'x', detail: 'AI' }];
    const ov = Det.run(RULES.haisen, di, { total_length: raw[0] });
    const a = Det.apply(raw, ov)[0];
    const ok = a.status === 'fail' && !a._deterministic && a._deterministicNote === 'wire_reconcile' && String(a.detail).indexOf('判定には未使用') >= 0;
    return { verdict: ok ? 'OK(サブセット検算はfailを緩めない)' : 'NG', detail: show(a) };
  });
  probe('B-1 vote trim: [" fail","na","na"]', () => {
    const runs = [
      { nev_results: [{ id: 'x', status: ' fail', found_text: 'f' }] },
      { nev_results: [{ id: 'x', status: 'na', found_text: '' }] },
      { nev_results: [{ id: 'x', status: 'na', found_text: '' }] },
    ];
    const st = Vote.mergeRuns(runs).nev_results[0].status;
    return { verdict: st === 'na' ? 'NG(未修正: fail票がna化)' : 'OK(修正済)', detail: 'merged status=' + JSON.stringify(st) };
  });
  probe('B-1b e2e: mitori/kiso 全pass + parking_layout[" fail",na,na]', () => {
    const rule = RULES.mitori;
    const checks = NevRules.filterChecks(rule, 'kiso');
    const mkRun = plStatus => ({
      detected_info: {},
      nev_results: checks.map(c => c.id === 'parking_layout'
        ? { id: c.id, status: plStatus, found_text: plStatus === ' fail' ? '区画なし' : '', confidence: 'high' }
        : { id: c.id, status: 'pass', found_text: '根拠', confidence: 'high' }),
    });
    const merged = Vote.mergeRuns([mkRun(' fail'), mkRun('na'), mkRun('na')]);
    const overall = Verdict.computeGroupAggs(rule, merged, 'kiso')[0].agg.overall;
    return { verdict: overall === 'pass' ? 'NG(false-PASS残存)' : 'OK(overall=' + overall + ')', detail: 'overall=' + overall };
  });
  probe('B-2 conf「低」の多数決伝播', () => {
    const run = { nev_results: [{ id: 'x', status: 'pass', confidence: '低', found_text: '根拠' }] };
    const m = Vote.mergeRuns([run, JSON.parse(JSON.stringify(run))]);
    const aggMulti = Agg.aggregateResults(m.nev_results, [{ id: 'x', category: 'c', label: 'l', required: true }], {});
    return { verdict: aggMulti.items[0].status === 'warn' ? 'OK(修正済: low降格が効く)' : 'NG(未修正)', detail: `merged.confidence=${JSON.stringify(m.nev_results[0].confidence)}, 集計=${aggMulti.items[0].status}` };
  });
  probe('B-3a pairs=[null] クラッシュ', () => {
    Det.run(RULES.haisen, { cable_conduit_pairs: [['CVT8sq-3C', 'PFD-28'], null] }, {});
    return { verdict: 'OK(例外なし)', detail: '' };
  });
  probe('B-3b wire_*非配列 クラッシュ', () => {
    Det.run(RULES.haisen, { wire_table_totals: 'x', wire_annotation_sums: [{ type: 'A', total_length_m: 1 }], wire_drawn_lengths: [{ type: 'A', total_length_m: 1 }] }, {});
    return { verdict: 'OK(例外なし)', detail: '' };
  });
  probe('B-3c mergeRuns 非配列キー', () => {
    Vote.mergeRuns([{ results: [{ id: 'a', status: 'pass' }] }, { results: 'notarray' }]);
    return { verdict: 'OK(例外なし)', detail: '' };
  });
  probe('B-3d aggregate 非配列raw', () => {
    Agg.aggregateResults('bad', RULES.mitori.checks.slice(0, 3), {});
    return { verdict: 'OK(例外なし)', detail: '' };
  });
  probe('B-4 _disputedFields=5', () => {
    Det.run(RULES.keitou, { main_breaker_at: 100, charger_count: 4, _disputedFields: 5 }, {});
    return { verdict: 'OK(例外なし)', detail: '' };
  });
  probe('B-5 vote id="__proto__"', () => {
    const { merged } = Vote.mergeResultArray([[{ id: '__proto__', status: 'fail', found_text: 'f' }], [{ id: '__proto__', status: 'fail', found_text: 'f' }]]);
    const lost = !merged.some(r => String(r.id) === '__proto__');
    const polluted = Object.getOwnPropertyNames(Object.prototype).sort().join(',') !== PROTO_BEFORE;
    return { verdict: (lost || polluted) ? `NG(行消失=${lost}, 汚染=${polluted})` : 'OK(行保持・汚染なし)', detail: show(merged) };
  });
  probe('aggregate resultMap __proto__ 副作用', () => {
    const checks = [{ id: 'a', category: 'c', label: 'l', required: true }];
    const agg = Agg.aggregateResults([{ id: '__proto__', status: 'fail' }, { id: 'a', status: 'pass', found_text: 'x' }], checks, {});
    const ok = agg.items[0].id === 'a' && agg.items[0].status === 'pass' && agg.overall === 'pass';
    const polluted = Object.getOwnPropertyNames(Object.prototype).sort().join(',') !== PROTO_BEFORE;
    return { verdict: (ok && !polluted) ? 'OK(実害なし)' : `注意(items=${show(agg.items)}, 汚染=${polluted})`, detail: `resultMapは素の{}のため__proto__行はプロトタイプ差し替えになるが、既知check idと衝突せず実害未確認` };
  });
}

/* ════════════════════════════════════════════════════════════ */
// 実行: node final_fuzz.js [スイート文字列]  例: node final_fuzz.js A / node final_fuzz.js GH
// 引数なし = 全スイート。各ケースは mulberry32(SEED+スイート固有オフセット+ケース番号) で
// 個別にシードされるため、単独実行と全体実行で結果は完全一致する。
const SUITES = {
  A: ['vote', () => suiteA(4000)],
  B: ['deterministic', () => suiteB(4000)],
  C: ['aggregate', () => suiteC(4000)],
  D: ['verdict等価性', () => suiteD(2000)],
  F: ['colorsanity', () => suiteF(5000)],
  G: ['辞書補正', () => suiteG()],
  H: ['main_at_per_count', () => suiteH()],
  I: ['reconcile', () => suiteI(3000)],
  J: ['prompt', () => suiteJ()],
  K: ['crash/cost', () => suiteK(4000)],
  P: ['proto文字列', () => suiteP()],
  R: ['回帰', () => suiteR()],
};
const sel = String(process.argv[2] || 'ABCDFGHIJKPR').toUpperCase().split('').filter(s => SUITES[s]);
console.log('=== NeV final fuzz (seed=' + SEED + ', suites=' + sel.join('') + ') ===');
const t0 = Date.now();
sel.forEach(s => { SUITES[s][1](); console.log(`Suite ${s} (${SUITES[s][0]}) done`); });

// プロトタイプ汚染の最終確認
const PROTO_AFTER = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
check(PROTO_AFTER === PROTO_BEFORE, 'GLOBAL', 'prototype汚染', `Object.prototypeのプロパティ集合が変化: ${PROTO_AFTER}`, {});

console.log(`\n=== 集計 (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
console.log(`cases=${totalCases}, oracle checks=${totalChecks}, distinct failures=${failures.size}`);
console.log('ケース内訳: ' + Object.keys(caseCounts).map(k => `${k}=${caseCounts[k]}`).join(', '));
console.log('\n--- 不変則の破れ / 例外（シグネチャ別） ---');
if (!failures.size) console.log('（なし）');
for (const f of failures.values()) {
  console.log(`\n[${f.suite}] ${f.inv} ×${f.count}件\n  ${f.msg}\n  repro: ${f.repro.slice(0, 700)}`);
}
if (probes.length) {
  console.log('\n--- 回帰プローブ（前回指摘 B-1〜B-5 ＋ 追加不変則の正方向） ---');
  probes.forEach(p => console.log(`${p.verdict.startsWith('OK') ? 'OK ' : 'NG '} ${p.name} → ${p.verdict}${p.detail ? ' | ' + String(p.detail).slice(0, 200) : ''}`));
}
if (G_REPORT.rates.mutation) {
  console.log('\n--- Suite G: 辞書補正リスク面 ---');
  console.log('距離1ペア(実仕様表内): ' + (G_REPORT.ed1Pairs.length ? '\n  ' + G_REPORT.ed1Pairs.join('\n  ') : 'なし'));
  console.log('距離2ペア(1誤読で他方へ補正され得る): ' + (G_REPORT.keyLev2.length ? '\n  ' + G_REPORT.keyLev2.join('\n  ') : 'なし'));
  console.log('曖昧補正(2キー以上に距離1): ' + (G_REPORT.ambiguous.length ? '\n  ' + G_REPORT.ambiguous.slice(0, 10).join('\n  ') + (G_REPORT.ambiguous.length > 10 ? `\n  …他${G_REPORT.ambiguous.length - 10}件` : '') : 'なし'));
  console.log('実在不適合配管の無変異誤救済: ' + (G_REPORT.misRescue.length ? '\n  ' + G_REPORT.misRescue.join('\n  ') : 'なし'));
  const gm = G_REPORT.rates.mutation;
  console.log(`1誤読網羅: 不適合配管の全1編集ミュータント ${gm.total}件中、補正で適合化 ${gm.rescued}件 + 許容値に一致 ${gm.exact}件（計${gm.rate}）`);
  gm.examples.forEach(x => console.log('  例: ' + x));
  const gr = G_REPORT.rates.random;
  console.log(`ランダム型番(20000): 真に不適合な組 ${gr.truthNoncompliant.n}件中、最終判定=適合(誤救済) ${gr.truthNoncompliant.finalMatch}件 (${gr.truthNoncompliant.n ? (100 * gr.truthNoncompliant.finalMatch / gr.truthNoncompliant.n).toFixed(2) : 0}%) 編集内訳=${show(gr.truthNoncompliant.byEdits)}`);
  console.log(`  真に適合な組 ${gr.truthCompliant.n}件中、最終判定=不適合(false warn) ${gr.truthCompliant.finalMismatch}件 (${gr.truthCompliant.n ? (100 * gr.truthCompliant.finalMismatch / gr.truthCompliant.n).toFixed(2) : 0}%)`);
  console.log(`  補正によるmatch→mismatch降格: ${gr.matchDowngrade}件（0であるべき）`);
  console.log(`  遷移内訳(補正なし→補正あり): ${show(gr.transitions)}`);
}
if (notes.length) {
  console.log('\n--- 観察ノート ---');
  notes.forEach(nt => console.log(`[${nt.tag}] ${nt.msg}`));
}
process.exitCode = failures.size ? 1 : 0;
