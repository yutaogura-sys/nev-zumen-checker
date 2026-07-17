/* ============================================================
   rules/mitori.js — 設置場所見取図の要件（単一定義）
   出典: 【設置場所見取図】ツール docs/js/config.js（R6補正ベース）
   R7補正での扱い: 図面記載要件は R6補正から実質変更なし（差分レポート参照）。
     事業区分は kiso（基礎充電）/ mokutekichi（目的地充電）。
     ※ R7補正で道の駅・給油所は経路充電へ統合されたが、本図面ツールは
       従来どおり基礎/目的地を対象とし、経路充電は対象外（既存踏襲）。
   注意: 元config で基礎・目的地に重複していた charging_count は、統合定義では
     一意ID（charging_count_kiso / charging_count_moku）に分離した。
   ============================================================ */
(function (root) {
  'use strict';

  const rule = {
    meta: {
      drawingName: '設置場所見取図',
      sourceYear: 'R7補正',
      sourceDoc: 'R7補正_NeV要件/R7ho/R7h_juden_tenpu_koufu_mitori.pdf, 手引き5章',
      maxPages: 5,
    },
    settings: {
      requiredFailForWarn: 2,
      renderScale: 3.0,
      maxPayloadBytes: 18_000_000,
      maxOutputTokens: 16384,
    },
    prompt: {
      role: 'あなたはNeV補助金（次世代自動車充電インフラ整備促進事業）の「設置場所見取図」の審査エキスパートです。手引き5章の記載要件に基づき、図面PDFを高精度に審査してください。',
      overview: '設置場所見取図は、敷地全体・公道・入口・充電スペース位置・（目的地充電では）案内板を示す広域の図面です。平面図（設備配置の詳細図）とは異なり、施設が公道に接していることや敷地形状・周辺との位置関係を把握するための図です。',
      // 「合格事例の典型パターン」は旧・見取図ツール checker.js の「正解事例から学んだパターン」
      // からの移植（パリティ監査 A-9。few-shot合格事例PDFの代替となるテキスト知識化）。
      guidance: '## この図面の要点\n- 表題欄（通常は右下）の図面名称が正確に「設置場所見取図」であること。\n- 目的地充電では「公道への接道」と「案内板（設置位置・向き・仕様・新設/既設）」が特に重要。案内板は両面=公道に垂直、片面=公道に平行。\n- 基礎充電では建物名称・駐車場収容台数・区画割り・充電スペース数の記載が重要。\n- 充電スペースは赤色ハッチング等で図示。既設は青色等で区別。\n- ※口数上限（目的地=4口等・基礎=収容台数比率）の適合判定は申請書の申告値で審査されるため本チェックの対象外。図面上の台数が明らかに多い場合のみ overall_comment で言及してよい（項目判定には含めない）。\n\n## 合格事例の典型パターン（探索の手がかりに使うこと）\n- 出入口: **▼（赤い三角）マーク**または「出入口」テキストで表示。出入口が複数ある場合は全てに▼が付く（1箇所だけ見つけて終わりにしない）。\n- 施設名/建物名: 図面中央付近に大きく**枠囲み**で表示されることが多い。\n- 充電スペース: 赤色ハッチング（斜線）＋「充電スペース×N」のラベル。既設充電スペースは青色ハッチング＋「既設充電スペース×N」で区別。\n- 案内板（目的地）: **案内板情報は青色テキストで記載されることが多い**（例: 案内板 500×500 両面 既設ポール取付／※既設案内板（両面）流用）。新設/既設・設置方法（新設ポール/既設ポール/壁付）・仕様（片面/両面・サイズ）を注意深く読み取る。\n- 公道（目的地）: 公道は敷地外に描画され、公道名（国道○号線・県道○号・市道○○線等）がテキストで道路上に記載される。\n- 基礎充電: 「○○マンション：収容台数 XX台」の表記が図面上にある。立体駐車場の場合は階数・各階台数の内訳も記載される。出入口は1箇所の場合が多い。案内板は不要。\n- 表題欄: 図面右下。「設置場所」欄に施設名＋「充電設備設置工事」等、「作成者」欄に会社ロゴ＋会社名、縮尺は数値（1/150等）または「-」。\n- 敷地境界線で施設全体の敷地形状を表現し、周辺建物も描画して位置関係を示す。方位記号（N）は右上に表示されることが多い。',
    },
    categories: {
      basic_info:           { title: '①図面基本情報', icon: '&#128203;', order: 1 },
      drawing_content:      { title: '②公道・入口・敷地・充電スペース', icon: '&#128506;', order: 2 },
      kiso_specific:        { title: '基礎充電 固有項目', icon: '&#127970;', order: 3 },
      mokutekichi_specific: { title: '目的地充電 固有項目', icon: '&#127978;', order: 3 },
      signboard:            { title: '④案内板（目的地充電 必須）', icon: '&#129517;', order: 4 },
    },
    checks: [
      // ── 共通（基礎・目的地の両方）──
      { id: 'setting_place', category: 'basic_info', label: '設置場所の記載',
        description: '申請で入力した設置場所名称（略称不可）が表題欄に記載されているか。例）○○モール 充電設備設置工事※申請書で入力した名称との一致（略称不可）は本ツールでは照合できないため判定対象外（記載有無と読取名称の提示のみ）。読み取った名称をdetailに必ず記載し、申請書との一致は人手で確認すること。',
        required: true, critical: true },
      { id: 'removal_equipment_shown', category: 'basic_info', label: '撤去する充電設備の明示（撤去がある場合）', required: false,
        condition: '撤去予定の充電設備がある場合（撤去新設・入替）',
        description: '撤去予定の充電設備がある場合、撤去する充電設備が図面上に示されているか（手引き5-9前文「撤去する充電設備を示してください」）。入替（同一箇所の撤去新設）の場合は現在と入替後の充電スペースの区別、既設・自費設置がある場合はそれぞれの設置場所の区別が確認できること（記入例3/4・4/4頁）。撤去がない案件はna。' },
      { id: 'drawing_name', category: 'basic_info', label: '図面名称「設置場所見取図」の記載',
        description: '図面名称として正確に「設置場所見取図」が表題欄に記載されているか。不備例：設置見取図、設置場所図等は不可',
        required: true, critical: true },
      { id: 'creator', category: 'basic_info', label: '作成者の記載',
        description: '会社名または個人名が表題欄の「作成者」欄に記載されているか', required: true },
      { id: 'scale', category: 'basic_info', label: '縮尺の記載',
        description: '縮尺（例: 1/150）が表題欄に記載されているか。縮尺サイズの指定なし。市販の地図等で縮尺が不明の場合は「-」と記載',
        required: true },
      { id: 'creation_date', category: 'basic_info', label: '作成日の記載',
        description: '作成日が表題欄に記載されているか。読み取った日付をdetailに必ず記載。※手引きの要件「本補助金の事業開始日以降」は、事業開始日が本ツールでは照合できないため人手で確認すること。', required: true },
      { id: 'entrance', category: 'drawing_content', label: '充電設備設置場所の入口',
        description: '充電設備設置場所への入口が全て記載されているか（▼マーク・「出入口」テキスト等）', required: true },
      { id: 'charging_space', category: 'drawing_content', label: '充電スペースの図示',
        description: '充電設備設置場所での充電スペース位置が図示されているか（赤色ハッチング等で明示）',
        required: true, critical: true },
      { id: 'site_shape', category: 'drawing_content', label: '施設全体の敷地形状',
        description: '施設全体の敷地形状が把握できる図面になっているか（敷地境界線等）', required: true },
      { id: 'surrounding', category: 'drawing_content', label: '周辺施設との位置関係',
        description: '施設と周辺の建物・敷地等との位置関係が確認できるか（周辺建物の描画等）', required: true },

      // ── 基礎充電 固有 ──
      { id: 'building_name', category: 'kiso_specific', label: '建物名称の明記',
        description: 'マンション・団地などの建物名称が図中に大きく表示されているか', required: true, critical: true },
      { id: 'parking_capacity', category: 'kiso_specific', label: '収容台数の記載',
        description: '駐車場の収容台数（例: ○○マンション：収容台数 XX台）が図面上に記載されているか', required: true },
      { id: 'charging_count_kiso', category: 'kiso_specific', label: '充電スペース数の記載',
        description: '充電スペースの台数（例: 充電スペース×8）が記載されているか', required: true },
      { id: 'existing_charging_kiso', category: 'kiso_specific', label: '既設充電スペースの表示',
        description: '既設充電設備がある場合、既存の充電スペース場所が区別して表示されているか（該当する場合のみ）',
        required: false },

      // ── 目的地充電 固有 ──
      { id: 'public_road', category: 'drawing_content', label: '公道の記載',
        description: '充電設備設置場所が公道に接していることを担保するために公道が描かれているか。公道名（国道○号線、県道○号、市道○号線等）が記載されているか',
        required: true, critical: true },
      { id: 'road_name', category: 'drawing_content', label: '公道名の記載',
        description: '接している公道の名称（例: 国道××号線、県道○号、市道○○線）がテキストで記載されているか',
        required: true, critical: true },
      { id: 'facility_name', category: 'mokutekichi_specific', label: '施設名称の明記',
        description: '店舗・ホテル・施設の名称が図中に大きく表示されているか', required: true, critical: true },
      { id: 'charging_count_moku', category: 'mokutekichi_specific', label: '充電スペース数の記載',
        description: '充電スペースの台数（例: 充電スペース×4）が記載されているか', required: true },
      { id: 'signboard_position', category: 'signboard', label: '案内板の設置位置',
        description: '案内板が接している公道の入口に設置されていることが図面上で確認できるか（位置が図示されているか）',
        required: true, critical: true },
      { id: 'signboard_direction', category: 'signboard', label: '案内板の向き',
        description: '案内板の向きが確認できるか。両面の場合は公道に対し垂直、片面の場合は公道に対し平行であること',
        required: true },
      { id: 'signboard_spec', category: 'signboard', label: '案内板の設置方法・仕様',
        description: '案内板の設置方法（新設ポール/既設ポール/壁付）と仕様（片面/両面、サイズ 例:500×500）が記載されているか',
        required: true },
      { id: 'signboard_new_existing', category: 'signboard', label: '案内板の新設/既設の区別',
        description: '案内板が新設か既設（流用）かが記載されているか。例）新設案内板、※既設案内板（両面）流用',
        required: true },
      { id: 'existing_charging', category: 'mokutekichi_specific', label: '既設充電スペースの表示',
        description: '既設充電設備がある場合、既設充電スペース位置が区別して図示されているか（青色ハッチング等）',
        required: false },

      // ── P0-5 追加（任意・条件付き。記入例に基づく不足項目の拾い上げ）──
      { id: 'signboard_height', category: 'signboard', label: '案内板の高さ・視認性（ある場合）',
        description: '案内板が公道の上下線から視認できる位置・高さに設置されていることが図示・注記されているか。記入例で明記される要件。案内板がある目的地充電で確認（無ければ na）。',
        required: false, condition: '目的地充電で案内板がある場合' },
      // 4-A（2026-07-09 ユーザー承認で必須化）: 参考PDF（収容台数・区画図）は
      // 「駐車場の収容台数**および区画**（収容台数を確認できる区画の記載）」を対で要求している。
      // 収容台数の総数だけで区画の裏付けが無い図面を合格させない。naAllowed=区画図が構造上
      // 存在しない特殊ケース（機械式で内訳表が別添等）は na 許容し人間確認に回す。
      { id: 'parking_layout', category: 'kiso_specific', label: '駐車場の区画割り・内訳の記載',
        description: '収容台数を確認できる区画割り・内訳（フロア別内訳表、来客用/社有車・従業員用/月極区画 等）が記載されているか。収容台数の合計と区画・内訳が突合できる形が望ましい。区画図が構造上存在しない場合のみ na。',
        required: true, naAllowed: true },
    ],
    businessTypeBranch: {
      kiso: ['building_name', 'parking_capacity', 'charging_count_kiso', 'existing_charging_kiso', 'parking_layout'],
      mokutekichi: ['public_road', 'road_name', 'facility_name', 'charging_count_moku',
        'signboard_position', 'signboard_direction', 'signboard_spec', 'signboard_new_existing', 'existing_charging', 'signboard_height'],
    },
  };

  const reg = (root && root.NevRules) || (typeof require !== 'undefined' ? require('../core/rules-registry.js') : null);
  if (reg && reg.registerRule) reg.registerRule('mitori', rule);
  if (typeof module !== 'undefined' && module.exports) module.exports = rule;

})(typeof window !== 'undefined' ? window : globalThis);
