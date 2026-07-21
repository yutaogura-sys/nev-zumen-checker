/* ============================================================
   rules/haisen.js — 配線ルート図の要件（単一定義）
   出典: 【配線ルート図】ツール js/checker.js（COMMON/KISO/MOKUTEKICHI/MANUAL_CHECKS,
         CATEGORIES, MANUAL_SPEC）。R6補正ベース＝R7補正で図面記載要件は実質変更なし。
   本図面は判定が2グループ:
     group 'nev'    … NeV交付要件の記載チェック
     group 'manual' … 作図センターマニュアル準拠チェック
   マニュアル固定スペック値は spec（＝MANUAL_SPEC）に単一情報源として保持。
   ============================================================ */
(function (root) {
  'use strict';

  const rule = {
    meta: {
      drawingName: '配線ルート図',
      sourceYear: 'R7補正',
      sourceDoc: 'R7補正_NeV要件/R7ho/R7h_juden_tenpu_koufu_haisen.pdf, 手引き5章',
      maxPages: 6,
      // マニュアル準拠の固定スペック値（単一情報源。値変更時はここを起点に）
      spec: {
        burialHatchingColors: {
          asphalt:  { color: '紫', verify: false, note: 'レビューで確定（旧: 赤は誤り）' },
          concrete: { color: '赤', verify: true,  note: '実マニュアル確認後に確定' },
          soil:     { color: '緑', verify: false, note: '土/砂利' },
          gravel:   { color: '緑', verify: false, note: '土/砂利' },
        },
        cableProtector: { color: 'オレンジ', spec: 'CP2-60X3MBK', verify: false },
        wireRouteColors: {
          new:      { color: '赤', verify: false, note: '新設配線' },
          existing: { color: '青', verify: false, note: '既設配線' },
          utility:  { color: '緑', verify: false, note: '電力会社工事' },
        },
        cableConduitMatch: {
          'CVT8sq-3C': ['PFD-28', 'HIVE-28'], 'CVT22sq': ['PFD-28'], 'CVT38sq': ['PFD-36'],
          'CVT60sq': ['PFD-42', 'HIVE-42'], 'CVT100sq': ['PFD-54', 'HIVE-54'],
        },
        pullboxSize: {
          'PFD/HIVE28': '200×200×100', 'PFD/HIVE36': '200×200×100', 'PFD/HIVE42': '250×250×100',
          'PFD/HIVE54': '250×250×100', 'HIVE70': '300×300×200',
        },
        // 埋設寸法は現場条件で変わる（公式記入例の実例は「幅400mm×深さ300mm」）。特定値の完全一致を要求しない。
        burialDimension: ['幅400mm×深さ300mm', '幅400mm×深さ400mm', '幅200mm×深さ200mm'],
        cableExcessLength: { 6000: 4, 7000: 5, 8000: 6, 9000: 7 },
      },
    },
    // preferImages: 配線ルート図は「色分け（新設=赤/既設=青/電力会社=緑）」が判定要素のため、
    // PDFネイティブ送信ではなくカラー画像化を優先する（旧ツールと同じ経路。ネイティブ送信では
    // モデルが色を判別できず色分けチェックがwarn化する事例を確認済み）。
    // twoPass: 旧・配線ルート図ツールの2パス方式（Pass1=データ抽出専用→Pass2=判定専用）を復元。
    //   個別チェック(app.js)のみ有効（batch.jsは1パスのまま）。API呼び出しが2回になるため料金約2倍。
    settings: { requiredFailForWarn: 2, renderScale: 3.0, maxPayloadBytes: 18_000_000, maxOutputTokens: 32768, preferImages: true, twoPass: true },
    prompt: {
      role: 'あなたはNeV補助金（次世代自動車充電インフラ整備促進事業）の「配線ルート図」の審査エキスパートです。NeV交付要件と作図センターマニュアルの両面から、図面PDFを高精度に審査してください。',
      overview: '配線ルート図は、電源元（受電盤・分電盤・キュービクル等）から各EV充電設備までの配線経路を線で示し、各区間の電線種類・配管種類/サイズ・配線方法（架空/露出/埋設）・距離(m)を記載する図面です。',
      // 表示専用の追加抽出（判定・検算には使わない。目視確認の補助＝旧ツールの「旗上げ一覧」表示の復元）
      extraDetectedInfo: {
        wire_annotations: '図面上の旗上げ注記（各区間の配線注記）を1件ずつ全て配列で。[{cable:"ケーブル種別",conduit:"配管種別(無ければ空)",method:"配線方法(露出配管/立上げ等)",length_m:距離数値,note:"補足(共入れ2/EV充電設備1/(3m×2)等、無ければ空)"}]。共入れ表記（例:CV38sq-2C+IV8sq）は1つの旗上げでもケーブルごとに1件ずつに分解して記載。読み落としなく全件列挙すること。無ければ空配列',
      },
      guidance: '## この図面の要点\n- 図面名称は「配線ルート図」（複数ページ時は「配線ルート図1」等も可）。「配線図」「電気配線図」は不可。\n- 各区間の注記（旗上げ）には「ケーブル種別」「配線方法」「管種-管径」「距離(m)」の4要素が必要。距離は全てm単位。\n- 配線ルートの色分け：新設=赤・既設=青・電力会社工事=緑。**画像はカラーで提供される。色の判別を安易に諦めず、線の色を実際に確認してから判定すること**（モノクロと断定しない）。「黒に見える線」も暗い赤・暗い青の場合があるため注意深く確認する。\n- **新設**埋設区間のハッチング色：アスファルト=紫・コンクリート=赤・土/砂利=緑。既設埋設のみ／該当区間なしはハッチング不要でpass（「ハッチングなし」を理由に過剰にwarn/failしないこと）。\n- ケーブルと配管サイズの整合（例：CVT8sq-3C→PFD-28/HIVE-28）。プルボックス寸法はW×H×D(mm)。\n- 該当設備が存在しない任意項目（プルボックス・ハンドホール等）はpass。\n- 作図センター基準（mc_*）はR6作図マニュアル由来の旧基準（最新版は未作成）。判定は行うが不合格断定には用いない＝逸脱はfailではなくwarn（要確認）で報告し、detailに逸脱内容を具体的に書くこと。',
      // readingGuidance（桁検証〜自己検証）は旧・配線ルート図ツール checker.js buildPass1Prompt から
      // 移植した数値読み取りノウハウの圧縮版（パリティ監査 C-3。判定品質の核心）。
      // 波③で guidance から分離: 1パス(buildPrompt)では guidance+readingGuidance を従来どおり連結、
      // 2パスでは Pass1（抽出専用）にのみ readingGuidance を含める（Pass2は判定専用のため不要）。
      readingGuidance: '## 数値読み取りの精度確保（桁検証ディシプリン・必ず守ること）\n- 距離・長さの数値は本図面で最も誤読が多い。各数値は「①桁数を先に確定（1桁/2桁/3桁か・小数点の有無）→②各桁の文字を1つずつ識別→③隣接する数値と整合するか確認」の手順で読むこと。\n- 典型誤読パターン（必ず再確認）: 「3↔8」「1↔7」「5↔6」「4↔9」「13↔18」、桁数の見落とし「15↔150」「2↔20」。文字が小さい・解像度が低い・別の旗上げと重なる箇所は特に慎重に。\n- 読み取れない数値を**推測値で穴埋めしない**（ハルシネーション禁止）。読めない場合は該当フィールドを空にし、項目判定は warn として「読み取り困難のため要目視確認」と記すこと。「本当に0なのか読めないのか」を必ず区別する。\n\n## 統括表（配線集計表）の読み方\n- まず**列ヘッダー（見出し行）**を確認してレイアウトを判別する。パターンA（シンプル型）:「ケーブル種別|全長|内訳」。パターンB（分離型）:「配線種|配管種|**配管長**|**配線長**|内訳」。\n- パターンBでは「配線長」列＝ケーブルの全長、「配管長」列＝配管の長さ。**配管長の列を配線長と取り違えるのが最頻の誤読**（例: 配管長69m/配線長88mの行では、ケーブル全長は88m）。\n- 行内自己整合: 「全長 = 露出+管内+埋設+架空 の内訳合計」を手元計算で確認し、乖離（絶対差5m以上または相対差5%以上）があればその行を桁ごとに再読する。\n- 統括表が複数ページに分かれる場合は全ページ分を結合して読む（同一種別の分割記載は合算して1件にする）。\n\n## 旗上げ表記の解釈ルール\n- 「Xm (Ym×N)」形式（先頭にXmが明記）: Xmが既に合計値 → 距離=X（×Nを二重適用しない。例:「22m (11m×2)」→22m）。\n- 「(Ym×N)」「Ym×N本」のみ（先頭にXmが無い）: 距離=Y×N を自分で計算する（例:「(3.5m×4)」→14m。3.5mのままにしない）。\n- 「+」結合（例: CV38sq-2C+IV8sq）は複数ケーブルの共入れ並走。ケーブルごとに分解し、それぞれに同じ距離を計上する。\n- 見落としやすい区間（必ず確認）: 既設埋設配管（FEP等・青色テキストで記載され最も見落とされやすい）、立上げ・立下げ、キュービクル/分電盤/プルボックス内配線・余長、ピット内配線、配管端部の短区間。これらの合計が全体の2〜4割を占めることがある。\n\n## マルチページ図面の取りこぼし防止\n- ページごとに独立して旗上げを読み取り、あるページの記録が極端に少ない／0件なら取りこぼしを疑って再走査する。\n- ページをまたぐ同一区間の繰り返し表示は1件として扱う（二重カウント禁止）。\n\n## 読み取りの自己検証（回答前に必ず実行）\n- 旗上げの種別ごとの合算と統括表の値を手元で照合し、絶対差5m以上または相対差15%以上なら該当種別の旗上げを再走査してから回答する。\n- 差異の典型: 旗上げ>統括表は「(Xm×N)」の二重計上・ページ二重記載、旗上げ<統括表は内配線・余長・立上げ・特定ページの読み落とし。\n- 読み取り数値はコード側でも再検証される。桁の誤りに特に注意すること。',
      // ── 波③: 2パス方式（旧ツール buildPass1Prompt / buildPass2Prompt の復元） ──
      // pass1Extra: Pass1（抽出専用）でのみ detected_info に追加要求する色観測フィールド。
      //   1パス(buildPrompt=batch.js経路)のプロンプトには含めない（batch挙動の不変を保証）。
      //   wire_color_distinction / color_legend_observed は app.js の色観測サニティ
      //  （fail→warn降格のみ・モノクロ誤認によるfalse-FAIL防止）の入力になる。
      pass1Extra: {
        is_color_drawing: 'true/false。図面全体に有彩色（赤・青・緑・オレンジ・紫等）が1つでもあれば true、完全モノクロ（黒・白・グレーのみ）なら false。判定に迷う場合は true 側に倒す',
        color_observation_summary: '観測した色を網羅的に1文で要約（例:「配線ルート: 赤・青、ハッチング: 紫、凡例: 3色」。モノクロなら「カラー要素なし」）',
        color_legend_observed: '凡例（記号表・色分け表）に記載されている色分けルールの全文（例:「赤線=新設配線、青線=既設配線、緑線=電力会社工事」）。凡例が見つからない場合は空文字',
        color_legend_location: '凡例の所在（例:「右下表題欄の下」「左上余白」）。見つからない場合は空文字',
        wire_color_distinction: '配線ルート線（電源元→充電設備の経路を示す線）で実際に観測した色名の配列。例:["赤","青"]。完全に黒のみなら空配列 []。背景の罫線・表枠・テキストの色は除外し、配線ルート線の色のみを列挙',
        hatching_colors_observed: '観測されたハッチング（斜線・網掛け・塗りつぶし）の色名の配列。例:["紫","オレンジ"]。ハッチングが一切なければ空配列 []',
        hatching_locations: '各ハッチングの所在・用途の説明配列。例:["埋設区間（紫、アスファルト想定）","ケーブルプロテクター区間（オレンジ）"]。区間自体がなければ空配列。区間はあるが色が確認できない場合は「埋設区間あり（色不明）」のように所在のみ記録',
      },
      // pass1Guidance: Pass1（抽出専用）の色観測手順（旧 checker.js の【最初に判定】/作業1-b/1-c の圧縮版）
      pass1Guidance: '## 【最初に実行】図面のカラー観測（必須・後段の色関連判定すべての根拠になる）\n- 他のすべての作業に着手する前に、図面全体に有彩色（赤・青・緑・オレンジ・紫等）が1つでも含まれるかを判定する（is_color_drawing）。**「黒に見える線」「暗い線」も暗い赤・暗い青の場合があるため注意深く確認**。配線ルート図は通常カラーで、完全モノクロの図面は稀である前提で慎重に判定。不確実な場合は true 側に倒し、color_observation_summary に「不確実: 色微差あり」と注記する。\n- 凡例（「凡例」「記号表」「色分け表」等のラベル付き表）を図面の右下・左下・余白から探し、定義されている色分けルールを文字で書き起こす（color_legend_observed）。所在も記録（color_legend_location）。\n- 配線ルート線（電源元から充電設備への経路を示す線）が実際に何色で描かれているかを観測し、色名を全て列挙する（wire_color_distinction）。背景の罫線・表枠・テキストの色は除外。完全に黒のみなら空配列。\n- ハッチング（斜線・網掛け・塗り）の色と所在・用途を全て列挙する（hatching_colors_observed / hatching_locations）。「該当区間がない」と「区間はあるが色が見えない」は区別し、後者は所在のみ記録する。\n- 慎重かつ正直に観測すること。不確実な場合は空配列・空文字を返し、断定しない（この観測はPass2の色分け判定の主要根拠になる）。',
      // pass2Guidance: Pass2（判定専用）でPass1観測値を最優先根拠にさせる指示＋矛盾自己チェック
      //（旧 checker.js buildPass2Prompt の【特別注意】色関連チェック＋矛盾検出の圧縮版）
      pass2Guidance: '## 【特別注意】色関連チェックの判定（Pass 1 観測値を最優先の根拠にすること）\n- 画像のみで判定せず、まず上の【参考データ】の is_color_drawing / color_observation_summary / color_legend_observed / color_legend_location / wire_color_distinction / hatching_colors_observed / hatching_locations を必ず参照する。\n- 対象項目: mc_color_coding / mc_burial_hatching / mc_cable_protector / new_existing_distinction / mc_new_existing_prefix。found_text には Pass 1 の観測結果（色名・凡例の文言）を引用し、detail には各項目の段階的判定のどの段階に該当したかを明記する。\n- **is_color_drawing=true のとき、色関連チェックをすべて fail にすることは矛盾**。「黒に見える線」も暗い赤・暗い青の場合があるため、安易にモノクロと断定しない。\n- 数値系チェック（total_length / length_breakdown / section_details / mc_summary_* / mc_annotation_format 等）は、Pass 1 の wire_table_totals / wire_annotations / wire_annotation_sums / wire_drawn_lengths を判定の根拠として参照する。数値の再集計はせず、不明な点のみ図面画像を直接確認する。\n\n## 矛盾自己チェック（回答前に必ず実行）\n判定後に以下の矛盾がないか自己チェックし、矛盾があれば再判定すること:\n- is_color_drawing=true なのに mc_color_coding=fail → 矛盾\n- wire_color_distinction が2色以上なのに new_existing_distinction=fail → 矛盾\n- hatching_colors_observed に色があるのに mc_burial_hatching / mc_cable_protector=fail → 矛盾\n- wire_color_distinction に「赤」または「青」を含むのに mc_new_existing_prefix=fail → 矛盾（過剰指摘）\n矛盾を検出した場合は当該チェックを最低でも warn に抑え、detail に「Pass 1 観測値との矛盾あり、要手動確認」と明記する。',
    },
    categories: {
      // NeV要件判定
      title_block:          { title: '(1)表題欄（図面基本情報）',      icon: '&#128203;', order: 1, group: 'nev' },
      wiring_info:          { title: '(2)配線情報（電線・全長・内訳）', icon: '&#128268;', order: 2, group: 'nev' },
      wiring_method:        { title: '(3)配線方法・配管',              icon: '&#128295;', order: 3, group: 'nev' },
      layout:               { title: '(4)設備配置・寸法・路面',         icon: '&#128207;', order: 4, group: 'nev' },
      ancillary:            { title: '(5)付帯設備（立上げ・HH・支柱）', icon: '&#128736;', order: 5, group: 'nev' },
      kiso_specific:        { title: '(6)基礎充電 固有項目',           icon: '&#127970;', order: 6, group: 'nev' },
      mokutekichi_specific: { title: '(6)目的地充電 固有項目',         icon: '&#127978;', order: 6, group: 'nev' },
      // 作図センターマニュアル判定
      manual_summary:       { title: '(A)配線集計表（統括表）', icon: '&#128202;', order: 10, group: 'manual' },
      manual_annotation:    { title: '(B)配線注記フォーマット', icon: '&#128221;', order: 11, group: 'manual' },
      manual_burial:        { title: '(C)埋設関連',           icon: '&#9939;',   order: 12, group: 'manual' },
      manual_pullbox:       { title: '(D)プルボックス',       icon: '&#128230;', order: 13, group: 'manual' },
      manual_protector:     { title: '(E)ケーブルプロテクター', icon: '&#128737;', order: 14, group: 'manual' },
      manual_notation:      { title: '(F)表記規則',           icon: '&#128196;', order: 15, group: 'manual' },
    },
    checks: [
      // ══ NeV 共通（表題欄）══
      { id: 'setting_place', group: 'nev', category: 'title_block', label: '設置場所名称の記載',
        description: '表題欄の「設置場所」欄に、申請で入力した設置場所名称（略称不可）が記載されているか※申請書で入力した名称との一致（略称不可）は本ツールでは照合できないため判定対象外（記載有無と読取名称の提示のみ）。読み取った名称をdetailに必ず記載し、申請書との一致は人手で確認すること。', required: true },
      { id: 'drawing_name', group: 'nev', category: 'title_block', label: '図面名称「配線ルート図」の記載',
        description: '表題欄に「配線ルート図」と記載されているか。複数ページ時は「配線ルート図1」「配線ルート図2」も可。不備例：「配線図」「配線系統図」「電気配線図」「ルート図」等は不可（手引き5-9-3不備事例）', required: true },
      { id: 'project_name', group: 'nev', category: 'title_block', label: '工事名の記載',
        description: '表題欄に工事名が記載されているか。正解例：「充電設備設置工事」「普通充電設備設置工事」等', required: true },
      { id: 'creator', group: 'nev', category: 'title_block', label: '作成者の記載',
        description: '表題欄の「作成者」欄に会社名または個人名が記載されているか', required: true },
      { id: 'scale', group: 'nev', category: 'title_block', label: '縮尺の記載（1/100以上）',
        description: '表題欄に縮尺が記載され、かつ1/100以上（分母が100以下。例: 1/50, 1/100は可。1/150, 1/200は不可）であるか（手引き5-9-3基本情報「縮尺（１／１００以上）」）。縮尺の記載がない・「-」はfail。1/100より縮小（分母>100）はwarn（要確認）。', required: true },
      { id: 'creation_date', group: 'nev', category: 'title_block', label: '作成日の記載',
        description: '表題欄に日付が記載されているか（YYYY年MM月DD日 形式等）。読み取った日付をdetailに必ず記載。※手引きの要件は「本補助金の事業開始日以降」だが、事業開始日は本ツールでは照合できないため人手で確認すること。', required: true },
      // ══ NeV 共通（配線情報）══
      { id: 'wire_type', group: 'nev', category: 'wiring_info', label: '電線の種類・サイズの記載',
        description: '使用する電線の種類とサイズが記載されているか。正解例：CV5.5-3C、CV5sq-3C、CVT100sq 等', required: true },
      { id: 'total_length', group: 'nev', category: 'wiring_info', label: '配線全長の記載', src: '社内基準',
        description: '配線の全長が記載されているか。配線集計表に全長として記載されることが多い', required: true },
      { id: 'length_breakdown', group: 'nev', category: 'wiring_info', label: '配線内訳（露出/管内/埋設等）の記載', src: '社内基準',
        description: '配線全長の内訳が配線方法別に記載されているか。正解例：「内訳 露出 10.7m」「管内 金属製 E25 4.4m」「合成樹脂 埋設 FEP30 2.0m」等', required: true },
      { id: 'section_details', group: 'nev', category: 'wiring_info', label: '各区間の配線詳細の記載',
        description: '配線ルート上の各区間ごとに、電線種類・配管種類・距離が記載されているか', required: true },
      // ══ NeV 共通（配線方法・配管）══
      { id: 'wiring_method', group: 'nev', category: 'wiring_method', label: '配線方法（架空/露出/埋設）の記載',
        description: '各区間の配線方法が明確に記載されているか。架空・露出・埋設の区別', required: true },
      { id: 'conduit_spec', group: 'nev', category: 'wiring_method', label: '配管の種類・サイズの記載',
        description: '使用する配管の種類とサイズが記載されているか。正解例：PFD-28、VE-22、FEP-30、HIVE-42 等', required: true },
      { id: 'conduit_material', group: 'nev', category: 'wiring_method', label: '配管材質の記載（金属製/合成樹脂）',
        description: '配管の材質区分が記載されているか。正解例：「金属製 G28」「合成樹脂 FEP30」等', required: true },
      // ══ NeV 共通（設備配置・寸法）══
      { id: 'charging_space_location', group: 'nev', category: 'layout', label: '充電スペース場所の記載',
        description: '充電スペースの場所が図面上に示されているか（手引き5-9-3【記載の必須項目】《充電スペース》。充電設備設置場所とは別の項目）。', required: true },
      { id: 'equipment_position', group: 'nev', category: 'layout', label: 'EV充電設備の配置位置',
        description: 'EV充電設備の配置が図面上に示されているか', required: true },
      { id: 'power_source', group: 'nev', category: 'layout', label: '電源元（受電盤/分電盤/キュービクル等）の記載',
        description: '配線の起点となる電源元が記載されているか', required: true },
      { id: 'wiring_route_line', group: 'nev', category: 'layout', label: '配線ルートの線表示',
        description: '配線ルートが図面上に線で図示されているか。電源元から各充電設備までの経路が確認できるか', required: true },
      { id: 'dimension_lines', group: 'nev', category: 'layout', label: '位置関係がわかる寸法の記載',
        description: '配線ルート上の各区間の距離（m単位）が記載されているか', required: true },
      { id: 'compass', group: 'nev', category: 'layout', label: '方位記号（N）の記載',
        description: '方位記号（北を示すN矢印）が図面上に記載されているか（任意項目）', required: false },
      { id: 'surface_material', group: 'nev', category: 'layout', label: '路面状況の記載',
        description: '掘削工事（埋設配管）がある場合のみ必須。配線ルートに埋設区間がある場合、路面を構成する材質（アスファルト、コンクリート、土等）が記載されているか確認する。露出配管のみの場合はパス（pass）とする', required: false },
      // ══ NeV 共通（付帯設備）══
      { id: 'rise_info', group: 'nev', category: 'ancillary', label: '立上げ・掘削の長さの記載',
        description: '立上げや掘削がある場合、その長さが記載されているか。該当工事がない場合はパス', required: false },
      { id: 'hand_hole', group: 'nev', category: 'ancillary', label: 'ハンドホールの記載',
        description: 'ハンドホールがある場合、設置位置と仕様が記載されているか。該当がない場合はパス', required: false },
      { id: 'pole_info', group: 'nev', category: 'ancillary', label: '支柱・建柱（引込柱）の記載',
        description: '支柱・建柱（引込柱）を設置する場合、位置に加えて仕様（材質・高さ）・支線位置が記載されているか。記入例④。該当がない場合はパス', required: false },
      // ── R7補正で追加（手引き5-9-3・改訂対比表p57）: 制御装置（OCPP制御装置・課金デバイス等の別体装置）──
      { id: 'control_device_location', group: 'nev', category: 'ancillary', label: '制御装置の設置位置の記載（R7補正追加）',
        description: '制御装置（充電用コンセント等と組み合わせるOCPP制御装置・課金デバイス等の別体装置）を設置する工事がある場合、その設置位置が記載されているか。R7補正の手引き5-9-3【工事の内容に応じて記載する項目】《制御装置設置場所》で追加された項目。制御装置を設置しない工事の場合はna。', required: false, condition: '制御装置を設置する工事がある場合' },
      // ── P0-5 追加（任意・条件付き。参考PDF「電気系統別：図面に記載を求める範囲」に基づくスコープ規定）──
      { id: 'dedicated_wiring_scope', group: 'nev', category: 'layout', label: '図面記載範囲（専用配線の起点）の明示（ある場合）',
        description: '電源元の分電盤が充電専用か共用かが判別でき、図面に記載を求める範囲の起点（専用ブレーカー／接続点(TB)／新設専用盤 等）が示されているか。共用分電盤・特別措置・新設専用盤のケースで参考PDF(zumenkisai)が求める。該当しない（単純な専用引込）場合は na。',
        required: false, condition: '共用分電盤/特別措置/新設専用盤で記載範囲の明示が必要な場合' },
      // ══ NeV 基礎充電 固有 ══
      { id: 'building_name', group: 'nev', category: 'kiso_specific', label: '建物名称の表示',
        description: 'マンション・団地等の建物名称が図面上に表示されているか', required: true },
      { id: 'surrounding_structures', group: 'nev', category: 'kiso_specific', label: '周辺構造物の記載',
        description: '建物、駐車場、駐輪場、フェンス、道路、植栽等の周辺構造物が記載されているか', required: true },
      { id: 'utility_work_boundary', group: 'nev', category: 'kiso_specific', label: '電力会社工事区間の明示',
        description: '電力会社工事区間がある場合、範囲が明示されているか。該当がない場合はパス', required: false },
      { id: 'power_meter_kiso', group: 'nev', category: 'kiso_specific', label: '電力量計の記載',
        description: '新設電力量計がある場合、設置位置が記載されているか。該当がない場合はパス', required: false },
      // ══ NeV 目的地充電 固有 ══
      { id: 'pull_box', group: 'nev', category: 'mokutekichi_specific', label: 'プルボックスの記載',
        description: 'プルボックスがある場合、設置位置と仕様が記載されているか。該当がない場合はパス', required: false },
      { id: 'power_meter_mokutekichi', group: 'nev', category: 'mokutekichi_specific', label: '電力量計の記載',
        description: '新設電力量計がある場合、設置位置が記載されているか。該当がない場合はパス', required: false },
      { id: 'switch_pole', group: 'nev', category: 'mokutekichi_specific', label: '開閉器ポール/分岐盤の記載',
        description: '開閉器ポールや分岐盤がある場合、位置が記載されているか。該当がない場合はパス', required: false },
      { id: 'existing_route', group: 'nev', category: 'mokutekichi_specific', label: '既設充電設備の配線ルート（該当する場合）',
        description: '既設充電設備がある場合、既設の位置と配線ルートが記載されているか', required: false },
      { id: 'new_existing_distinction', group: 'nev', category: 'mokutekichi_specific', label: '新設/既設の区別',
        description: '新設と既設の充電設備・配線ルートが区別されているか。色分けまたはページ分離。既設がない場合はパス', required: false },

      // ══ マニュアル（配線集計表）══
      { id: 'mc_summary_table', group: 'manual', category: 'manual_summary', label: '配線集計表（統括表）の存在',
        description: '図面内に配線集計表（統括表）が表形式で記載されているか。ケーブル種別ごとに全長・内訳（露出/管内/埋設）・配管種別が記載された表', required: true },
      { id: 'mc_summary_order', group: 'manual', category: 'manual_summary', label: '統括表の記載順序',
        description: '統括表の記載がマニュアル**推奨**順序に従っているのが望ましい（[種別用途][配管種類・口径]の順、露出配管接続→露出配管→埋設配管の順、配管はPFD→HIVE→FEP等の順）。**情報自体の有無は別チェック（mc_summary_table / mc_summary_cable_breakdown）でカバーされる**。本項目は順序のみのスタイル判定であり、必要情報が揃っていれば順序が異なっても fail にせず warn 止まりにすること。任意項目扱い（required: false）', required: false },
      { id: 'mc_summary_cable_breakdown', group: 'manual', category: 'manual_summary', label: 'ケーブル種別ごとの全長・内訳',
        description: '各ケーブル種別（CVT○sq、CV○sq-3C等）について、全長と配線方法別内訳（露出/管内/埋設）の長さ(m)が記載されているか', required: true },
      // ══ マニュアル（配線注記）══
      { id: 'mc_annotation_format', group: 'manual', category: 'manual_annotation', label: '配線注記の4要素記載',
        description: '各区間の配線注記に「ケーブル種別」「配線方法」「管種-管径」「距離(m)」の4要素が全て記載されているか。正解例：「CVT8sq-3C 露出配管 PFD-36 13m」', required: true },
      { id: 'mc_cable_conduit_match', group: 'manual', category: 'manual_annotation', label: 'ケーブルと配管サイズの整合性',
        description: 'ケーブル種別に対して適切な配管サイズが使用されているか。仕様書準拠：CVT8sq-3C→PFD-28/HIVE-28、CVT22sq→PFD-28、CVT38sq→PFD-36等', required: true },
      { id: 'mc_length_unit', group: 'manual', category: 'manual_annotation', label: '距離の単位表記(m)',
        description: '全ての配線距離がm（メートル）単位で統一されているか。mm/cmの混在がないか', required: true },
      // ══ マニュアル（埋設関連）══
      { id: 'mc_burial_hatching', group: 'manual', category: 'manual_burial', label: '埋設ハッチング色の適合性',
        description: '**新設**埋設区間がある場合のみ、ハッチング色がマニュアル準拠か確認。アスファルト=紫色ハッチング、コンクリート=赤色ハッチング、土/砂利=緑色ハッチング。**既設埋設区間のみの場合（既設配管・既設埋設等）はハッチング不要のため pass**。該当区間が一切ない場合も pass。旗上げ注記の文言・ケーブル種別・配線方法に「既設」が含まれる区間は既設埋設として扱い、本チェックの対象外。新設埋設区間が存在しない場合に「ハッチングなし」を理由に warn/fail を返してはならない（過剰指摘の典型パターン）', required: false },
      { id: 'mc_burial_conduit_type', group: 'manual', category: 'manual_burial', label: '埋設配管種別の適合性',
        description: '埋設配管にFEP管またはPFD管が使用されているか。該当がない場合はパス', required: false },
      { id: 'mc_burial_dimension', group: 'manual', category: 'manual_burial', label: '埋設寸法（幅×深さ）の記載',
        description: '埋設（掘削）区間がある場合、埋設寸法（幅・深さ）が記載されているか。※寸法値は現場条件で変わる（公式記入例は「幅400mm×深さ300mm」）。特定値との一致は求めず、幅と深さの数値が記載されていれば pass。埋設区間が無い場合はパス。', required: false },
      // ══ マニュアル（プルボックス）══
      { id: 'mc_pullbox_dimension', group: 'manual', category: 'manual_pullbox', label: 'プルボックス寸法表記(W×H×D)',
        description: 'プルボックスがある場合、W×H×D(mm)の3数値で寸法が記載されているか。正解例：200×200×100、250×250×100、300×300×150等。該当がない場合はパス', required: false },
      { id: 'mc_pullbox_placement', group: 'manual', category: 'manual_pullbox', label: 'プルボックス設置基準の準拠',
        description: 'プルボックスが設置基準に準拠しているか：①3つ目の曲がりに設置、②垂直6m毎・水平30m毎、③分岐点で配管径が変わる箇所。該当がない場合はパス', required: false },
      { id: 'mc_pullbox_size_spec', group: 'manual', category: 'manual_pullbox', label: 'プルボックスサイズの仕様書準拠',
        description: 'プルボックスのサイズが仕様書に準拠しているか。PFD/HIVE28→200×200×100、36→200×200×100、42→250×250×100、54→250×250×100、HIVE70→300×300×200等。該当がない場合はパス', required: false },
      // ══ マニュアル（ケーブルプロテクター）══
      { id: 'mc_cable_protector', group: 'manual', category: 'manual_protector', label: 'ケーブルプロテクターの表記',
        description: 'ケーブルプロテクターがある場合、オレンジ色ハッチングで表示されているか。CP2-60X3MBK基準。該当がない場合はパス', required: false },
      // ══ マニュアル（表記規則）══
      { id: 'mc_new_existing_prefix', group: 'manual', category: 'manual_notation', label: '新設/既設の明確なプレフィックス表記',
        description: '全ての設備ラベルに「新設」または「既設」のプレフィックスが付いているか。例：「新設プルボックス」「既設分電盤」「新設EV充電設備」等。判定は段階的に行う ①全設備にプレフィックス → pass、②一部欠落 + 色分けで識別可能（赤=新設、青=既設）→ pass（色分けで意図が明確）、③全設備プレフィックスなし + 色分けあり → warn（識別は機能するがマニュアル推奨表記から外れる）、④全設備プレフィックスなし + 色分けもなし → fail（識別手段なし）。判定の根拠は、図面上で実際に観察した設備ラベルの文言と配線の色・凡例の有無とする', required: true },
      { id: 'mc_color_coding', group: 'manual', category: 'manual_notation', label: '配線ルートの色分けルール',
        description: '配線ルートの色分けがマニュアル準拠か。期待ルール：新設配線=赤色線、既設配線=青色線、電力会社工事=緑線。判定は段階的に行う ①凡例（記号表）に色分けが定義 + ルート上に色分け視認 → pass、②凡例なしでも2色以上視認 → pass、③凡例ありでも色分け視認できず → warn、④凡例なし + 1色のみ視認 → warn、⑤完全モノクロ（凡例なし・色分け表記なし） → fail。判定の根拠は、図面上で実際に観察した凡例（記号表）と配線ルート線の色とする（色はカラー画像から必ず確認する）', required: true },
      { id: 'mc_vvf_exposure', group: 'manual', category: 'manual_notation', label: 'VVF外部露出配線の禁止',
        description: 'VVF2mm-2CまたはVVF2mm-3Cが外部（屋外）において露出配線（管なし）で使用されていないか。VVFは屋外では必ず管内配線とする。VVFが使用されていない場合はパス', required: false },
      { id: 'mc_cable_excess_length', group: 'manual', category: 'manual_notation', label: 'ケーブル余長の考慮',
        description: '立上げ箇所でケーブル余長が適切に考慮されているか。仕様書：H=6000→4m、H=7000→5m、H=8000→6m、H=9000→7m。該当がない場合はパス', required: false },
    ],
    businessTypeBranch: {
      kiso: ['building_name', 'surrounding_structures', 'utility_work_boundary', 'power_meter_kiso'],
      mokutekichi: ['pull_box', 'power_meter_mokutekichi', 'switch_pole', 'existing_route', 'new_existing_distinction'],
    },
    // 決定論的クロスチェック
    deterministic: [
      // ケーブル⇔配管サイズの適合を仕様表(meta.spec.cableConduitMatch)で検算
      { fn: 'cable_conduit_match', targets: ['mc_cable_conduit_match'],
        requires: { cable_conduit_pairs: '各区間の[ケーブル種別,配管種別]の配列。例:[["CVT8sq-3C","PFD-28"],["CVT100sq","PFD-54"]]。読み取れない場合は空配列' } },
      // 統括表 ⇔ 旗上げ合算 ⇔ 記載寸法 の三者照合（桁違い誤読・読み落とし検出）
      { fn: 'wire_reconcile', targets: ['total_length', 'length_breakdown', 'section_details'],
        requires: {
          wire_table_totals: '統括表(集計表)に記載されたケーブル/配管の全長。[{type:"CVT8sq-3C",total_length_m:13}] の配列。無ければ空配列',
          wire_annotation_sums: '各区間の旗上げ注記の距離を種別ごとに合算した値。[{type:"CVT8sq-3C",total_length_m:13}] の配列。★共入れ表記（例:"CV38sq-2C+IV8sq"）は1本の複合種別にせず、各ケーブル（CV38sq-2C と IV8sq）に分解し、それぞれに同じ距離を計上すること（統括表はケーブル別に記載されるため）。無ければ空配列',
          wire_drawn_lengths: '図面上に記載された寸法値(m)を種別ごとに合算した値。[{type:"CVT8sq-3C",total_length_m:13}] の配列。共入れ表記は同様に各ケーブルへ分解。無ければ空配列',
        } },
    ],
  };

  const reg = (root && root.NevRules) || (typeof require !== 'undefined' ? require('../core/rules-registry.js') : null);
  if (reg && reg.registerRule) reg.registerRule('haisen', rule);
  if (typeof module !== 'undefined' && module.exports) module.exports = rule;

})(typeof window !== 'undefined' ? window : globalThis);
