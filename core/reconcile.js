/* ============================================================
   core/reconcile.js — 配線数値の三者照合（統括表 ⇔ 旗上げ合算 ⇔ 記載寸法）
   旧・配線ルート図ツールの detectDiscrepancies 相当。桁違い誤読（15m↔150m）や
   読み落としを、AIの自己申告に頼らずコードで検出する（性能向上の核）。
   3系統の集計値をケーブル/配管種別ごとに突き合わせ、乖離を warn として報告する。
   ブラウザ / Node 両対応（DOM非依存）。
   ============================================================ */
(function (root) {
  'use strict';

  function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '').replace(/[×xＸ]/gi, 'x').replace(/[ー−–—]/g, '-').toUpperCase();
  }
  function toM(v) {
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/,/g, '').replace(/[^\d.]/g, ''));
    return isNaN(n) ? null : n;
  }
  // [{type,total_length_m}] → { normType: {display, m} }
  // 共入れ表記（例: "CV38sq-2C+IV8sq" = 2本のケーブルを同一配管に共入れ）は各ケーブルに分解し、
  // 同じ距離をそれぞれに計上する（旧・配線ルート図ツールの [共入れ2] 分解と同じ意味論）。
  // 分解しないと、統括表（ケーブル別に記載）と旗上げ（共入れ表記）のキーが合わず、
  // 三者照合が「1系統にのみ記載」と誤検出する（実図面で確認済みの過剰warn）。
  // 同一種別が複数回現れた場合は加算する（分割記載の合算）。
  function indexBy(arr) {
    const out = {};
    const add = (rawType, m) => {
      const k = norm(rawType);
      if (!k) return;
      if (out[k]) out[k].m += m;
      else out[k] = { display: rawType, m };
    };
    (Array.isArray(arr) ? arr : []).forEach(it => {
      if (!it) return;
      const m = toM(it.total_length_m != null ? it.total_length_m : it.length_m);
      if (m == null) return;
      const t = String(it.type == null ? '' : it.type);
      if (t.indexOf('+') >= 0) {
        t.split('+').forEach(part => add(part.trim(), m));
      } else {
        add(t, m);
      }
    });
    return out;
  }

  // sources: { table:[...], annotation:[...], drawn:[...] }（いずれも [{type,total_length_m}]）
  // 戻り値: { discrepancies:[{type,values:{table,annotation,drawn},note}], checkedTypes, ok }
  function reconcile(sources, opts) {
    opts = opts || {};
    const absThreshold = typeof opts.absThresholdM === 'number' ? opts.absThresholdM : 5;   // m差
    const ratioThreshold = typeof opts.ratioThreshold === 'number' ? opts.ratioThreshold : 1.5;
    const idx = { table: indexBy(sources.table), annotation: indexBy(sources.annotation), drawn: indexBy(sources.drawn) };
    const types = new Set([].concat(Object.keys(idx.table), Object.keys(idx.annotation), Object.keys(idx.drawn)));
    const discrepancies = [];
    let checkedTypes = 0;

    types.forEach(t => {
      const vals = {
        table: idx.table[t] ? idx.table[t].m : null,
        annotation: idx.annotation[t] ? idx.annotation[t].m : null,
        drawn: idx.drawn[t] ? idx.drawn[t].m : null,
      };
      const present = Object.keys(vals).filter(k => vals[k] != null).map(k => vals[k]);
      const display = (idx.table[t] || idx.annotation[t] || idx.drawn[t]).display;
      if (present.length < 2) {
        // 1系統にしか出てこない = 他系統での読み落としの可能性
        discrepancies.push({ type: display, values: vals, note: '1系統にのみ記載（他系統で読み落としの可能性）' });
        return;
      }
      checkedTypes++;
      const max = Math.max(...present), min = Math.min(...present);
      const diff = max - min;
      const ratio = min > 0 ? max / min : Infinity;
      if (diff >= absThreshold || ratio >= ratioThreshold) {
        discrepancies.push({ type: display, values: vals, note: `系統間で値が乖離（差${Math.round(diff * 10) / 10}m）。桁違い誤読の可能性` });
      }
    });

    return { discrepancies, checkedTypes, ok: discrepancies.length === 0 };
  }

  const api = { reconcile };
  root.NevReconcile = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
