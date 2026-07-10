/* ============================================================
   rules/keitou.js — 電気系統図の要件（単一定義）
   出典: 【電気系統図】ツール tool/js/checker.js
         （NEV_COMMON_CHECKS / NEV_CONDITIONAL_CHECKS / MANUAL_MOKUTEKICHI_CHECKS /
           MANUAL_KISO_CHECKS / CATEGORIES）。根拠: 手引き 5-9-4「電気系統図」。
   R7補正での扱い: 図面記載要件は R6補正から実質変更なし（差分レポート参照）。
   本図面は判定が2グループ:
     group 'nev'    … NeV交付要件（共通＋条件付き。基礎/目的地で共通）
     group 'manual' … 作図センターマニュアル準拠（基礎/目的地で項目が分岐）
   移植方針:
     ・元は detail フィールド・required フィールドなし → description に写し、
       condition の無い項目を required:true、condition のある項目を required:false とした。
       （条件付き項目はGeminiが na/pass を返す想定。required の厳密な扱いは P4 で回帰検証）
     ・マニュアルは基礎(man_k_*)/目的地(man_m_*)で別項目 → businessTypeBranch で出し分け。
   ============================================================ */
(function (root) {
  'use strict';

  const rule = {
    meta: {
      drawingName: '電気系統図',
      sourceYear: 'R7補正',
      sourceDoc: 'R7補正_NeV要件/R7ho/R7h_juden_tenpu_koufu_keitou.pdf, 手引き5-9-4',
      maxPages: 6,
    },
    settings: { requiredFailForWarn: 2, renderScale: 3.0, maxPayloadBytes: 18_000_000, maxOutputTokens: 32768 },
    prompt: {
      role: 'あなたはNeV補助金（次世代自動車充電インフラ整備促進事業）の「電気系統図」を審査する高精度AIチェッカーです。NeV交付要件（手引き5-9-4）と作図センターマニュアルの両面から審査してください。',
      overview: '電気系統図は、受電元（キュービクル/分電盤/手元開閉器）から各EV充電設備までの電気的な接続を示す単線結線図（概念図）です。縮尺は本来不要（「-」やノンスケールでpass）。配線の色（赤=新設、黒=既設）と接続関係、ブレーカー・電源線・接地を正確に読み取ること。',
      guidance: '## この図面の要点（ブレーカー判定を特に厳格に）\n- 図面名称は正確に「電気系統図」。「配線系統図」「電気配線図」は不可。\n- **ブレーカーは個別に容量(AF/AT)が必須**：シンボルだけで容量数値が無い、AF/ATの片方のみ、はfail。主幹と分岐は別個に評価。\n- メーカー名・型式は表題欄・機器シンボル付近・凡例・機器リスト・注記欄・2ページ目以降まで全領域を探索してから判定する。\n- デマンド制御：主幹ATの定格動作台数（40AT→1台/75AT→2台/100AT→3台/125AT→4台/150AT→5台/200AT→6台/225AT→7台/250AT→8台）を設置台数が超える場合に記載必須。超えない場合はna。\n- 接地種別の大文字小文字（Ec/EC/Ed/ED）は不問。\n\n## ★LB（ロードバランシング）設計の判定（最重要・誤判定防止）\n- デマンドコントロール／ロードバランシング／出力制御の注記がある図面は「LB設計」。LB設計では全充電器が同時に最大出力しない（同時運転台数に制限）。\n- **幹線ケーブル・主幹ブレーカー・接地線の台数別スペック（man_k_cable_count / man_k_main_breaker / man_k_ground の仕様表）は、総設置台数ではなく「同時運転台数（LB制限後の台数）」に対して評価すること。**\n- 例: 8台設置でも同時運転2台のLB設計なら、幹線CVT38sq・主幹125AT・接地IV8sq は2〜3台相当として妥当であり、8台基準（CVT100sq等）を当てはめて fail としてはならない。\n- 同時運転台数が図面に明記されていなくても、LB注記・デマンド制御の存在から同時運転が制限されていると判断できる場合は、その前提で仕様の妥当性を評価し、断定できない部分は fail ではなく warn とする。\n- 同時運転台数（LB制限後）を detected_info.simultaneous_count に、総設置台数を charger_count に、それぞれ読み取って記載すること。\n- 条件に当てはまらない条件付き項目はnaとする。\n\n## 正解事例の系統フロー（旧ツール実績の参考パターン）\n- 目的地充電: 図面左側に既設キュービクル(黒)→幹線(赤)→EV用分電盤(赤)→分岐ブレーカー(赤)→充電設備(赤) の流れで描かれることが多い。\n- 基礎充電: 責任分界点→電力量計→分電盤→制御盤→充電設備 の流れで描かれることが多い。\n- fail/warn の項目では、detail に該当箇所のページ番号とおおよその位置（例:「P1 右下表題欄付近」「P2 機器リスト」）を含めること。記載が見当たらない場合は「該当記載なし」と明記する。',
    },
    categories: {
      // NeV要件判定
      nev_basic_info:   { title: '①図面基本情報',       icon: '&#128203;', order: 1,  group: 'nev' },
      nev_charger_spec: { title: '②充電設備の仕様',     icon: '&#128268;', order: 2,  group: 'nev' },
      nev_power_dist:   { title: '③配電方法',           icon: '&#9889;',   order: 3,  group: 'nev' },
      nev_power_source: { title: '④電源元の仕様',       icon: '&#127981;', order: 4,  group: 'nev' },
      nev_breaker:      { title: '⑤ブレーカーの仕様',   icon: '&#128268;', order: 5,  group: 'nev' },
      nev_cable:        { title: '⑥電源線の仕様',       icon: '&#128220;', order: 6,  group: 'nev' },
      nev_ground:       { title: '⑦接地の仕様',         icon: '&#127760;', order: 7,  group: 'nev' },
      nev_comm:         { title: '⑧通信線',             icon: '&#128225;', order: 8,  group: 'nev' },
      nev_lighting:     { title: '⑨電灯配線',           icon: '&#128161;', order: 9,  group: 'nev' },
      nev_demand:       { title: '⑩デマンド制御',       icon: '&#128202;', order: 10, group: 'nev' },
      nev_existing:     { title: '⑪既存充電設備の系統図', icon: '&#128260;', order: 11, group: 'nev' },
      nev_dedicated:    { title: '専用配線の確認',       icon: '&#128274;', order: 12, group: 'nev' },
      // 作図センターマニュアル判定
      man_basic:      { title: '(A)図面基本情報',        icon: '&#128203;', order: 20, group: 'manual' },
      man_equip:      { title: '(B)充電設備仕様',        icon: '&#128268;', order: 21, group: 'manual' },
      man_panel:      { title: '(C)盤の記載',            icon: '&#128230;', order: 22, group: 'manual' },
      man_cable:      { title: '(D)配線の記載',          icon: '&#128220;', order: 23, group: 'manual' },
      man_breaker:    { title: '(E)ブレーカーの記載',    icon: '&#128268;', order: 24, group: 'manual' },
      man_ground:     { title: '(F)接地の記載',          icon: '&#127760;', order: 25, group: 'manual' },
      man_demand:     { title: '(G)デマンド制御/ローバラ', icon: '&#128202;', order: 26, group: 'manual' },
      man_color:      { title: '(H)色分けルール',        icon: '&#127752;', order: 27, group: 'manual' },
      man_dedicated:  { title: '(I)専用配線・他用途',    icon: '&#128274;', order: 28, group: 'manual' },
      man_annotation: { title: '(J)注記・表記',          icon: '&#128221;', order: 29, group: 'manual' },
      man_existing:   { title: '(K)既設充電設備',        icon: '&#128260;', order: 30, group: 'manual' },
    },
    checks: [
      // ══ NeV 必須（共通）══
      // ── E: critical 付与の選定理由（パリティ監査 D-1 の中間案・2026-07-10 ユーザー承認）──
      // 旧・系統図ツールは「fail 1件で総合不合格」だったが、統合版の requiredFailForWarn=2 では
      // 図面名称誤り＋主幹容量未記載のような明確な2欠陥でも「要確認」止まりになる後退があった。
      // 中間案として、明確に致命的（＝再提出必至・読み取りも比較的容易で誤failしにくい）な
      // 記載コア4項目のみ critical:true を付与。B-guard（確信度low降格を生き延びた確定failのみ
      // 総合「不合格」）が自動で効くため、AI誤読の即不合格化は抑制済み。
      //   付与: nev_title（図面名称。表題欄で明確）/ nev_location（設置場所名称。表題欄クロップ補助あり）/
      //         nev_main_breaker_capacity / nev_branch_breaker_capacity（ブレーカー容量。要件の核心）
      //   非付与の理由: 条件付き項目（過剰指摘リスク）、nev_charger_maker/model（小さな文字で
      //         読み取り困難になりやすい）、nev_breaker_all/nev_dedicated_line（経路解釈の裁量が
      //         大きく誤fail源になりやすい。dedicated_line は共用盤上流の許容パターンが既知）、
      //         manual グループ（社内基準＝参考タブでNeV合否と別扱いのため）。
      { id: 'nev_title', group: 'nev', category: 'nev_basic_info', label: '図面名称が「電気系統図」であること', required: true, critical: true,
        description: '「配線系統図」「電気配線図」等は不可。「電気系統図」と正確に記載されていること。' },
      { id: 'nev_location', group: 'nev', category: 'nev_basic_info', label: '設置場所名称の記載', required: true, critical: true,
        description: '申請で入力した設置場所名称と一致すること（略称不可）。設置場所そのものが確認できること。' },
      { id: 'nev_author', group: 'nev', category: 'nev_basic_info', label: '作成者名の記載', required: true,
        description: '作成者名が記載されていること。' },
      { id: 'nev_scale', group: 'nev', category: 'nev_basic_info', label: '縮尺の記載', required: true,
        description: '電気系統図は配線接続の概念図であり縮尺は本来不要。表題欄に縮尺欄がある場合は「-」（ノンスケール）等の記載があればpass。縮尺欄自体がない場合もpass。実寸を示す縮尺（1/100等）が記載されている場合もpass。' },
      { id: 'nev_date', group: 'nev', category: 'nev_basic_info', label: '作成日の記載', required: true,
        description: '作成日が記載されていること。本補助金の事業開始日以降であること。' },
      { id: 'nev_charger_type', group: 'nev', category: 'nev_charger_spec', label: '充電設備の種類の記載', required: true,
        description: '急速・普通等の種類が記載されていること。' },
      { id: 'nev_charger_maker', group: 'nev', category: 'nev_charger_spec', label: '充電設備のメーカー名の記載', required: true,
        description: 'メーカー名が記載されていること。機器シンボル付近・凡例・機器リスト・注記欄・表題欄・2ページ目以降も含め全領域を確認すること。' },
      { id: 'nev_charger_model', group: 'nev', category: 'nev_charger_spec', label: '充電設備の型式の記載', required: true,
        description: '型式が記載されていること。機器シンボル付近・凡例・機器リスト・注記欄・表題欄・2ページ目以降も含め全領域を確認すること。' },
      { id: 'nev_power_dist', group: 'nev', category: 'nev_power_dist', label: '配電方法の種類の記載', required: true,
        description: '例：1φ3W 100/200V、3φ3W 6.6kV/210V 等。配電方式が明記されていること。' },
      { id: 'nev_power_source', group: 'nev', category: 'nev_power_source', label: '受電元（キュービクル/分電盤/手元開閉器）の図示', required: true,
        description: '受電元のキュービクルや分電盤、手元開閉器が図示されていること。' },
      { id: 'nev_panel_name', group: 'nev', category: 'nev_power_source', label: '盤名称の記載', required: false, condition: '既設盤に盤名称がある場合',
        description: '盤名称がある場合はその名称が記載されていること。無銘板の既設盤等、盤名称が元々存在しない場合は na。' },
      { id: 'nev_breaker_all', group: 'nev', category: 'nev_breaker', label: '充電設備設置工事に伴うブレーカーの全記載', required: true,
        description: '工事に伴う全てのブレーカー（主幹・分岐・上流）が記載されていること。記載漏れがあればfail。' },
      { id: 'nev_breaker_spec', group: 'nev', category: 'nev_breaker', label: 'ブレーカーの仕様（種別）の記載', required: true,
        description: '例：ELB2P2E、MCCB3P3E等の仕様（種別）が全てのブレーカーに個別に記載されていること。1つでも種別が記載されていないブレーカーがあればfail。' },
      { id: 'nev_main_breaker_capacity', group: 'nev', category: 'nev_breaker', label: '主幹ブレーカーの容量（AF/AT）の記載', required: true, critical: true,
        description: '主幹ブレーカーの容量（フレーム/トリップ）が記載されていること。例：150AF/150AT、225AF/225AT等。記載なし、もしくはAF/ATの片方のみの記載はfail。' },
      { id: 'nev_branch_breaker_capacity', group: 'nev', category: 'nev_breaker', label: '分岐ブレーカーの容量（AF/AT）の記載', required: true, critical: true,
        description: '分岐ブレーカー（充電器ごとのブレーカー）全てに容量（AF/AT）が記載されていること。例：20AF/20AT等。1つでも容量未記載のブレーカーがあればfail。' },
      { id: 'nev_breaker_upstream', group: 'nev', category: 'nev_breaker', label: '幹線上流ブレーカー容量の記載', required: true,
        description: '幹線の上流ブレーカー（既存含む）の容量が記載されていること。' },
      { id: 'nev_cable_all', group: 'nev', category: 'nev_cable', label: '充電設備設置工事に伴う電源線の全記載', required: true,
        description: '工事に伴う全ての電源線が記載されていること。' },
      { id: 'nev_cable_type', group: 'nev', category: 'nev_cable', label: '配線の種類の記載', required: true,
        description: '例：CV5.5-3C、CVT100sq等。配線種別が記載されていること。' },
      { id: 'nev_ground_point', group: 'nev', category: 'nev_ground', label: '接地箇所の記載', required: true,
        description: 'どこから接地に配線するのかわかるように記載されていること。' },
      { id: 'nev_ground_class', group: 'nev', category: 'nev_ground', label: '接地種別の記載', required: true,
        description: '例：Ec、Ed、EC、ED等の接地種別が記載されていること。大文字・小文字の表記揺れ（Ed/ED/ed等）はいずれも有効。' },
      { id: 'nev_ground_wire', group: 'nev', category: 'nev_ground', label: 'アース線の記載', required: true,
        description: '例：IV5.5sq等のアース線仕様が記載されていること。' },
      { id: 'nev_dedicated_line', group: 'nev', category: 'nev_dedicated', label: '専用配線であることの確認', required: true,
        description: '電源元から充電設備まで専用配線で結線されていることが確認できること。充電設備の配線経路上に他用途（照明・動力等）が接続されていないこと。※専用ブレーカーより上流の共用分電盤に他負荷が同一図に描かれるのは正規の許容パターンでありfailにしない（判定は配線経路上に限定する）。' },
      // ══ NeV 条件付き ══
      { id: 'nev_breaker_margin', group: 'nev', category: 'nev_breaker', label: '既存分電盤の幹線ブレーカー容量余裕の記載', required: false, condition: '既存分電盤を利用する場合',
        description: '既存分電盤を利用する場合、幹線ブレーカーの容量に余裕があるか記載（例：「幹線ブレーカーの容量に不足はありません」）。容量変更がある場合は変更前→変更後を記載。' },
      { id: 'nev_cable_1c_earth', group: 'nev', category: 'nev_cable', label: '1Cをアースに使用する場合の記載', required: false, condition: '1Cをアースに使用する場合',
        description: '1Cをアースに使用する場合はその旨が記載されていること。' },
      { id: 'nev_comm_line', group: 'nev', category: 'nev_comm', label: '通信線の記載', required: false, condition: '課金機等の別体装置がある場合',
        description: '課金機などの別体装置がある場合の配線が電気系統図に記載されていること。' },
      { id: 'nev_lighting', group: 'nev', category: 'nev_lighting', label: '電灯配線の記載', required: false, condition: '電灯設備がある場合',
        description: '充電設備・充電スペースを照らす電灯の配線がある場合、電気系統図に記載されていること。配線種類、タイマースイッチ等の設置箇所も記載。' },
      { id: 'nev_demand', group: 'nev', category: 'nev_demand', label: 'デマンド制御の記載', required: false, condition: '設置台数が主幹ATの定格動作台数を超える場合',
        description: '主幹ATの定格動作台数（100%出力可能台数）を設置台数が超える場合、デマンドコントロールの記載が必須。定格動作台数: 40AT→1台、75AT→2台、100AT→3台、125AT→4台、150AT→5台、200AT→6台、225AT→7台、250AT→8台。設置台数≦定格動作台数の場合はna。' },
      { id: 'nev_existing_diagram', group: 'nev', category: 'nev_existing', label: '既存充電設備の電気系統図の記載', required: false, condition: '既存充電設備がある場合（増設・撤去新設）',
        description: '既存充電設備がある場合、その現在の電気系統図が記載されていること。' },
      { id: 'nev_transformer', group: 'nev', category: 'nev_power_source', label: '変圧器容量の記載', required: false, condition: '高圧受変電設備の場合',
        description: '高圧受変電設備の場合、変圧器の容量が記載されていること。' },
      { id: 'nev_new_contract', group: 'nev', category: 'nev_power_source', label: '新設分電盤のメーカー名・型式', required: false, condition: '新設分電盤がある場合',
        description: '新設分電盤がある場合、メーカー名と型式が記載されていること。分電盤シンボル付近・凡例・機器リスト・注記欄・2ページ目以降も含め全領域を確認すること。' },

      // ══ マニュアル（目的地 6kW/9.6kW）══
      { id: 'man_m_location', group: 'manual', category: 'man_basic', label: '設置場所 = 施設正式名称 + 普通充電設備設置工事', required: true,
        description: '設置場所欄に「施設正式名称 + 普通充電設備設置工事」と記載されていること。' },
      { id: 'man_m_title', group: 'manual', category: 'man_basic', label: '図面名称 = 「電気系統図」', required: true,
        description: '図面名称が「電気系統図」であること。既設の場合は「既設電気系統図」。' },
      { id: 'man_m_author', group: 'manual', category: 'man_basic', label: '作成者の記載', required: true,
        description: '作成者名が記載されていること（例：○○株式会社、△△電気工事株式会社 等の会社名または個人名）。記載があればpass。' },
      { id: 'man_m_scale', group: 'manual', category: 'man_basic', label: '縮尺欄の記載（参考）', required: false, condition: '表題欄に縮尺欄がある場合（参考項目）',
        description: '電気系統図は概念図のため縮尺は本来不要。表題欄に縮尺欄がある場合は「-」（ノンスケール）の記載が望ましい。縮尺欄がない場合や「-」以外の記載でもna（電気系統図には適用しない要件）。' },
      { id: 'man_m_date', group: 'manual', category: 'man_basic', label: '作成日 = 指定日', required: true,
        description: '作成日が発注元から指定された日付（所定の日付）であること。' },
      { id: 'man_m_equip_spec', group: 'manual', category: 'man_equip', label: '充電設備の仕様（種類・メーカー名・型式）の記載', required: true,
        description: '充電設備の種類（普通）、メーカー名、型式が記載されていること。機器シンボル付近・凡例・機器リスト・注記欄・2ページ目以降も含め全領域を確認すること。' },
      { id: 'man_m_power_type', group: 'manual', category: 'man_equip', label: '配電方法の記載（例：1Φ3W100/200V）', required: true,
        description: '受電方式が記載されていること。' },
      { id: 'man_m_panel_name', group: 'manual', category: 'man_panel', label: '盤名称が配線ルート図と一致', required: true,
        description: '電源盤・分電盤の名称が配線ルート図と一致していること。' },
      { id: 'man_m_cable_type', group: 'manual', category: 'man_cable', label: '電源元から充電設備までの配線種類の記載', required: true,
        description: '例：CVT22sq等、配線種類が記載されていること。' },
      { id: 'man_m_main_breaker_spec', group: 'manual', category: 'man_breaker', label: '主幹ブレーカーの仕様・容量', required: true,
        description: '主幹ブレーカーの種別（例：MCCB3P3E、ELB3P3E等）と容量（例：100AF/75AT、150AF/125AT等）が記載されていること。AF・ATのいずれかが欠けている場合はfail。設置台数に対して容量が不足/過剰の場合もfail。' },
      { id: 'man_m_branch_breaker_capacity', group: 'manual', category: 'man_breaker', label: '分岐ブレーカーの仕様・容量', required: true,
        description: '分岐ブレーカー（子ブレーカー、充電器ごと）全てに種別（例：ELB3P2E）と容量（例：30AF/20AT、50AF/20AT）が記載されていること。1つでも容量未記載のブレーカーがあればfail。シンボルだけで容量数値が無い場合もfail。' },
      { id: 'man_m_ground', group: 'manual', category: 'man_ground', label: '接地の記載（接地線・接地種別・盤内接続）', required: true,
        description: '接地線（例：IV5.5sq）、接地種別（例：ED/Ed/ec等、大文字小文字不問）、盤内での接続が記載されていること。' },
      { id: 'man_m_loadbalance', group: 'manual', category: 'man_demand', label: 'ローバラ注記/デマンドコントロール注記の記載', required: false, condition: '設置台数が主幹ATの定格動作台数を超える場合（出力制御が必要な場合）',
        description: '設置台数が主幹ATの定格動作台数を超える場合（出力制御が必要な場合）、「※デマンドコントロール機能 充電器同時利用で分電盤主幹ブレーカー容量を超える場合、一時的に充電出力を制御する」等の注記が記載されていること。「デマンドコントロール機能」「ロードバランシング」「出力制御」等の表現も許容。設置台数≦定格動作台数の場合（出力制御不要）はna。' },
      { id: 'man_m_new_panel', group: 'manual', category: 'man_panel', label: '新設盤のメーカー名・型式の記載', required: false, condition: '特例引込・新設引込の場合（既設キュービクル案件は対象外）',
        description: '特例引込・新設引込の場合のみ、新設分電盤・電源盤のメーカー名と型式が記載されていること。既設キュービクルからの引込（既設引込）の場合は不要のためna。分電盤シンボル付近・凡例・機器リスト・注記欄・2ページ目以降も含め全領域を確認すること。' },
      { id: 'man_m_capacity_note', group: 'manual', category: 'man_annotation', label: '電気容量確保確認済み注記', required: true,
        description: '「各ブレーカーにおいて、必要な電気容量確保確認済み」の注記が記載されていること。' },
      { id: 'man_m_color_new', group: 'manual', category: 'man_color', label: '新設部分が赤色で記載', required: true,
        description: '新設の盤・ブレーカー・配線・充電設備が赤色で描かれていること。' },
      { id: 'man_m_color_exist', group: 'manual', category: 'man_color', label: '既設部分が黒色で記載', required: true,
        description: '既設のキュービクル・分電盤・ブレーカーが黒色で描かれていること。' },
      { id: 'man_m_spare_breaker', group: 'manual', category: 'man_breaker', label: '既設予備ブレーカー/予備ブレーカーの表記', required: false, condition: '既存電源から取得する場合',
        description: '既存電源から取得する場合、「既設予備ブレーカー」（既設流用）または「予備ブレーカー」（新設）の正しい分類表記がされていること。完全新設専用ラインで既設流用が無い場合は na。' },
      { id: 'man_m_no_mixed', group: 'manual', category: 'man_dedicated', label: '他用途配線が混在していないこと', required: true,
        description: '充電設備専用の配線経路のみであること。他用途（照明・動力等）の機器が充電配線経路上に接続されていないこと。' },
      { id: 'man_m_subsidy_label', group: 'manual', category: 'man_annotation', label: '補助金対象外の適切な表記', required: false, condition: '補助金対象外部分がある場合',
        description: '電力量計、既設予備ブレーカー等の補助金対象外部分に「※補助金対象外」の表記があること（該当する場合）。' },

      // ══ マニュアル（基礎 6kW）══
      { id: 'man_k_location', group: 'manual', category: 'man_basic', label: '設置場所 = 施設正式名称 + 普通充電設備設置工事', required: true,
        description: '設置場所欄に「施設正式名称 + 普通充電設備設置工事」と記載されていること。' },
      { id: 'man_k_title', group: 'manual', category: 'man_basic', label: '図面名称 = 「電気系統図」', required: true,
        description: '図面名称が「電気系統図」であること。既設の場合は「既設電気系統図」。' },
      { id: 'man_k_author', group: 'manual', category: 'man_basic', label: '作成者の記載', required: true,
        description: '作成者名が記載されていること（例：○○株式会社、△△電気工事株式会社 等の会社名または個人名）。記載があればpass。' },
      { id: 'man_k_scale', group: 'manual', category: 'man_basic', label: '縮尺欄の記載（参考）', required: false, condition: '表題欄に縮尺欄がある場合（参考項目）',
        description: '電気系統図は概念図のため縮尺は本来不要。表題欄に縮尺欄がある場合は「A3:1/100」または「-」の記載が望ましい。縮尺欄がない場合でもna（電気系統図には適用しない要件）。' },
      { id: 'man_k_date', group: 'manual', category: 'man_basic', label: '作成日 = 指定日', required: true,
        description: '作成日が発注元から指定された日付（所定の日付）であること。' },
      { id: 'man_k_simultaneous', group: 'manual', category: 'man_demand', label: '同時運転台数の正確性', required: true,
        description: '同時運転台数が正しいこと（1-10台:2台同時、11-15台:3台同時、16-20台:4台同時）。' },
      { id: 'man_k_equip_spec', group: 'manual', category: 'man_equip', label: '充電設備の仕様（種類・メーカー名・型式）の記載', required: true,
        description: '充電設備の種類（普通）、メーカー名、型式が記載されていること。機器シンボル付近・凡例・機器リスト・注記欄・2ページ目以降も含め全領域を確認すること。' },
      { id: 'man_k_power_type', group: 'manual', category: 'man_equip', label: '配電方法の記載（例：1Φ3W100/200V）', required: true,
        description: '受電方式が記載されていること。' },
      { id: 'man_k_panel_name', group: 'manual', category: 'man_panel', label: '盤名称（制御盤含む）が配線ルート図と一致', required: true,
        description: '電源盤・分電盤・制御盤の名称が配線ルート図と一致していること。' },
      { id: 'man_k_cable_count', group: 'manual', category: 'man_cable', label: '幹線・分岐配線が台数に応じた正しい仕様', required: true,
        description: '6kW仕様: 幹線は台数に応じて選定（1-2台:CV8sq-3C、2台LBなし:CVT22sq、3-5台:CVT38sq、5台:CVT60sq、6台以上:CVT100sq）。分岐配線は全構成共通でCV8sq-3C。' },
      { id: 'man_k_main_breaker', group: 'manual', category: 'man_breaker', label: '主幹ブレーカーが台数に応じた正しい容量', required: true,
        description: '6kW仕様: 1-2台(LBなし):50-100AT、2台(LBなし):100AF/75AT、3-5台:100AF/100AT、4台:150AF/125AT、5台:150AF/150AT、6台:225AF/200AT、7台:250AF/225AT。図面上の主幹AT値と仕様表が一致しない場合はfail（findingに「図面値○○AT、仕様表値○○AT」の形で具体的に記載）。AF/ATの片方のみの記載もfail。' },
      { id: 'man_k_branch_breaker', group: 'manual', category: 'man_breaker', label: '分岐ブレーカーの仕様・容量', required: true,
        description: '分岐ブレーカー（子ブレーカー）全てに種別と容量が記載されていること。ELB 3P2E、一面構成:30AF/20AT、二面構成:50AF/20AT。1つでも容量(AF/AT)未記載があればfail。種別と仕様表が異なる場合もfail（findingに具体的な相違内容を記載）。' },
      { id: 'man_k_lb_rule', group: 'manual', category: 'man_demand', label: 'LB（ロードバランシング）設計の適用', required: false, condition: '3台以上の案件の場合',
        description: '3台以上の案件は全てLB（ロードバランシング）設計が必須。LBの有無に応じた配線・ブレーカー仕様が正しいこと。1-2台の場合はLB不要のためna。' },
      { id: 'man_k_ground', group: 'manual', category: 'man_ground', label: '接地の記載（接地種別・接地線）', required: true,
        description: '接地種別（ED/Ed等、大文字小文字不問）と接地線が台数に応じた正しい仕様であること。1-2台:IV5.5sq、3-5台:IV8sq、6台以上:IV14sq。' },
      { id: 'man_k_demand_required', group: 'manual', category: 'man_demand', label: 'デマンドコントロール記載要否の判定', required: true,
        description: '主幹ATの定格動作台数（100%出力可能台数）を超える充電器が接続されている場合、デマンドコントロールの記載が必須。定格動作台数: 40AT→1台、75AT→2台、100AT→3台、125AT→4台、150AT→5台、200AT→6台、225AT→7台、250AT→8台。設置台数が定格動作台数を超える場合にデマンドコントロール注記がなければfail。' },
      { id: 'man_k_demand_note', group: 'manual', category: 'man_demand', label: 'デマンドコントロール注記の記載内容', required: false, condition: 'デマンドコントロールが必要な場合（設置台数＞定格動作台数）',
        description: 'デマンドコントロールが必要な場合、「デマンドコントロール機能により充電出力を制御する」旨の注記と、LB率（出力制限割合）が記載されていること。「デマンドコントロール機能」「ロードバランシング」「出力制御」等の表現も許容。デマンドコントロール不要の場合はna。' },
      { id: 'man_k_new_panel', group: 'manual', category: 'man_panel', label: '新設盤のメーカー名・型式の記載', required: false, condition: '特例引込・新設引込の場合（既設キュービクル案件は対象外）',
        description: '特例引込・新設引込の場合のみ、新設分電盤・電源盤のメーカー名（日東工業等）と型式（OR16-57C等）が記載されていること。既設キュービクルからの引込（既設引込）の場合は不要のためna。分電盤シンボル付近・凡例・機器リスト・注記欄・2ページ目以降も含め全領域を確認すること。' },
      { id: 'man_k_capacity_note', group: 'manual', category: 'man_annotation', label: '電気容量確保確認済み注記', required: true,
        description: '「各ブレーカーにおいて、必要な電気容量確保確認済み」の注記が記載されていること。' },
      { id: 'man_k_color_new', group: 'manual', category: 'man_color', label: '新設部分が赤色で記載', required: true,
        description: '新設の盤・ブレーカー・配線・充電設備が赤色で描かれていること。' },
      { id: 'man_k_color_exist', group: 'manual', category: 'man_color', label: '既設部分が黒色で記載', required: true,
        description: '既設のキュービクル・分電盤・ブレーカーが黒色で描かれていること。' },
      { id: 'man_k_spare_breaker', group: 'manual', category: 'man_breaker', label: '既設予備ブレーカー/予備ブレーカーの表記', required: false, condition: '既存電源から取得する場合',
        description: '既存電源から取得する場合、正しい分類（既設予備ブレーカー/予備ブレーカー/空ブレーカー）の表記がされていること。完全新設専用ラインで既設流用が無い場合は na。' },
      { id: 'man_k_no_mixed', group: 'manual', category: 'man_dedicated', label: '他用途配線が混在していないこと', required: true,
        description: '充電設備専用の配線経路のみであること。' },
      { id: 'man_k_existing', group: 'manual', category: 'man_existing', label: '既設充電設備がある場合の電気系統図', required: false, condition: '既設充電設備がある場合',
        description: '既設充電設備がある場合、「既設電気系統図」として別ページに記載されていること。' },
      { id: 'man_k_subsidy_label', group: 'manual', category: 'man_annotation', label: '補助金対象外の適切な表記', required: false, condition: '補助金対象外部分がある場合',
        description: '電力量計、既設予備ブレーカー等の補助金対象外部分に適切な表記があること。' },
    ],
    businessTypeBranch: {
      // マニュアル判定は基礎/目的地で項目が分岐。NeV共通・条件付きは両区分に適用。
      kiso: ['man_k_location', 'man_k_title', 'man_k_author', 'man_k_scale', 'man_k_date', 'man_k_simultaneous',
        'man_k_equip_spec', 'man_k_power_type', 'man_k_panel_name', 'man_k_cable_count', 'man_k_main_breaker',
        'man_k_branch_breaker', 'man_k_lb_rule', 'man_k_ground', 'man_k_demand_required', 'man_k_demand_note',
        'man_k_new_panel', 'man_k_capacity_note', 'man_k_color_new', 'man_k_color_exist', 'man_k_spare_breaker',
        'man_k_no_mixed', 'man_k_existing', 'man_k_subsidy_label'],
      mokutekichi: ['man_m_location', 'man_m_title', 'man_m_author', 'man_m_scale', 'man_m_date', 'man_m_equip_spec',
        'man_m_power_type', 'man_m_panel_name', 'man_m_cable_type', 'man_m_main_breaker_spec', 'man_m_branch_breaker_capacity',
        'man_m_ground', 'man_m_loadbalance', 'man_m_new_panel', 'man_m_capacity_note', 'man_m_color_new',
        'man_m_color_exist', 'man_m_spare_breaker', 'man_m_no_mixed', 'man_m_subsidy_label'],
    },
    // 決定論的クロスチェック
    deterministic: [
      // 主幹ATの定格動作台数と設置台数からデマンド制御要否を機械判定
      { fn: 'demand_rated_count',
        targets: ['nev_demand', 'man_k_demand_required', 'man_m_loadbalance'],
        requires: {
          main_breaker_at: '主幹ブレーカー（充電負荷の直上の分電盤主幹。多段系統では充電回路群を束ねる盤の主幹）のトリップ値(AT)を数値で。例:100。読み取れない場合は空',
          charger_count: '設置する充電器の総台数を数値で。例:4。読み取れない場合は空',
          simultaneous_count: 'LB(ロードバランシング)設計時の同時運転台数を数値で。LBが無ければ総台数と同値。読み取れない場合は空',
        } },
      // 台数（LB時は同時運転台数）に対する主幹ATの充足照合（D-2復元・LB対応。不足の可能性のみwarn）
      { fn: 'main_at_per_count',
        targets: ['man_k_main_breaker', 'man_m_main_breaker_spec'],
        requires: {
          main_breaker_at: '主幹ブレーカー（充電負荷の直上の分電盤主幹。多段系統では充電回路群を束ねる盤の主幹）のトリップ値(AT)を数値で。例:100。読み取れない場合は空',
          charger_count: '設置する充電器の総台数を数値で。例:4。読み取れない場合は空',
          simultaneous_count: 'LB(ロードバランシング)設計時の同時運転台数を数値で。LBが無ければ総台数と同値。読み取れない場合は空',
        } },
      // 分岐ブレーカーAT ≤ 主幹AT の整合（超過はwarn）
      { fn: 'branch_le_main',
        targets: ['nev_branch_breaker_capacity'],
        requires: {
          branch_breaker_ats: '各分岐ブレーカーのトリップ値(AT)を数値配列で。例:[20,20,30]。読み取れない場合は空配列',
        } },
      // 主幹 AF(フレーム) ≥ AT(トリップ) の不変則（AF<ATはあり得ない→warn）
      { fn: 'main_af_ge_at',
        targets: ['nev_main_breaker_capacity'],
        requires: {
          main_breaker_af: '主幹ブレーカーのフレーム値(AF)を数値で。例:100。読み取れない場合は空',
        } },
    ],
  };

  const reg = (root && root.NevRules) || (typeof require !== 'undefined' ? require('../core/rules-registry.js') : null);
  if (reg && reg.registerRule) reg.registerRule('keitou', rule);
  if (typeof module !== 'undefined' && module.exports) module.exports = rule;

})(typeof window !== 'undefined' ? window : globalThis);
