/* ============================================================
   core/aggregate.js — チェック結果の集計・総合判定（汎用）
   出典: 配線ルート図ツール checker.js の aggregateNevResults /
         aggregateManualResults を1関数に一般化。
   ブラウザ / Node どちらでも動作（DOM非依存）
   ============================================================ */
(function (root) {
  'use strict';

  // aggregateResults
  //   rawResults : Gemini が返した判定結果の配列 [{ id, status, found_text, detail }]
  //   checks     : チェック項目定義の配列 [{ id, category, label, required, ... }]
  //   opts.requiredFailForWarn : 必須不合格がこの件数以下なら総合「要確認」、超えたら「不合格」（既定2）
  //
  // 【判定ルール（配線ルート図ツールと同一 ＋ na 対応）】
  //   ・任意項目(required:false)が fail のときは warn に降格（不合格扱いにしない）
  //   ・未回答の項目は fail 扱い（「判定結果が取得できませんでした」）
  //   ・'na'（非該当）は pass/fail/warn いずれにも数えず na バケットに分離（電気系統図ツール等の条件付き項目向け）
  //   ・総合: 必須fail 0=合格 / 1〜requiredFailForWarn=要確認 / それ超=不合格
  function aggregateResults(rawResults, checks, opts) {
    opts = opts || {};
    const requiredFailForWarn = (typeof opts.requiredFailForWarn === 'number') ? opts.requiredFailForWarn : 2;

    // null-proto: チェックidがプロトタイプ属性名（constructor等）と衝突しても、未回答なのに
    // answered=true になったり Object.prototype のメンバを判定に使ったりしない（KNOWNと同じ衛生）。
    const resultMap = Object.create(null);
    (Array.isArray(rawResults) ? rawResults : []).forEach(r => { if (r && r.id != null) resultMap[r.id] = r; });

    const KNOWN = Object.assign(Object.create(null), { pass: 'pass', fail: 'fail', warn: 'warn', na: 'na' }); // 「__proto__」等のstatus文字列がObject.prototype経由で正規化を素通りしない
    // 確信度low → pass/fail を warn（要確認）へ降格（既定on）。断定的な誤読を人間確認に回す。
    const abstainLowConfidence = opts.abstainLowConfidence !== false;
    // 根拠(found_text)の無い「合格」を warn へ降格（既定on）。品質最優先：幻覚・無根拠のpassを禁止。
    const requireEvidenceForPass = opts.requireEvidenceForPass !== false;
    const items = checks.map(check => {
      const answered = !!resultMap[check.id]; // 未回答（AI応答の欠落）と実judgmentの区別（旧基準デグレードの適用可否に使用）
      const result = resultMap[check.id] || { status: 'fail', found_text: '', detail: '判定結果が取得できませんでした' };
      // ステータス正規化: 大小文字/前後空白を吸収し、未知の値は安全側の warn（要確認）に寄せる。
      // （Geminiが 'PASS' や '合格' 等を返しても、無色バッジ・誤って合格扱いになるのを防ぐ）
      let status = KNOWN[String(result.status == null ? '' : result.status).trim().toLowerCase()] || 'warn';
      let detail = result.detail || '';
      const foundText = String(result.found_text == null ? '' : result.found_text).trim();
      // 確信度low: 断定(pass/fail)を warn に落とす（na・warnはそのまま）。
      // ※決定論チェック(_deterministic)が確定させた結果は、コード検算が根拠でありAIの確信度とは無関係なので降格しない。
      // 表記ゆれ正規化: 日本語（低/中/高）や medium 等をスキーマ値(low/mid/high)に吸収（低→low を逃すと降格が不発）。
      const CONF_MAP = Object.assign(Object.create(null), { low: 'low', '低': 'low', '低い': 'low', mid: 'mid', medium: 'mid', '中': 'mid', high: 'high', '高': 'high', '高い': 'high' });
      const confRaw = String(result.confidence == null ? '' : result.confidence).trim().toLowerCase();
      const conf = CONF_MAP[confRaw] || confRaw;
      if (abstainLowConfidence && conf === 'low' && (status === 'pass' || status === 'fail') && !result._deterministic) {
        detail = '【確信度low→要確認】' + detail;
        status = 'warn';
      }
      // 根拠なき合格の禁止: pass なのに読み取り内容が空なら warn（要確認）へ。
      // ※「記載が無くてもよい」passは、その旨をfound_textに記す運用（プロンプトで指示）。空＝無根拠とみなす。
      // ※ただし決定論チェック(_deterministic)が確定させた pass は、その検算結果(detail)自体が根拠なので降格しない。
      if (requireEvidenceForPass && status === 'pass' && foundText === '' && !result._deterministic) {
        detail = '【根拠未提示→要確認】読み取り内容(found_text)が空のため合格を保留。目視確認してください。' + (detail ? ' / ' + detail : '');
        status = 'warn';
      }
      // S2: na の妥当性ゲート。条件(condition)も naAllowed も無い必須項目に AI が na を返した場合、
      // 分母から静かに消えて総合合格になる false PASS 経路 → warn（要確認）へ矯正する。
      // （正当な na = condition 明示 / naAllowed 明示 / 決定論チェックが確定させた na は維持）
      if (status === 'na' && check.required && !check.condition && !check.naAllowed && !result._deterministic) {
        detail = '【非該当(na)の妥当性未確認→要確認】この項目は常時必須として定義されており、非該当になる条件がありません。本当に非該当か目視確認してください。' + (detail ? ' / ' + detail : '');
        status = 'warn';
      }
      // 'na'（非該当）はそのまま維持。任意項目の fail のみ warn へ降格。
      // 他の自動降格（色サニティ・旧基準）と同じ監査様式（注記＋original_status）に揃える:
      // pill「要確認」なのに detail が不合格の判定理由のまま＝説明の非対称、を解消（2026-07-23 第4R所見）。
      let optionalOriginal;
      if (status !== 'na' && !check.required && status === 'fail') {
        optionalOriginal = 'fail';
        detail = '【任意項目・自動降格 不合格→要確認】任意項目のため不合格とせず要確認として表示します。元の判定理由: ' + (detail || '（詳細なし）');
        status = 'warn';
      }
      // 旧基準デグレード（P1単調性の承認済み例外②・2026-07-17ユーザー決定）:
      // 作図センターマニュアル（R6補正基準・最新版は今年作成されない）由来の基準は「古いもの」として扱い、
      // 現行案件の不合格断定に用いない＝最大でも warn（要確認）。判定ロジック自体は残す。
      // 対象: manual群（作図センター基準タブ）＋ NeV群のうち出典が社内基準（src:'社内基準'）の項目。
      // fail→warn は緩め方向だが、色サニティ（例外①）と同様 original_status で監査可能にする。
      // ※未回答（AI応答欠落）の合成failは「基準の新旧」と無関係なデータ欠落なので格下げしない
      //   （haisen の total_length 等は NeV タブの必須項目——未回答まで warn 化すると総合が緩む false-PASS 経路）。
      const isLegacyBasis = (check.group === 'manual') || (check.src === '社内基準');
      let legacyOriginal;
      if (isLegacyBasis && status === 'fail' && answered) {
        legacyOriginal = 'fail';
        // 検算(_deterministic)由来のfailは根拠がコード計算（現行手引きベースあり得る）なので、
        // 「R6由来の判定だから格下げ」と書くと自己矛盾になる。項目の位置づけ（旧基準扱い）を理由にした文言に分ける。
        detail = (result._deterministic
          ? '【旧基準・自動格下げ 不合格→要確認】この項目は旧基準（R6作図マニュアル）扱いのため不合格とは断定しませんが、元の判定にはコード検算が含まれます。指摘内容を必ず目視確認してください。元の判定理由: '
          : '【旧基準・自動格下げ 不合格→要確認】この項目はR6作図マニュアル由来の旧基準です（最新版マニュアルは未作成）。現行案件の不合格断定には用いず、参考として目視確認してください。元の判定理由: ')
          + (detail || '（詳細なし）');
        status = 'warn';
      }
      return Object.assign({}, check, {
        status,
        found_text: result.found_text || '',
        detail,
        confidence: conf || undefined,
      }, isLegacyBasis ? { legacy: true } : null,
      // original_status: legacy格下げ > 色サニティ等が result行に書いた値（「自動降格のまま」表示・監査用）。
      // result行由来の値は KNOWN で正規化してから通す（万一未知の文字列が紛れても表示層に生値を流さない）。
      (() => {
        const passOriginal = legacyOriginal || optionalOriginal || KNOWN[String(result.original_status == null ? '' : result.original_status).trim().toLowerCase()];
        return passOriginal ? { original_status: passOriginal } : null;
      })());
    });

    const categoryResults = {};
    items.forEach(item => {
      if (!categoryResults[item.category]) {
        categoryResults[item.category] = { items: [], pass: 0, fail: 0, warn: 0, na: 0, total: 0 };
      }
      const cat = categoryResults[item.category];
      cat.items.push(item);
      cat.total++;
      if (item.status === 'pass') cat.pass++;
      else if (item.status === 'fail') cat.fail++;
      else if (item.status === 'na') cat.na++;
      else cat.warn++;
    });

    // na の必須項目は「判定対象外」とみなし、必須合計・合否から除外する。
    const totalRequired = items.filter(i => i.required && i.status !== 'na');
    const requiredPass = totalRequired.filter(i => i.status === 'pass').length;
    const requiredFail = totalRequired.filter(i => i.status === 'fail').length;
    // 必須項目のうち「要確認(warn)」の件数。品質最優先：不確実なものが必須にあるなら総合を合格にしない。
    const requiredWarn = totalRequired.filter(i => i.status === 'warn').length;
    // 必須なのに na（非該当）と判定された件数。AIの na 誤用で分母から静かに消えるのを可視化するため別途返す。
    const requiredNa = items.filter(i => i.required && i.status === 'na').length;
    const totalPass = items.filter(i => i.status === 'pass').length;
    const totalNa = items.filter(i => i.status === 'na').length;

    // 4-C: critical項目のfail件数（確信度low降格・任意warn降格を生き延びた確定failのみ＝B-guard）。
    const criticalFail = items.filter(i => i.critical && i.required && i.status === 'fail').length;

    const overall = decideOverall({ requiredFail, requiredWarn, criticalFail, requiredFailForWarn });

    return {
      items,
      categoryResults,
      overall,
      totalPass,
      totalItems: items.length,
      totalNa,
      requiredPass,
      requiredTotal: totalRequired.length,
      requiredFail,
      requiredWarn,
      requiredNa,
      criticalFail,
    };
  }

  // 総合判定式（単一実装。app.js updateOverall もこれを使う＝二重実装の解消）
  //   ・合格 は「必須項目がすべて合格」のときのみ。必須に要確認(warn)が1件でもあれば合格にしない＝要確認。
  //   ・必須fail は 1〜requiredFailForWarn件=要確認 / それ超=不合格。
  //   ・4-C(B-guard): critical必須項目の確定failが1件でもあれば総合「不合格」
  //     （確信度low等の降格を生き延びたfailのみ＝AI誤読の即不合格化を抑制した上での一発アウト）。
  function decideOverall(c) {
    const requiredFailForWarn = (typeof c.requiredFailForWarn === 'number') ? c.requiredFailForWarn : 2;
    if ((c.criticalFail || 0) > 0) return 'fail';
    if (c.requiredFail === 0 && c.requiredWarn === 0) return 'pass';
    if (c.requiredFail === 0) return 'warn';
    return c.requiredFail <= requiredFailForWarn ? 'warn' : 'fail';
  }

  const api = { aggregateResults, decideOverall };
  root.NevAggregate = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
