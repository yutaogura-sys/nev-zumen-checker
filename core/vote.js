/* ============================================================
   core/vote.js — 自己一致（多数決）マージ
   同一図面をN回判定した生結果（Geminiレスポンス）をマージする。
   ・各チェック項目: 全回一致ならその値。割れたら安全側の warn に落とし、割れを記録。
   ・detected_info: 数値は中央値、テキストは最頻値を採用。
   目的: 単発判定のブレを吸収し、判定の再現性・信頼性を上げる（性能向上）。
   ブラウザ / Node 両対応（DOM非依存）。
   ============================================================ */
(function (root) {
  'use strict';

  const RESULT_KEYS = ['results', 'nev_results', 'manual_results'];

  function mode(arr) { // 最頻値（同数なら先勝ち）
    const c = {}; let best = null, bestN = 0;
    arr.forEach(v => { const k = String(v); c[k] = (c[k] || 0) + 1; if (c[k] > bestN) { bestN = c[k]; best = v; } });
    return { value: best, count: bestN, unanimous: bestN === arr.length };
  }
  function median(nums) {
    const s = nums.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // ステータスの深刻度（安全網の単調性判定用）。pass/na=緩い側、fail=最も厳しい。
  const SEVERITY = { pass: 0, na: 0, warn: 1, fail: 2 };
  const normStatus = s => String(s == null ? '' : s).trim().toLowerCase();

  // 1つの結果配列（例 nev_results）を複数runにわたってマージ
  function mergeResultArray(runsArrays) {
    const total = (runsArrays || []).length; // 判定回数（モデル数）。突き合わせの母数
    // id -> [{status,found_text,detail} per run]
    // FA-C: 同一run内にidが重複出力されても母数検知が壊れないよう、run単位で一意化
    //（重複時はより深刻なstatusの行を採用＝安全側）。
    const byId = Object.create(null); // prototype汚染防止
    runsArrays.forEach(arr => {
      if (!Array.isArray(arr)) arr = []; // 非配列（モデルが文字列を返す等）はスキップ
      const seen = Object.create(null);
      (arr || []).forEach(r => {
        if (!r || r.id == null) return;
        const prev = seen[r.id];
        if (prev) {
          const sv = s => SEVERITY[normStatus(s.status)] != null ? SEVERITY[normStatus(s.status)] : 1;
          if (sv(r) > sv(prev)) { // より深刻な行で置き換え
            const list = byId[r.id];
            list[list.length - 1] = r;
            seen[r.id] = r;
          }
          return;
        }
        seen[r.id] = r;
        (byId[r.id] = byId[r.id] || []).push(r);
      });
    });
    const merged = [];
    const disagreements = [];
    Object.keys(byId).forEach(id => {
      const rs = byId[id];
      const statuses = rs.map(r => normStatus(r.status)); // B-1: trim込み正規化（' fail'がfail検知を逃れないように）
      const m = mode(statuses);
      let status = m.value;
      let detailPrefix = '';
      // ④ 一部の回/モデルがこの項目を返していない（欠落）→ 突き合わせが成立しない
      const partial = total > 1 && rs.length < total;
      if (!m.unanimous) {
        // 割れた → 安全側 warn。na が過半なら na 維持だが、
        // N7: 少数派に fail があるときは握り潰さず warn（見逃し防止）。
        if (m.value === 'na' && m.count > statuses.length / 2 && !statuses.includes('fail')) {
          status = 'na';
        } else {
          status = 'warn';
          detailPrefix = `【判定ゆれ: ${statuses.join('/')} → 要確認】`;
        }
        disagreements.push(id);
      } else if (partial) {
        // 提示された回では一致しているが、一部のモデル/回が本項目を欠落＝両者の突き合わせが不成立。
        // 「モデル一致による誤判定防止」の前提が崩れるため、断定(pass/fail)は warn（要確認）へ降格。
        // na/warn はそのまま維持（非該当・要確認はそもそも断定ではない）。
        disagreements.push(id);
        if (status === 'pass' || status === 'fail') {
          detailPrefix = `【一部の判定で本項目が未回答(${rs.length}/${total}回) → 突き合わせ不成立につき要確認】元判定:${status}。`;
          status = 'warn';
        } else {
          detailPrefix = `【一部の判定で本項目が未回答(${rs.length}/${total}回)】`;
        }
      }
      // 代表の found_text/detail は、（降格前の）多数決値に一致する最初のrunから採り、根拠を保持
      const rep = rs.find(r => normStatus(r.status) === String(m.value)) || rs[0];
      // N1: confidence を捨てず伝播（最悪値集約＝1回でも low なら low。安全側）。
      // 多回モードで「確信度low→要確認」の安全網が消える逆転を防ぐ。
      const CONF_RANK = { low: 0, '低': 0, '低い': 0, mid: 1, medium: 1, '中': 1, high: 2, '高': 2, '高い': 2 }; // B-2: 表記ゆれ正規化（aggregate.jsと同基準）
      let worstConf;
      rs.forEach(r => {
        const c = String(r.confidence == null ? '' : r.confidence).trim().toLowerCase();
        if (CONF_RANK[c] == null) return;
        if (worstConf == null || CONF_RANK[c] < CONF_RANK[worstConf]) worstConf = c;
      });
      merged.push({
        id,
        status,
        confidence: worstConf,
        found_text: rep.found_text || '',
        detail: detailPrefix + (rep.detail || ''),
      });
    });
    return { merged, disagreements };
  }

  // detected_info をマージ（多数決＋割れ検出）
  // N2/N3: run間で読取値が割れたとき、旧実装は「配列=1回目採用」「数値=中央値(2値なら平均)」で
  // 実在しない/一方だけの値を確定させ、決定論チェックの誤passの温床だった。
  // 新方式: 過半数が一致すればその値を採用。過半数が無ければ 1回目の値を暫定表示しつつ
  // `_disputedFields` に記録 → 決定論チェックは割れたフィールドを「検算保留」にする（deterministic.js側）。
  function mergeDetectedInfo(runs) {
    const keys = new Set();
    runs.forEach(r => Object.keys(r.detected_info || {}).forEach(k => keys.add(k)));
    const out = {};
    const disputed = [];
    keys.forEach(k => {
      const vals = runs.map(r => (r.detected_info || {})[k]).filter(v => v != null && String(v).trim() !== '');
      if (!vals.length) { out[k] = ''; return; }
      // 正規化キーで多数決。A-1: 数値の型・単位ゆれ（100 vs '100' vs '100A'）を「割れ」と
      // 誤判定すると決定論の締めまで保留され旧実装より緩くなるため、純粋な数値（±短い単位）は
      // 数値表現に正規化して比較する。'PFD-28' のような型番は数値化しない（別種の衝突防止）。
      const canonScalar = v => {
        const s = String(v).trim();
        const m2 = s.match(/^([\d,]+(?:\.\d+)?)\s*[a-zA-Z]{0,3}$/);
        return m2 ? String(parseFloat(m2[1].replace(/,/g, ''))) : s;
      };
      const canon = v => Array.isArray(v)
        ? JSON.stringify(v.map(x => (x && typeof x === 'object') ? JSON.stringify(x) : canonScalar(x)))
        : (v && typeof v === 'object') ? JSON.stringify(v) : canonScalar(v);
      const m = mode(vals.map(canon));
      const majority = m.count > vals.length / 2;
      // 採用値: 過半数があればその実値（最初に一致したrunの生値）、無ければ1回目の値（暫定）
      const winner = majority ? vals.find(v => canon(v) === m.value) : vals[0];
      // 数値らしいスカラは数値化して返す（従来互換）。配列・オブジェクトはそのまま。
      if (typeof winner !== 'object') {
        const n = parseFloat(String(winner).replace(/,/g, '').replace(/[^\d.]/g, ''));
        const allNumeric = vals.every(v => !isNaN(parseFloat(String(v).replace(/,/g, '').replace(/[^\d.]/g, ''))));
        out[k] = (allNumeric && !isNaN(n)) ? n : winner;
      } else {
        out[k] = winner;
      }
      if (!majority && vals.length > 1) disputed.push(k);
    });
    if (disputed.length) out._disputedFields = disputed;
    return out;
  }

  // メイン: 複数の生Geminiレスポンスを1つにマージ
  function mergeRuns(runs) {
    runs = (runs || []).filter(Boolean);
    if (runs.length === 0) return null;
    if (runs.length === 1) return runs[0];
    const out = { detected_info: mergeDetectedInfo(runs), _voteRuns: runs.length, _voteDisagreements: [] };
    RESULT_KEYS.forEach(key => {
      if (runs.some(r => Array.isArray(r[key]))) {
        const { merged, disagreements } = mergeResultArray(runs.map(r => r[key] || []));
        out[key] = merged;
        out._voteDisagreements = out._voteDisagreements.concat(disagreements);
      }
    });
    // overall_comment は最初のrunのものを採用（参考情報）
    out.overall_comment = runs[0].overall_comment || '';
    out._model = runs[0]._model;
    return out;
  }

  const api = { mergeRuns, mergeResultArray, mergeDetectedInfo };
  root.NevVote = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
