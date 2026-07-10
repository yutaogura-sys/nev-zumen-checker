/* ============================================================
   core/verdict.js — 判定パイプラインの単一実装（3-A）
   「businessType でチェックを絞る → グループ分割 → 決定論上書き(run/apply) → 集計」
   の結線を1箇所に集約する。従来は app.js computeAggs / batch.js checkOne /
   tests/regression.js buildVerdict の3箇所に同一ロジックが重複しており、
   修正のたびに手動同期が必要（乖離＝判定差の温床）だった。
   ブラウザ / Node 両対応（DOM非依存）。
   ============================================================ */
(function (root) {
  'use strict';

  function deps() {
    const req = m => { try { return (typeof require !== 'undefined') ? require(m) : null; } catch (e) { return null; } };
    return {
      rules: root.NevRules || req('./rules-registry.js'),
      det: root.NevDeterministic || req('./deterministic.js'),
      agg: root.NevAggregate || req('./aggregate.js'),
    };
  }

  // rule + マージ済みGemini結果 + 事業区分 → [{ group, agg }]
  // （グループ順は nev → その他 で安定ソート。決定論上書きは集計前に適用）
  function computeGroupAggs(rule, result, businessType) {
    const d = deps();
    const checks = d.rules.filterChecks(rule, businessType);
    const groups = [];
    checks.forEach(c => { const g = c.group || 'nev'; if (!groups.includes(g)) groups.push(g); });
    groups.sort((a, b) => (a === 'nev' ? 0 : 1) - (b === 'nev' ? 0 : 1));
    const rawFor = g => g === 'manual' ? (result.manual_results || []) : (result.nev_results || result.results || []);

    const allRaw = [].concat(result.nev_results || [], result.manual_results || [], result.results || []);
    const rawById = {}; allRaw.forEach(r => { if (r && r.id != null) rawById[r.id] = r; });
    const overrides = d.det ? d.det.run(rule, result.detected_info || {}, rawById) : {};

    return groups.map(g => {
      const groupChecks = checks.filter(c => (c.group || 'nev') === g);
      const groupIds = new Set(groupChecks.map(c => c.id));
      const groupOv = {}; Object.keys(overrides).forEach(id => { if (groupIds.has(id)) groupOv[id] = overrides[id]; });
      let raw = rawFor(g);
      if (d.det && Object.keys(groupOv).length) raw = d.det.apply(raw, groupOv);
      const agg = d.agg.aggregateResults(raw, groupChecks, { requiredFailForWarn: rule.settings.requiredFailForWarn });
      return { group: g, agg, deterministicIds: Object.keys(groupOv) };
    });
  }

  const api = { computeGroupAggs };
  root.NevVerdict = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
