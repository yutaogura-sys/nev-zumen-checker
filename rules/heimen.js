/* ============================================================
   rules/heimen.js — 平面図の要件（単一定義）
   出典: 【平面図】ツール js/checker.js（COMMON/KISO/MOKUTEKICHI_CHECKS, CATEGORIES）
   根拠: 補助金要件 5-9-2「平面図」。R6補正ベース＝R7補正で記載要件は実質変更なし。
   単一グループ（NeV要件のみ。マニュアル判定なし）→ group は省略（既定 'nev'）。
   数値基準: space_width_check（充電スペース幅 2.5m=2500mm 以上）が唯一の必須数値要件。
   ============================================================ */
(function (root) {
  'use strict';

  const rule = {
    meta: {
      drawingName: '平面図',
      sourceYear: 'R7補正',
      sourceDoc: 'R7補正_NeV要件/R7ho/R7h_juden_tenpu_koufu_heimen.pdf, 手引き5-9-2',
      maxPages: 5,
    },
    settings: { requiredFailForWarn: 2, renderScale: 3.0, maxPayloadBytes: 18_000_000, maxOutputTokens: 16384 },
    prompt: {
      role: 'あなたはNeV補助金（次世代自動車充電インフラ整備促進事業）の「平面図」の審査エキスパートです。補助金要件 5-9-2「平面図」に基づき、図面PDFを高精度に審査してください。',
      overview: '平面図は、EV充電設備の設置場所を上から見た詳細な技術図面です。設置場所見取図（敷地全体・公道・入口を示す広域図）とは異なり、充電設備の配置位置・充電スペースの正確な寸法・基礎仕様・路面状況等を詳細に示します。',
      // 「正解事例の頻出パターン」以降は旧・平面図ツール checker.js の「正解事例から学んだ
      // パターン（30件以上の分析結果）」「確認方法」節からの移植（パリティ監査 B-2。
      // 実在の施設名・会社名は汎用化済み）。探索ヒント・頻出値・色の手がかり＝読み取り成功率に直結。
      guidance: '## この図面の要点\n- 表題欄（右下または下部の枠内）の図面名称が正確に「平面図」であること（配置図・レイアウト図等は不可）。\n- 充電スペースは主に**寸法線（幅・奥行）**で表される。ハッチング（着色/斜線）や【充電スペース1】等の番号ラベルは**付いている場合もあるが必須ではない**（公式記入例は寸法線のみの様式）。無いことだけを理由にfailにしないこと。\n- **充電スペースの幅は2500mm(2.5m)以上**が基準。ただし2.5m未満は既存マンション等で認められる場合があるため fail ではなく warn（要確認）とする。\n- EV充電設備には設置方法（壁面設置/金属架台/置き基礎等）と基礎寸法の注記がある。\n- 目的地充電では路面表示（新設/既設・サイズ・設置面材質）を確認。設置面がアスファルト=合格、コンクリート=要確認、土/砂利/芝=不合格。\n\n## 正解事例の頻出パターン（30件以上の分析。探索の手がかりに使うこと）\n- 表題欄: 図面右下の枠内。「設置場所」欄は施設名のみ（例: ○○ホテル、○○マンション）。工事名は「普通充電設備設置工事」が最多。縮尺は「A3:1/100」が最も一般的。作成日はYYYY年MM月DD日形式。設置場所と工事名が別欄のことがある。\n- 充電スペース: ラベルがある場合は【充電スペース1】等の墨付き括弧＋通し番号、または「充電スペース×N」。寸法は「幅2.5m×奥行5.0m」（m単位）または「幅2500×奥行4900」（mm単位）。実例では幅2.5〜2.7m・奥行4.5〜5.5mが一般的。赤色/ピンク色のハッチング（斜線）で明示される場合がある。\n- EV充電設備: 「EV充電設備1」「EV充電設備2,3」（ペアはカンマ区切り）のラベル。**ラベル・設置方法・基礎仕様は緑色のテキストで記載されることが多い**（緑の小さな文字を見逃さない）。基礎寸法は「コンクリート 500×500×120H」が最も一般的（500×500×500H等もある）。壁面設置は壁からの距離（280mm等）を記載。\n- レイアウト: A3横。表題欄=右下、方位記号(N)=右上、図面本体=中央〜左。寸法線はmm単位の矢印付き（820、1590、900、2500、4900等）。\n- 目的地充電のページ構成: 新設のみ=1ページ「平面図」、新設+既設=2ページ「新設 平面図」＋「既設 平面図」。既設は青色で「残置」表記（「既設EV充電設備1,2 残置」「既設路面表示 残置」「既設路面シート 残置」）。補助金対象外は「※補助金対象外※」マーク。\n- 基礎充電: 路面表示は不要（目的地のみの項目）。充電設備数は2〜7基が一般的。立体駐車場は階数表記あり。周辺構造物（建物・駐輪場・フェンス・縁石・道路・隣地・植栽）が描画される。\n- 探索手順: ①表題欄は右下/下部の枠線内から「設置場所」「図面名称」等のラベルを探す ②充電スペースは【】ラベル・赤/ピンクのハッチング・寸法線から特定する ③幅2500mm(2.5m)以上は具体的な数値で確認する ④「路面状況：○○」のテキストを探す。',
    },
    categories: {
      title_block:          { title: '①表題欄（図面基本情報）', icon: '&#128203;', order: 1 },
      charging_space:       { title: '②充電スペース',          icon: '&#128199;', order: 2 },
      ev_equipment:         { title: '③EV充電設備',           icon: '&#128268;', order: 3 },
      surface_dimensions:   { title: '④路面状況・寸法・方位',   icon: '&#128207;', order: 4 },
      kiso_specific:        { title: '⑤基礎充電 固有項目',     icon: '&#127970;', order: 5 },
      mokutekichi_specific: { title: '⑤目的地充電 固有項目',   icon: '&#127978;', order: 5 },
      appurtenant:          { title: '⑥付帯設備（屋根・小屋・防護材・車止め・電灯・待機）', icon: '&#128736;', order: 6 },
    },
    checks: [
      // ── 表題欄 ──
      { id: 'setting_place', category: 'title_block', label: '設置場所名称の記載',
        description: '表題欄の「設置場所」欄に、申請で入力した設置場所名称（略称不可）が記載されているか。例）○○マンション、○○ホテル 等※申請書で入力した名称との一致（略称不可）は本ツールでは照合できないため判定対象外（記載有無と読取名称の提示のみ）。読み取った名称をdetailに必ず記載し、申請書との一致は人手で確認すること。',
        required: true },
      { id: 'drawing_name', category: 'title_block', label: '図面名称「平面図」の記載',
        description: '表題欄の「図面名称」欄に正確に「平面図」と記載されているか。「新設 平面図」「既設 平面図」も可。不備例：平面配置図、配置図、レイアウト図等は不可',
        required: true },
      { id: 'project_name', category: 'title_block', label: '工事名の記載',
        description: '表題欄に工事名が記載されているか。正解例：「普通充電設備設置工事」「充電設備設置工事」等', required: true },
      { id: 'creator', category: 'title_block', label: '作成者の記載',
        description: '表題欄の「作成者」欄に会社名または個人名が記載されているか', required: true },
      { id: 'scale', category: 'title_block', label: '縮尺の記載（1/100以上）',
        description: '表題欄に縮尺が記載され、かつ1/100以上（分母が100以下。例: 1/50, 1/100は可。1/150, 1/200は不可）であるか（手引き5-9-2基本情報「縮尺（１／１００以上）」）。縮尺の記載がない・「-」はfail。1/100より縮小（分母>100）はwarn（要確認）。',
        required: true },
      { id: 'creation_date', category: 'title_block', label: '作成日の記載',
        description: '表題欄の「作成日」欄に日付が記載されているか（YYYY年MM月DD日 形式等）。読み取った日付をdetailに必ず記載。※手引きの要件は「本補助金の事業開始日以降」だが、事業開始日は本ツールでは照合できないため人手で確認すること。', required: true },
      // ── 充電スペース ──
      { id: 'space_labels', category: 'charging_space', label: '充電スペースの番号ラベル（ある場合）',
        description: '充電スペースに通し番号付きラベルがある場合、記載されているか。例：【充電スペース1】【充電スペース2】…、充電スペース×4 等。公式記入例は寸法線のみでラベルが無い様式もあるため、番号ラベルが無いことだけを理由に不合格にしない（無ければ na または warn）。',
        required: false },
      { id: 'space_dimensions', category: 'charging_space', label: '充電スペースの寸法（幅×奥行）',
        description: '各充電スペースの幅と奥行きの寸法が記載されているか。正解例：幅2.5m × 奥行5.0m、幅2500 × 奥行4900 等',
        required: true },
      { id: 'space_width_check', category: 'charging_space', label: '充電スペース幅 2.5m（2500mm）以上',
        description: '全ての充電スペースの幅が2.5m（2500mm）以上あるか。2.5m未満は不備', required: true, critical: true },
      { id: 'space_highlight', category: 'charging_space', label: '充電スペースの着色・ハッチング表示（ある場合）',
        description: '充電スペースが赤色・ピンク色等のハッチング（斜線）や着色で明示されている場合、それが確認できるか。公式記入例は寸法線のみの様式もあり着色は必須ではないため、着色が無く寸法線で充電スペースが特定できていれば不合格にしない（無ければ na または warn）。', required: false },
      // ── EV充電設備 ──
      { id: 'equipment_labels', category: 'ev_equipment', label: 'EV充電設備の通し番号ラベル（任意）', src: '社内基準',
        description: 'EV充電設備に通し番号付きラベルが記載されているか。正解例：EV充電設備1、EV充電設備2,3、EV充電設備1〜4 等。※手引き・記入例に要求がないため任意（2026-07-14格下げ・ユーザー承認）',
        required: false },
      { id: 'mounting_method', category: 'ev_equipment', label: '設置方法の記載',
        description: 'EV充電設備の設置方法が記載されているか。正解例：壁面設置、金属架台、置き基礎、コンクリート置き基礎 等', required: true },
      { id: 'foundation_spec', category: 'ev_equipment', label: '基礎仕様・寸法の記載',
        description: '基礎の仕様と寸法が記載されているか。正解例：コンクリート 500×500×120H、コンクリート置き基礎 500×500×500H 等。壁面設置の場合は壁面からの距離(例:280mm)でも可。※全設備が壁面設置で基礎が存在しない場合は na（非該当）とする。置き基礎・架台設置がある場合は寸法・仕様の記載を確認する。',
        required: true, condition: '置き基礎・架台設置がある場合（全て壁面設置ならna）' },
      // ── 路面・寸法 ──
      { id: 'surface_material', category: 'surface_dimensions', label: '路面状況（材質）の記載', src: '社内基準',
        description: '路面を構成する材質が記載されているか。正解例：路面状況：アスファルト、路面状況：土、路面状況：コンクリート 等。※屋内駐車場や全設備が壁面設置で路面（地面）が存在しない場合は na（非該当）とする。屋外設置で路面がある場合は材質記載を確認する。',
        required: true, condition: '屋外設置で路面がある場合（屋内・壁面設置で路面が無ければna）' },
      { id: 'dimension_lines', category: 'surface_dimensions', label: '寸法線の記載',
        description: '充電設備・充電スペース周辺に寸法線（mm単位）が記載されているか。正解例：2500, 4900, 820, 1590 等の寸法線', required: true },
      { id: 'compass', category: 'surface_dimensions', label: '方位記号（N）の記載',
        description: '方位記号（北を示すN矢印）が図面上に記載されているか。通常は右上に配置。5-9-2必須要件ではないが記載推奨', required: false },

      // ── 基礎充電 固有 ──
      { id: 'surrounding_structures', category: 'kiso_specific', label: '周辺構造物の記載',
        description: '建物、駐車場、駐輪場、フェンス、縁石、道路、隣地、植栽等の周辺構造物が記載されているか', required: true },
      { id: 'building_name', category: 'kiso_specific', label: '建物名称の表示',
        description: 'マンション・団地等の建物名称が図面上に表示されているか', required: true },
      { id: 'equipment_space_consistency', category: 'kiso_specific', label: 'EV充電設備数と充電スペース数の整合性',
        description: 'EV充電設備の台数と充電スペースの数が対応しているか（1設備に1スペース、またはペア設備に対応するスペース数）', required: true },
      { id: 'existing_equipment_kiso', category: 'kiso_specific', label: '既設充電設備の表示',
        description: '既設充電設備がある場合、既設と新設が区別して表示されているか（該当する場合のみ）', required: false },

      // ── 目的地充電 固有 ──
      { id: 'ground_marking', category: 'mokutekichi_specific', label: '路面表示の記載',
        description: '路面表示（EV充電スペースを示すステッカー等）の記載があるか。正解例：路面表示 新設 900×900、路面シート 等', required: true },
      { id: 'ground_marking_spec', category: 'mokutekichi_specific', label: '路面表示の仕様（新設/既設・サイズ）',
        description: '路面表示が新設か既設か、およびサイズが記載されているか。正解例：新設 900×900、既設路面表示 残置、既設路面シート 残置 等', required: true },
      { id: 'ground_marking_surface', category: 'mokutekichi_specific', label: '路面表示の設置面（材質確認）', src: '社内基準',
        description: '路面表示の設置面の材質を確認。判定基準：アスファルト=合格、コンクリート=要確認（施工方法によっては可・実機確認推奨）、土・砂利・芝等=不合格、記載なし=不合格', required: true },
      { id: 'existing_equipment', category: 'mokutekichi_specific', label: '既設充電設備の表示（該当する場合）',
        description: '既設充電設備がある場合、既設EV充電設備と既設充電スペースが青色等で区別して表示されているか', required: false },
      { id: 'new_existing_distinction', category: 'mokutekichi_specific', label: '新設/既設の色分け・ページ分離',
        description: '新設と既設が色分け（新設=赤/ピンク、既設=青）またはページ分離（新設 平面図/既設 平面図）で区別されているか。既設がない場合はパスとする', required: false },
      { id: 'subsidy_exclusion', category: 'mokutekichi_specific', label: '補助金対象外設備の明記（該当する場合）',
        description: '補助金対象外の設備がある場合、「※補助金対象外※」等の表記で明示されているか', required: false },

      // ── P0-5 追加（任意・条件付き。記入例の丸数字③⑤⑦〜⑪＋待機スペースの拾い上げ。全事業共通）──
      { id: 'equipment_front', category: 'ev_equipment', label: '充電設備の正面表示（ある場合）',
        description: '充電設備の正面（ケーブル取り出し向き）が図示されているか。記入例③。該当が判別できない場合は na。',
        required: false, condition: '正面向きの図示が該当する場合' },
      { id: 'space_lines', category: 'charging_space', label: '充電スペースのライン引き（ある場合）',
        description: '充電スペースのライン引き（区画線）が図示されているか。記入例⑤。無ければ na。',
        required: false, condition: 'ライン引きがある場合' },
      { id: 'roof', category: 'appurtenant', label: '屋根設置（ある場合）',
        description: '屋根を設置する場合、位置に加え、メンテナンススペースの確保・基礎寸法・施工要領書準拠等（参考PDF）が記載されているか。屋根設置が無ければ na。',
        required: false, condition: '屋根設置がある場合' },
      { id: 'hut', category: 'appurtenant', label: '小屋設置（ある場合）',
        description: '小屋を設置する場合、位置・仕様（基礎寸法等）が記載されているか。小屋設置が無ければ na。',
        required: false, condition: '小屋設置がある場合' },
      { id: 'protector', category: 'appurtenant', label: '防護用部材（ある場合）',
        description: '防護用部材（車両接触防護）がある場合、充電スペースとの寸法・位置が記載されているか。無ければ na。',
        required: false, condition: '防護用部材がある場合' },
      { id: 'wheel_stop', category: 'appurtenant', label: '車止め（ある場合）',
        description: '車止めがある場合、位置が明記されているか（既設であっても図面に明記）。無ければ na。',
        required: false, condition: '車止めがある場合' },
      { id: 'light_position', category: 'appurtenant', label: '電灯位置（ある場合）',
        description: '充電設備・充電スペースを照らす電灯がある場合、その設置位置が記載されているか。無ければ na。',
        required: false, condition: '電灯がある場合' },
      { id: 'waiting_space', category: 'appurtenant', label: '待機スペース（ある場合）',
        description: '待機スペースがある場合、図面に表示されているか（参考PDF「待機スペース」）。無ければ na。',
        required: false, condition: '待機スペースがある場合' },
    ],
    businessTypeBranch: {
      kiso: ['surrounding_structures', 'building_name', 'equipment_space_consistency', 'existing_equipment_kiso'],
      mokutekichi: ['ground_marking', 'ground_marking_spec', 'ground_marking_surface', 'existing_equipment', 'new_existing_distinction', 'subsidy_exclusion'],
    },
    // 決定論的クロスチェック（AIが読んだ数値をコードで再検証）
    deterministic: [
      { fn: 'space_width_2500', targets: ['space_width_check'],
        requires: { charging_space_widths_mm: '各充電スペースの幅(mm)を数値配列で。例:[2500,2500]。読み取れない場合は空配列' } },
    ],
  };

  const reg = (root && root.NevRules) || (typeof require !== 'undefined' ? require('../core/rules-registry.js') : null);
  if (reg && reg.registerRule) reg.registerRule('heimen', rule);
  if (typeof module !== 'undefined' && module.exports) module.exports = rule;

})(typeof window !== 'undefined' ? window : globalThis);
