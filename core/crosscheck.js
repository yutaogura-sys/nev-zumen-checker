/* ============================================================
   core/crosscheck.js — 案件まとめチェック（図面間の整合性検証）
   1案件の複数図面（見取図/平面図/配線ルート図/電気系統図）の detected_info を突き合わせ、
   施設名・作成者・充電台数が図面間で一致しているかを検証する。
   ・施設名（facility_name）: 図面間で異なるのは重大 → fail
   ・作成者（creator）: 異なる担当者もありうる → warn
   ・充電台数（charging_count）: 見取図スペース数と電気系統図の充電器数は一致が基本だが
     設計上差が出る余地もあるため不一致は → warn（要確認）
   ブラウザ / Node 両対応（DOM非依存）。
   ============================================================ */
(function (root) {
  'use strict';

  const TYPE_LABEL = { mitori: '設置場所見取図', heimen: '平面図', haisen: '配線ルート図', keitou: '電気系統図' };

  function normText(s) {
    if (s == null) return '';
    return String(s).replace(/[\s　]+/g, '').replace(/[（）()【】\[\]「」]/g, '').toLowerCase();
  }
  function toNum(v) {
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
    return isNaN(n) ? null : n;
  }
  const isBlank = v => v == null || String(v).trim() === '' || /^(不明|なし|未記載|-|―)$/.test(String(v).trim());

  // byType: { <type>: { detectedInfo|detected_info: {...} }, ... } 提供された図面のみ
  function collect(byType, field) {
    return Object.keys(byType).map(t => {
      const di = (byType[t] && (byType[t].detectedInfo || byType[t].detected_info)) || {};
      return { type: t, label: TYPE_LABEL[t] || t, raw: di[field] };
    });
  }

  function cmpText(byType, field, label, mismatchStatus) {
    const vals = collect(byType, field);
    const withVal = vals.filter(v => !isBlank(v.raw));
    if (withVal.length === 0) return { field, label, status: 'na', detail: 'どの図面にも記載なし', values: vals };
    const norms = [...new Set(withVal.map(v => normText(v.raw)))];
    const missing = vals.length - withVal.length;
    if (norms.length === 1) {
      return { field, label, status: missing ? 'warn' : 'pass', detail: missing ? `記載のある${withVal.length}図面は一致（${missing}図面は未記載）` : '全図面で一致', values: vals };
    }
    return { field, label, status: mismatchStatus, detail: '図面間で不一致（要確認）', values: vals };
  }

  function cmpCount(byType, field, label) {
    const vals = collect(byType, field).map(v => ({ ...v, num: toNum(v.raw) }));
    const withVal = vals.filter(v => v.num != null);
    if (withVal.length === 0) return { field, label, status: 'na', detail: 'どの図面にも台数記載なし', values: vals };
    const nums = [...new Set(withVal.map(v => v.num))];
    const missing = vals.length - withVal.length;
    if (nums.length === 1) {
      return { field, label, status: missing ? 'warn' : 'pass', detail: (missing ? `記載のある${withVal.length}図面は一致（${missing}図面未記載）` : '全図面で一致') + `（${nums[0]}）`, values: vals };
    }
    return { field, label, status: 'warn', detail: '図面間で台数が異なります（要確認）', values: vals };
  }

  // メイン: 提供された図面群の整合性チェック配列を返す
  function crossCheck(byType) {
    if (!byType || Object.keys(byType).length < 2) return [];
    return [
      cmpText(byType, 'facility_name', '設置場所／施設名の一致', 'fail'),
      cmpText(byType, 'creator', '作成者の一致', 'warn'),
      cmpCount(byType, 'charging_count', '充電台数／スペース数の一致'),
    ].filter(Boolean);
  }

  // 案件全体の整合性サマリ（最悪ステータス）
  function summarize(findings) {
    if (findings.some(f => f.status === 'fail')) return 'fail';
    if (findings.some(f => f.status === 'warn')) return 'warn';
    if (findings.some(f => f.status === 'pass')) return 'pass';
    return 'na';
  }

  const api = { TYPE_LABEL, crossCheck, summarize };
  root.NevCrossCheck = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
