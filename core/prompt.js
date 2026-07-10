/* ============================================================
   core/prompt.js — 単一定義(rules)から Gemini プロンプトを自動生成
   目的（統合の主眼）: チェック項目の文言(description)を prompt に手書き複製せず、
     rules の定義から生成する。これで「定義とプロンプトの二重管理」を構造的に排除。
   4ツールに共通していたガイダンス（精密読取・複数ページ統合・大小文字許容・
     fail前再確認・warn運用・JSON出力・根拠位置明示）は本ファイルに一度だけ持つ。
   図面固有の前文（役割・図面の定義・固有の注意）は各 rule.prompt に置く。
   ============================================================ */
(function (root) {
  'use strict';

  // 4ツール共通の読取ガイダンス（元プロンプト群から共通部分を抽出・統合）
  const COMMON_GUIDANCE = [
    '## 読み取りの基本方針（必ず守ること）',
    '- 画像はPDFから変換した図面の各ページです。隅々まで拡大するつもりで、小さな文字・記号・ラベルも見逃さないこと。',
    '- 図面に記載された文字・数値は一字一句正確に読み取ること。推測で補完しないこと。',
    '- 複数ページがある場合は全ページの情報を統合して判定すること（表題欄・凡例・機器リスト・詳細図・既設図が別ページに分かれることがある）。1ページ目になくても他ページにあれば「記載あり」として扱う。',
    '- 末尾に「表題欄付近を拡大した画像」が追加される場合がある。設置場所・図面名称・作成者・縮尺・作成日はこの拡大画像も併せて正確に読み取ること。',
    '- 英字の大文字・小文字の違い（Ec/EC、Ed/ED 等）は表記揺れとしていずれも有効とする。',
    '- 「記載なし」でfailと判定する前に、全ページ・機器シンボル周辺・凡例・注記欄を必ず再確認すること。文字が小さい・潰れている等で読取困難な場合は fail ではなく warn とし、detailに「読み取り困難のため要目視確認」と記載する。',
    '',
    '## 判定ステータス',
    '- pass : 要件を満たしている（明確に記載を確認できる）',
    '- fail : 要件を満たしていない（記載が見当たらない、または明らかに不十分）',
    '- warn : 記載はあるが不明瞭、または部分的にしか満たさない／曖昧で目視確認が必要',
    '- na   : 条件付き項目で、該当条件に当てはまらないため判定対象外（「条件」が明示された項目のみ）',
    '',
    '## 判定の必須ルール',
    '- 全てのチェック項目について必ず結果を返すこと（スキップ不可）。',
    '- 「該当する場合のみ」の任意項目で、該当が存在しない場合は na（条件明示あり）または pass（条件なしの任意項目）とする。',
    '- found_text には図面から実際に読み取れた具体的なテキスト・数値を記載する（推測不可）。',
    '- **status を pass にする場合は、found_text に根拠となる実テキスト（図面上の文字列そのまま）を必ず入れること。引用・根拠を示せないなら pass にせず warn とする。**',
    '- 「記載が無くても要件を満たす」タイプの pass（例: 電気系統図で縮尺欄が無くてよい）の場合は、found_text にその旨（例: 「縮尺欄なし・電気系統図は不要」）を明記する（空欄にしない）。',
    '- detail の冒頭に、その情報を読み取った図面上の位置（例:「右下の表題欄」「2ページ目の凡例」）を必ず記載する。特定できない場合は「該当箇所を確認できず」と明記する。',
  ].join('\n');

  // チェック項目リストをカテゴリ順・グループ順に整形（rulesから生成）
  function buildChecklistSection(rule, checks) {
    const cats = rule.categories || {};
    // group → 表示名
    const groupLabel = { nev: 'カテゴリ1: NeV要件判定', manual: 'カテゴリ2: 作図センターマニュアル判定' };
    // 出現するグループを検出（順序は nev→manual）
    const groups = [];
    checks.forEach(c => { const g = c.group || 'nev'; if (!groups.includes(g)) groups.push(g); });
    groups.sort((a, b) => (a === 'nev' ? -1 : 1) - (b === 'nev' ? -1 : 1));

    const lines = [];
    groups.forEach(group => {
      lines.push('');
      lines.push('## ' + (groupLabel[group] || group));
      // このグループのカテゴリを order 順に
      const catIds = Object.keys(cats)
        .filter(cid => (cats[cid].group || 'nev') === group)
        .sort((a, b) => (cats[a].order || 0) - (cats[b].order || 0));
      catIds.forEach(cid => {
        const catChecks = checks.filter(c => c.category === cid && (c.group || 'nev') === group);
        if (catChecks.length === 0) return;
        lines.push('');
        lines.push('### ' + (cats[cid].title || cid));
        catChecks.forEach(c => {
          const flag = c.required ? '【必須】' : (c.condition ? '【条件付き: ' + c.condition + '】' : '【任意】');
          lines.push(`- [${c.id}] ${c.label} ${flag}`);
          lines.push(`  確認内容: ${c.description}`);
        });
      });
    });
    return lines.join('\n');
  }

  // 4図面共通の detected_info 基本フィールド（単一定義。buildOutputSchema / buildPass1Prompt で共用）
  const COMMON_DETECTED_FIELDS = {
    facility_name: '読み取れた設置場所/施設名',
    drawing_title: '読み取れた図面名称',
    creator: '読み取れた作成者',
    scale: '読み取れた縮尺',
    creation_date: '読み取れた作成日',
    charging_count: 'この図面から読み取れる充電設備／充電スペースの数（数値のみ。不明なら空）',
  };

  // 出力JSONスキーマ指示を生成（グループ構成に応じて results / nev_results+manual_results）
  //   opts.extraDetectedInfo: 決定論チェック用に detected_info へ追加要求する数値フィールド {field: 説明}
  //   opts.omitDetectedInfo: true なら detected_info を出力させない（2パスの Pass2＝判定専用。
  //     抽出は Pass1 が担うため、Pass2 での重複抽出を構造的に排除する）
  function buildOutputSchema(checks, opts) {
    opts = opts || {};
    const hasManual = checks.some(c => (c.group || 'nev') === 'manual');
    const hasNa = checks.some(c => c.condition);
    const extra = opts.extraDetectedInfo || {};
    const statusEnum = hasNa ? 'pass | fail | warn | na' : 'pass | fail | warn';
    const item = [
      '    {',
      '      "id": "チェック項目ID",',
      `      "status": "${statusEnum}",`,
      '      "confidence": "high | mid | low（読み取り/判定の確信度。文字が小さい・不鮮明・曖昧な場合は low）",',
      '      "found_text": "図面から読み取れた具体的な内容（テキスト・数値をそのまま）",',
      '      "detail": "判定理由（冒頭に図面上の位置を明記）"',
      '    }',
    ].join('\n');

    const blocks = [];
    if (hasManual) {
      blocks.push(`  "nev_results": [\n${item}\n  ],`);
      blocks.push(`  "manual_results": [\n${item}\n  ],`);
    } else {
      blocks.push(`  "results": [\n${item}\n  ],`);
    }

    if (opts.omitDetectedInfo) {
      return [
        '## 回答フォーマット（厳密にこのJSON形式のみで返す。前後に余計なテキストは不要）',
        '```json',
        '{',
        blocks.join('\n'),
        '  "overall_comment": "図面全体の総合コメント（良い点・改善点。250文字程度。Pass 1 で読み取ったデータの整合性も含めて評価）"',
        '}',
        '```',
        '※ detected_info（読み取り情報）は Pass 1 で抽出済みのため、このパスでは出力しないこと。',
      ].join('\n');
    }

    const commonKeys = Object.keys(COMMON_DETECTED_FIELDS);
    return [
      '## 回答フォーマット（厳密にこのJSON形式のみで返す。前後に余計なテキストは不要）',
      '```json',
      '{',
      blocks.join('\n'),
      '  "overall_comment": "図面全体の総合コメント（良い点・改善点。250文字程度）",',
      '  "detected_info": {',
      ...commonKeys.map((f, i) => `    "${f}": "${COMMON_DETECTED_FIELDS[f]}"` + (i < commonKeys.length - 1 ? ',' : (Object.keys(extra).length ? ',' : ''))),
      ...Object.keys(extra).map((f, i, arr) => `    "${f}": "${extra[f]}"` + (i < arr.length - 1 ? ',' : '')),
      '  }',
      '}',
      '```',
      Object.keys(extra).length ? '\n※ detected_info の数値フィールドは、コード側での再検証に使うため、図面から読み取った値を正確に記載すること（桁の誤りに特に注意）。' : '',
    ].filter(Boolean).join('\n');
  }

  // メイン: rule と businessType から完全なプロンプト文字列を生成
  //   filterChecks: rules-registry.filterChecks（DI。未指定なら root.NevRules から取得）
  function buildPrompt(rule, businessType, opts) {
    opts = opts || {};
    const filter = opts.filterChecks
      || (root.NevRules && root.NevRules.filterChecks)
      || (typeof require !== 'undefined' ? require('./rules-registry.js').filterChecks : null);
    if (!filter) throw new Error('buildPrompt: filterChecks が利用できません');

    const checks = filter(rule, businessType);
    const p = rule.prompt || {};
    // 決定論チェック用に detected_info へ要求する数値フィールドを収集。
    // 加えて rule.prompt.extraDetectedInfo（表示専用の追加抽出。例: 配線の旗上げ一覧）をマージする。
    // ※表示専用フィールドは deterministic の requires ではないため、多数決の割れ検出・検算保留の
    //   対象にならない（表記ゆれの多い一覧情報が検算を止めないようにする設計上の分離）。
    if (!opts.extraDetectedInfo) {
      const det = root.NevDeterministic || (typeof require !== 'undefined' ? (function () { try { return require('./deterministic.js'); } catch (e) { return null; } })() : null);
      const fields = (det && det.requiredFields) ? det.requiredFields(rule) : {};
      Object.assign(fields, (rule.prompt && rule.prompt.extraDetectedInfo) || {});
      opts = Object.assign({}, opts, { extraDetectedInfo: fields });
    }
    const btLabel = businessType === 'kiso' ? '基礎充電（マンション・集合住宅等）'
      : businessType === 'mokutekichi' ? '目的地充電（商業施設・宿泊施設等）'
      : '（事業区分指定なし）';

    const header = [
      p.role || `あなたはNeV充電インフラ補助金の申請図面「${rule.meta.drawingName}」を審査する高精度AIチェッカーです。`,
      '',
      `## 対象図面: ${rule.meta.drawingName}`,
      p.overview ? p.overview : '',
      `## 事業区分: ${btLabel}`,
      p.guidance ? ('\n' + p.guidance) : '',
      // 波③: readingGuidance（数値読み取りノウハウ）は2パス化で guidance から分離した。
      // 1パス（本関数＝batch.js経路含む）では従来どおり guidance に続けて連結（出力テキスト不変）。
      p.readingGuidance ? ('\n' + p.readingGuidance) : '',
    ].filter(Boolean).join('\n');

    return [
      header,
      COMMON_GUIDANCE,
      '# チェック項目（各項目について pass/fail/warn/na を判定）',
      buildChecklistSection(rule, checks),
      buildOutputSchema(checks, opts),
    ].join('\n\n');
  }

  // ── 波③: 2パス方式（旧・配線ルート図ツール buildPass1Prompt / buildPass2Prompt の復元） ──
  // rule.settings.twoPass=true の図面で個別チェック(app.js)が使用する。batch.js は従来どおり buildPrompt（1パス）。

  // Pass1（抽出専用）が detected_info に要求する全フィールドを収集:
  //   共通6種 + 決定論検算用(requires) + 表示専用(extraDetectedInfo) + 色観測等(pass1Extra)
  //   ＝1パス時に要求していた集合のスーパーセット（重複抽出はPass2側を空にすることで排除）。
  function collectPass1Fields(rule) {
    const det = root.NevDeterministic || (typeof require !== 'undefined' ? (function () { try { return require('./deterministic.js'); } catch (e) { return null; } })() : null);
    const fields = Object.assign({}, COMMON_DETECTED_FIELDS);
    Object.assign(fields, (det && det.requiredFields) ? det.requiredFields(rule) : {});
    Object.assign(fields, (rule.prompt && rule.prompt.extraDetectedInfo) || {});
    Object.assign(fields, (rule.prompt && rule.prompt.pass1Extra) || {});
    return fields;
  }

  function businessTypeLabel(businessType) {
    return businessType === 'kiso' ? '基礎充電（マンション・集合住宅等）'
      : businessType === 'mokutekichi' ? '目的地充電（商業施設・宿泊施設等）'
      : '（事業区分指定なし）';
  }

  // Pass1: データ読み取り専用プロンプト（合否判定を禁止し、抽出精度に全リソースを割かせる）
  function buildPass1Prompt(rule, businessType) {
    const p = rule.prompt || {};
    const fields = collectPass1Fields(rule);
    const keys = Object.keys(fields);
    const schema = [
      '## 回答フォーマット（厳密にこのJSON形式のみで返す。前後に余計なテキストは不要）',
      '```json',
      '{',
      '  "detected_info": {',
      ...keys.map((f, i) => `    "${f}": "${fields[f]}"` + (i < keys.length - 1 ? ',' : '')),
      '  }',
      '}',
      '```',
      '※ 全フィールドを必ず detected_info オブジェクトの中に入れて返すこと。',
      '※ 読み取れない項目は空文字または空配列とし、推測値で穴埋めしないこと（「本当に無い」と「読み取れない」を区別する）。',
      '※ 数値フィールドはコード側での再検証に使うため、図面から読み取った値を正確に記載すること（桁の誤りに特に注意）。',
    ].join('\n');
    return [
      [
        `あなたはNeV補助金の申請図面「${rule.meta.drawingName}」のデータ読み取りエキスパートです。図面PDF（画像）の全ページを隅々まで確認し、判定に必要なデータを高精度で読み取ってください。`,
        '**このパス（Pass 1）ではデータの正確な読み取りのみに集中してください。要件の合否判定は行いません。**',
        '',
        `## 対象図面: ${rule.meta.drawingName}`,
        p.overview ? p.overview : '',
        `## 事業区分: ${businessTypeLabel(businessType)}`,
      ].filter(Boolean).join('\n'),
      p.pass1Guidance || '',
      p.guidance || '',
      p.readingGuidance || '',
      schema,
    ].filter(Boolean).join('\n\n');
  }

  // Pass2: 判定専用プロンプト。Pass1の抽出結果JSONを添付し、これを最優先の根拠として判定させる。
  //   出力スキーマは detected_info を含まない（omitDetectedInfo）＝重複抽出の構造的排除。
  function buildPass2Prompt(rule, businessType, pass1Data, opts) {
    opts = opts || {};
    const filter = opts.filterChecks
      || (root.NevRules && root.NevRules.filterChecks)
      || (typeof require !== 'undefined' ? require('./rules-registry.js').filterChecks : null);
    if (!filter) throw new Error('buildPass2Prompt: filterChecks が利用できません');
    const checks = filter(rule, businessType);
    const p = rule.prompt || {};
    // 内部キー（_始まり）は添付しない
    const clean = {};
    Object.keys(pass1Data || {}).forEach(k => { if (k.charAt(0) !== '_') clean[k] = pass1Data[k]; });
    const dataJson = JSON.stringify(clean, null, 2);
    const header = [
      p.role || `あなたはNeV充電インフラ補助金の申請図面「${rule.meta.drawingName}」を審査する高精度AIチェッカーです。`,
      '',
      '**前段の Pass 1 で図面から読み取ったデータと、図面画像の両方を参照しながら、要件の合否判定を行ってください。このパス（Pass 2）では合否判定のみに集中し、データの再集計は行いません。**',
      '',
      `## 対象図面: ${rule.meta.drawingName}`,
      p.overview ? p.overview : '',
      `## 事業区分: ${businessTypeLabel(businessType)}`,
      '',
      '## 【参考データ】Pass 1 読み取り結果（判定の根拠として最優先で参照すること）',
      '以下のJSONは前段（Pass 1）で図面から読み取ったデータです。判定の根拠として活用し、不明な点がある場合のみ図面画像を直接確認してください。',
      '```json',
      dataJson,
      '```',
      p.guidance ? ('\n' + p.guidance) : '',
      p.pass2Guidance ? ('\n' + p.pass2Guidance) : '',
    ].filter(Boolean).join('\n');
    return [
      header,
      COMMON_GUIDANCE,
      '# チェック項目（各項目について pass/fail/warn/na を判定）',
      buildChecklistSection(rule, checks),
      buildOutputSchema(checks, { omitDetectedInfo: true }),
    ].join('\n\n');
  }

  root.NevPrompt = { COMMON_GUIDANCE, COMMON_DETECTED_FIELDS, buildChecklistSection, buildOutputSchema, buildPrompt, buildPass1Prompt, buildPass2Prompt, collectPass1Fields };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.NevPrompt;

})(typeof window !== 'undefined' ? window : globalThis);
