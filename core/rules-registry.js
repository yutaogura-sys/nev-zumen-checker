/* ============================================================
   core/rules-registry.js — 図面種別ごとの要件定義（rules/）の登録・取得
   各 rules/*.js は registerRule() で自分の定義を登録する。
   app.js / prompt.js はここから getRule(type) で取得する。
   これにより「どの図面にどの要件があるか」の参照点を1箇所に集約する。
   ============================================================ */
(function (root) {
  'use strict';

  const registry = {};

  // 図面種別の表示順・ラベル（4タブの並び）
  const DRAWING_TYPES = [
    { type: 'mitori', label: '設置場所見取図' },
    { type: 'heimen', label: '平面図' },
    { type: 'haisen', label: '配線ルート図' },
    { type: 'keitou', label: '電気系統図' },
  ];

  // rule スキーマ（P2で各図面が満たす形）:
  //   {
  //     meta:     { drawingName, sourceYear, sourceDoc, maxPages },
  //     settings: { requiredFailForWarn, renderScale, ... },
  //     categories: { <catId>: { title, icon, order } },
  //     checks:   [ { id, category, label, description, required, critical?, deterministic? } ],
  //     businessTypeBranch?: { keirō:[ids], mokutekichi:[ids], kiso:[ids] },
  //   }
  function registerRule(type, rule) {
    if (!type) throw new Error('registerRule: type は必須です');
    if (registry[type]) console.warn(`registerRule: 「${type}」は既に登録済み。上書きします。`);
    registry[type] = rule;
    return rule;
  }

  function getRule(type) {
    return registry[type] || null;
  }

  function listTypes() {
    return DRAWING_TYPES.filter(d => registry[d.type]);
  }

  // rule オブジェクトを直接受け取り、事業区分で有効なチェック項目を返す純粋関数。
  //   businessType: 'kiso' | 'mokutekichi'（未指定なら全項目）
  //   branch に列挙されない項目は「全区分共通」とみなし常に含める。
  function filterChecks(rule, businessType) {
    if (!rule) return [];
    const all = rule.checks || [];
    const branch = rule.businessTypeBranch;
    if (!branch || !businessType || !branch[businessType]) return all;
    const allowed = new Set(branch[businessType]);
    const branchedIds = new Set(Object.values(branch).flat());
    return all.filter(c => !branchedIds.has(c.id) || allowed.has(c.id));
  }

  // 種別キーで引いてから絞り込む版（既存API）。
  function resolveChecks(type, businessType) {
    return filterChecks(getRule(type), businessType);
  }

  root.NevRules = { DRAWING_TYPES, registerRule, getRule, listTypes, resolveChecks, filterChecks };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.NevRules;

})(typeof window !== 'undefined' ? window : globalThis);
