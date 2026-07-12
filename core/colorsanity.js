/* ============================================================
   core/colorsanity.js — 色観測サニティ（波③・旧 applyColorRelatedSanityCheck 系の復元）
   目的: 配線ルート図の色依存チェックで実際に問題化した「モノクロ誤認による false-FAIL」を防ぐ。
     Pass1（抽出専用パス）が「配線ルート線の色を観測できない／1色のみ」と報告した場合、
     モデルの色知覚自体が信頼できない（レンダリング・スキャン起因の可能性）ため、
     色依存項目の fail を warn（要目視）へ降格する。

   【P1安全網の単調性に対する位置づけ（絶対原則の明示的例外）】
     本モジュールは「fail → warn」の降格のみを行う。pass への変更・warn→pass の昇格は一切しない。
     これは組織承認済みの例外（旧ツール準拠の false-FAIL 防止）であり、
     人間の最終目視を要求する warn に落とすだけで、合格を機械が確定させることはない。

   発火条件（すべて満たす場合のみ介入）:
     - detected_info に wire_color_distinction が存在する（＝Pass1 の色観測が実施された。
       1パス実行・batch.js ではフィールド自体が無いため決して発火しない）
     - 観測できた配線ルート線の色（重複除去後）が 1 色以下（0=観測不能 / 1=色分け判別不能）
   対象項目（色依存）: mc_color_coding / mc_burial_hatching / new_existing_distinction
   ブラウザ / Node 両対応（DOM非依存）。
   ============================================================ */
(function (root) {
  'use strict';

  // 色依存項目（fail→warn 降格の対象）。
  // 観測不能時（モノクロ誤認防止）: 3項目。
  // 観測あり×fail の矛盾時（旧 applyColorRelatedSanityCheck 準拠）: 5項目
  //   —「Pass1が複数色を観測できているのに色分け系をfail」はPass2の見落とし/矛盾の可能性が高い。
  const COLOR_DEPENDENT_IDS = ['mc_color_coding', 'mc_burial_hatching', 'new_existing_distinction'];
  const CONTRADICTION_IDS = ['mc_color_coding', 'mc_burial_hatching', 'new_existing_distinction', 'mc_new_existing_prefix', 'mc_cable_protector'];

  const normSt = s => String(s == null ? '' : s).trim().toLowerCase();

  // wire_color_distinction（配列 or 文字列）から重複除去済みの色名リストを取り出す
  function distinctColors(v) {
    let arr;
    if (Array.isArray(v)) arr = v;
    else if (typeof v === 'string') arr = v.split(/[、,\/・\s]+/); // 防御: モデルが文字列で返した場合
    else arr = [];
    const set = new Set();
    arr.forEach(c => { const s = String(c == null ? '' : c).trim(); if (s) set.add(s); });
    return Array.from(set);
  }

  // メイン: マージ済み結果オブジェクトの results/nev_results/manual_results をミューテートし、
  // 降格ログ { downgrades: [{id, from}], count, observed } を返す。
  //   ・fail 以外（pass/warn/na）は一切変更しない（pass化の禁止・warn維持）
  //   ・観測OK（2色以上）なら無介入
  //   ・観測フィールドが無ければ無介入（1パス経路の完全不変）
  function apply(result) {
    const out = { downgrades: [], count: 0, observed: null };
    if (!result || typeof result !== 'object') return out;
    const di = result.detected_info;
    if (!di || typeof di !== 'object') return out;
    if (!('wire_color_distinction' in di)) return out; // 色観測が実施されていない（1パス経路）
    const colors = distinctColors(di.wire_color_distinction);
    out.observed = colors;
    const legend0 = String(di.color_legend_observed == null ? '' : di.color_legend_observed).trim();

    // 観測OK（2色以上）: 旧ツール準拠の「矛盾降格」— 色は観測できているのに色分け系がfail
    // ＝Pass2の見落とし/矛盾の可能性 → fail→warn（要目視）。pass/warn/naは不変。
    if (colors.length >= 2) {
      out.reason = 'contradiction';
      ['results', 'nev_results', 'manual_results'].forEach(key => {
        const arr = result[key];
        if (!Array.isArray(arr)) return;
        arr.forEach(r => {
          if (!r || CONTRADICTION_IDS.indexOf(r.id) < 0) return;
          if (r._deterministic) return; // コード検算で確定した行には介入しない（将来ガード）
          if (normSt(r.status) !== 'fail') return;
          r.original_status = r.status;
          r.status = 'warn';
          r.detail = `【自動降格 fail→warn】Pass1で複数色（${colors.join('・')}）を観測済みにもかかわらず不合格判定＝観測と判定の矛盾。見落とし/誤認の可能性があるため要目視。元の判定理由: ${r.detail || '（詳細なし）'}`;
          out.downgrades.push({ id: r.id, from: 'fail' });
        });
      });
      out.count = out.downgrades.length;
      return out;
    }

    out.reason = 'unobserved';
    const legend = legend0;
    const obsTxt = colors.length === 0
      ? `配線ルート線の色を観測できず（凡例: ${legend ? 'あり「' + legend + '」' : 'なし'}）`
      : `配線ルート線に「${colors[0]}」の1色のみ観測（凡例: ${legend ? 'あり「' + legend + '」' : 'なし'}）`;

    ['results', 'nev_results', 'manual_results'].forEach(key => {
      const arr = result[key];
      if (!Array.isArray(arr)) return;
      arr.forEach(r => {
        if (!r || COLOR_DEPENDENT_IDS.indexOf(r.id) < 0) return;
        if (r._deterministic) return; // コード検算で確定した行には介入しない（将来ガード）
        if (normSt(r.status) !== 'fail') return; // fail のみ降格（pass/warn/na は不変）
        r.original_status = r.status; // 監査用に元判定を保持
        r.status = 'warn';
        r.detail = `【自動降格 fail→warn】色観測不能のため要目視（モノクロ誤認防止）。Pass1観測: ${obsTxt}。元の判定理由: ${r.detail || '（詳細なし）'}`;
        out.downgrades.push({ id: r.id, from: 'fail' });
      });
    });
    out.count = out.downgrades.length;
    return out;
  }

  const api = { COLOR_DEPENDENT_IDS, distinctColors, apply };
  root.NevColorSanity = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
