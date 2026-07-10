/* ============================================================
   core/deterministic.js — 決定論的クロスチェック（AI抽出値をコードで再検証）
   目的: 桁違い誤読や仕様表との不整合を、AIの自己申告に依存せずコードで機械検証する。
     旧・平面図/電気系統図ツールが持っていた強みを統合版に復活させる。
   方式: プロンプトが detected_info に数値を出力（rule.deterministic[].requires で要求）→
     本モジュールが数値を検証 → 対象チェック項目の status/detail を上書きする。
   rule 側の宣言例:
     deterministic: [
       { fn: 'space_width_2500', targets: ['space_width_check'],
         requires: { charging_space_widths_mm: '各充電スペースの幅(mm)の配列。例:[2500,2500]' } },
     ]
   ブラウザ / Node 両対応（DOM非依存）。
   ============================================================ */
(function (root) {
  'use strict';

  // 主幹AT → 100%出力可能な充電台数（定格動作台数）。手引き/マニュアル準拠。
  const DEMAND_RATED_COUNT = { 40: 1, 75: 2, 100: 3, 125: 4, 150: 5, 200: 6, 225: 7, 250: 8 };

  // カンマは桁区切り（2,500=2500）として扱う。要素間の区切りは 、;/空白 とする。
  const parseOne = s => parseFloat(String(s).replace(/,/g, '').replace(/[^\d.]/g, ''));
  function toNumArray(v) {
    if (Array.isArray(v)) return v.map(parseOne).filter(n => !isNaN(n));
    if (v == null) return [];
    // "2500 2500" や "幅2,500mm" のような文字列にも対応（カンマで分割しない）
    return String(v).split(/[、;；\/\s]+/).map(parseOne).filter(n => !isNaN(n));
  }
  function toNum(v) {
    if (v == null) return null;
    const n = parseOne(v);
    return isNaN(n) ? null : n;
  }
  // 主幹AT値以下で最大の定格テーブルキーに対応する台数を返す
  function ratedCountFor(at) {
    const keys = Object.keys(DEMAND_RATED_COUNT).map(Number).sort((a, b) => a - b);
    let count = null;
    for (const k of keys) { if (at >= k) count = DEMAND_RATED_COUNT[k]; }
    return count;
  }

  const registry = {
    // 平面図: 充電スペース幅 2.5m(2500mm)以上
    // 承認済み事例（既存マンション等）に2.4m幅が実在するため、未満は fail ではなく warn（要確認）とする。
    // 機械的に不合格にせず、人間の最終判断に委ねる（過剰指摘の防止）。
    space_width_2500(di) {
      const widths = toNumArray(di && di.charging_space_widths_mm);
      if (!widths.length) return { unfired: true }; // 抽出できなければ検算不能 → 目視喚起の注記（P0-4/⑤）
      // N4: 0mm も「2500未満」に含める（0はOCR/抽出失敗の典型値。0を除外すると[2500,0]が合格する）
      const under = widths.filter(w => w < 2500);
      if (under.length) {
        return { status: 'warn', detail: `【自動再検証】幅 ${under.join(',')}mm が2500mm未満です（読取値: ${widths.join(',')}mm）。2.5m未満のため要確認（既存マンション等では認められる場合あり）。` };
      }
      // F3: 全幅は2500mm以上だが、読み取れた幅の数が区画数(charging_count)より少ない＝一部区画の幅を未検証。
      //     部分抽出のまま「合格」にすると、未読区画に2.5m未満があっても見逃す（false PASS）。→ 要確認に。
      const expected = toNum(di && di.charging_count);
      if (expected != null && expected > widths.length) {
        return { status: 'warn', detail: `【自動再検証】読み取れた${widths.length}区画の幅（${widths.join(',')}mm）は全て2500mm以上ですが、充電スペースは${expected}区画あり、残り${expected - widths.length}区画分の幅を確認できませんでした。未確認区画の幅を目視確認してください。` };
      }
      return { status: 'pass', detail: `【自動再検証】全${widths.length}スペースの幅が2500mm以上（${widths.join(',')}mm）。` };
    },

    // 電気系統図: 主幹ATの定格動作台数と「同時運転台数」の関係からデマンド制御要否を機械判定
    // ★重要（誤判定防止）: LB(ロードバランシング)設計では総設置台数ではなく同時運転台数で評価する。
    //   例）8台設置・同時運転2台で主幹が2台分をまかなえるなら、デマンド制御は非該当(na)が正しい。
    // ★安全設計: このチェックは「安全網」であり最終判定者ではない。決定論で強制的に fail にはしない
    //   （最大でも warn=要確認）。矛盾の可能性は人間の目視確認に委ねる（false fail を出さない）。
    demand_rated_count(di, ctx) {
      const at = toNum(di && di.main_breaker_at);
      // P0-3: charger_count 未取得時は共通フィールド charging_count にフォールバック（サイレントスキップ防止）
      const total = toNum(di && (di.charger_count != null && String(di.charger_count).trim() !== '' ? di.charger_count : di.charging_count));
      const simul = toNum(di && di.simultaneous_count);
      // 主幹ATと、台数(同時 or 総数)の少なくとも一方が無ければ検算不能 → 目視喚起の注記（⑤）
      if (at == null || (total == null && simul == null)) return { unfired: true };
      const rated = ratedCountFor(at);
      if (rated == null) {
        return { unfired: true, detail: `【自動検算未実施】主幹${at}AT が定格動作台数テーブルの範囲外のため、デマンド制御要否の自動検算をスキップしました。目視確認してください。` };
      }
      // LB設計では同時運転台数で評価。simulが有効ならそれを優先、無ければ総設置台数で保守的に評価。
      const effective = (simul != null) ? simul : total;
      const lbNote = (simul != null && total != null && simul !== total) ? `（同時運転${simul}台/総設置${total}台）` : '';
      const cur = ctx && ctx.currentStatus;
      const required = effective > rated;
      if (required) {
        // デマンド制御(またはLB等の抑制)が必要な可能性。na と判定されていても強制failにはせず warn で矛盾を提示。
        if (cur === 'na') {
          return { status: 'warn', detail: `【自動再検証】主幹${at}AT(定格${rated}台) < 同時運転${effective}台${lbNote} → デマンド制御/LB等の記載が必要な可能性があります。非該当(na)と判定されていますが、抑制措置の記載有無を目視確認してください。` };
        }
        return { status: cur || 'warn', detail: `【自動再検証】主幹${at}AT(定格${rated}台) < 同時運転${effective}台${lbNote} → デマンド制御/LB等の記載が必須です。` };
      }
      // 不要（同時運転 ≤ 定格）。AIの fail は過剰指摘の可能性 → na（非該当）へ緩和。
      if (cur === 'fail') {
        return { status: 'na', detail: `【自動再検証】主幹${at}AT(定格${rated}台) ≥ 同時運転${effective}台${lbNote} → デマンド制御は不要（非該当）。` };
      }
      return { status: cur || 'na', detail: `【自動再検証】主幹${at}AT(定格${rated}台) ≥ 同時運転${effective}台${lbNote} → デマンド制御不要。` };
    },

    // 配線ルート図: ケーブル種別に対する配管サイズの適合を仕様表(rule.meta.spec.cableConduitMatch)で照合
    // AIが各区間の[ケーブル,配管]対を cable_conduit_pairs に抽出 → コードが検算。不適合は warn（要確認）。
    cable_conduit_match(di, ctx) {
      const spec = ctx && ctx.rule && ctx.rule.meta && ctx.rule.meta.spec && ctx.rule.meta.spec.cableConduitMatch;
      if (!spec) return null; // 仕様表そのものが未定義 → 真の非該当（注記も不要）
      const pairs = (di && di.cable_conduit_pairs) || [];
      if (!Array.isArray(pairs) || pairs.length === 0) return { unfired: true }; // ケーブル⇔配管の対を抽出できず検算不能 → 注記（⑤）
      const norm = s => String(s == null ? '' : s).replace(/\s+/g, '').replace(/[−–—]/g, '-').toUpperCase();
      // 仕様表を正規化キーで引けるように
      const specNorm = {};
      Object.keys(spec).forEach(k => { specNorm[norm(k)] = spec[k].map(norm); });
      // 辞書補正（旧ツールの復元）: OCRの1文字誤読（PFP→PFD等）を editDistance1 で救済。
      // 補正は「不適合の誤warn防止」方向にのみ働く（補正しても一致しなければ従来どおりwarn）。
      const ed1 = (root.NevUtil && root.NevUtil.editDistance1)
        || (typeof require !== 'undefined' ? (function () { try { return require('./util.js').editDistance1; } catch (e) { return null; } })() : null);
      const corrections = [];
      const correct = (s, candidates) => {
        if (!ed1 || !s) return s;
        if (candidates.includes(s)) return s;
        const hit = candidates.find(c => ed1(s, c) === 1);
        if (hit) { corrections.push(`${s}→${hit}`); return hit; }
        return s;
      };
      const mismatches = [];
      let checked = 0;
      pairs.forEach(p => {
        if (p == null) return; // null要素でTypeErrorにしない
        let cable = norm(Array.isArray(p) ? p[0] : p.cable);
        let conduit = norm(Array.isArray(p) ? p[1] : p.conduit);
        if (!cable || !conduit) return;
        cable = correct(cable, Object.keys(specNorm));
        const allowed = specNorm[cable];
        if (!allowed) return; // 仕様表に無いケーブルは検算対象外
        checked++;
        conduit = correct(conduit, allowed);
        if (!allowed.includes(conduit)) {
          mismatches.push(`${cable}→${conduit}（適合: ${allowed.join('/')}）`);
        }
      });
      const corrNote = corrections.length ? `（表記補正: ${corrections.join(', ')}＝1文字差の誤読とみなし補正）` : '';
      if (checked === 0) return null;
      if (mismatches.length) {
        return { status: 'warn', detail: `【自動再検証】ケーブルと配管サイズの不適合の可能性: ${mismatches.join(', ')}。要確認。${corrNote}※仕様表は作図センターマニュアル原本で未検証のため、原本と要突合。` };
      }
      // 2-B: 仕様表（cableConduitMatch）は作図センターマニュアル原本で未検証（P0-7保留中）。
      // 未検証の表で「合格」を確定させない＝一致は参考情報の注記に留める（不適合の警告のみ維持）。
      return { unfired: true, detail: `【自動検算・参考】ケーブル⇔配管サイズは手持ちの仕様表に適合（${checked}区間照合）。${corrNote}ただし仕様表が原本未検証のため合格判定には用いません。目視確認してください。` };
    },

    // 電気系統図: 台数（LB時は同時運転台数）に対する主幹ATの充足をコード照合（D-2の復元・LB対応版）
    // 旧・電気系統図ツールの台数別仕様表コード照合のうち、手引き準拠のAT表（DEMAND_RATED_COUNT）で
    // 検証できる部分のみ復元。不足の可能性→warn（締め方向のみ）。充足は参考注記（passは付与しない＝
    // 幹線ケーブル・接地線など他要素の妥当性はこの表では保証できないため）。
    main_at_per_count(di, ctx) {
      const at = toNum(di && di.main_breaker_at);
      const total = toNum(di && (di.charger_count != null && String(di.charger_count).trim() !== '' ? di.charger_count : di.charging_count));
      const simul = toNum(di && di.simultaneous_count);
      if (at == null || (total == null && simul == null)) return { unfired: true };
      const effective = (simul != null) ? simul : total;
      const lbNote = (simul != null && total != null && simul !== total) ? `（同時運転${simul}台/総設置${total}台）` : '';
      // effective台を100%運転できる最小AT（表の昇順で最初に rated>=effective となるキー）
      const keys = Object.keys(DEMAND_RATED_COUNT).map(Number).sort((a, b) => a - b);
      const minKey = keys.find(k => DEMAND_RATED_COUNT[k] >= effective);
      if (minKey == null) {
        return { unfired: true, detail: `【自動検算未実施】台数${effective}台が定格動作台数テーブルの範囲外（最大8台）のため、主幹AT充足の自動検算をスキップしました。目視確認してください。` };
      }
      if (at < minKey) {
        return { status: 'warn', detail: `【自動再検証】主幹${at}AT は ${effective}台${lbNote}の同時100%運転に必要な ${minKey}AT を下回る可能性があります。デマンド制御/LBの有無と併せて容量の妥当性を目視確認してください。` };
      }
      return { unfired: true, detail: `【自動検算・参考】主幹${at}AT ≥ ${effective}台${lbNote}に必要な${minKey}AT（手引き定格表）。幹線・接地線等の仕様妥当性は別途目視確認してください。` };
    },

    // 電気系統図: 分岐ブレーカーの容量(AT)が主幹ATを超えていないかの整合チェック（warn限定）
    // 分岐が主幹より大きいのは通常あり得ない構成 → 読み違い/設計不整合の可能性を要確認で提示。
    // ※誤検出リスクの低い明快な整合のみ。深い許容電流検算は測定後に慎重導入。
    branch_le_main(di) {
      const mainAt = toNum(di && di.main_breaker_at);
      const branches = toNumArray(di && di.branch_breaker_ats);
      if (mainAt == null || !branches.length) return { unfired: true }; // 主幹AT/分岐AT未抽出 → 検算不能の注記（⑤）
      const over = branches.filter(b => b > mainAt);
      if (over.length) {
        return { status: 'warn', detail: `【自動再検証】分岐ブレーカー ${over.join(',')}AT が主幹 ${mainAt}AT を超過。構成の読み違い/不整合の可能性→要確認。` };
      }
      return { status: 'pass', detail: `【自動再検証】全分岐ブレーカー(${branches.join(',')}AT)が主幹 ${mainAt}AT 以下で整合。` };
    },

    // 電気系統図: 主幹ブレーカーの AF(フレーム) ≥ AT(トリップ) の不変則チェック（warn限定）
    // AF<AT は物理的にあり得ない → AIの桁違い/AF・AT取り違え読みの検出。要確認で提示。
    main_af_ge_at(di) {
      const af = toNum(di && di.main_breaker_af);
      const at = toNum(di && di.main_breaker_at);
      if (af == null || at == null) return { unfired: true }; // AF/AT の一方でも未抽出なら検算不能の注記（⑤）
      if (af < at) {
        return { status: 'warn', detail: `【自動再検証】主幹 AF ${af} < AT ${at}（フレーム容量がトリップ容量未満はあり得ない）。読み取り誤り/取り違えの可能性→要確認。` };
      }
      return { status: 'pass', detail: `【自動再検証】主幹 AF ${af} ≥ AT ${at} で整合。` };
    },

    // 配線ルート図: 統括表 ⇔ 旗上げ合算 ⇔ 記載寸法 の三者照合（桁違い誤読・読み落とし検出）
    // B（旧 recalcWire/ConduitFromAnnotations の復元）: 旗上げ一覧(di.wire_annotations)が
    // 取れている場合は、AIの自己申告合算(wire_annotation_sums)ではなく**コードで**種別別に
    // 合算した値を 'annotation' 系統として使う。AIが合算を誤ると三者照合の全系統が同じ誤りを
    // 含み得るため、コード合算を独立検算にする（旧ツールで実証済みの安全網）。
    // ※wire_annotations は表示専用抽出（extraDetectedInfo）のため多数決の割れ検出対象外。
    //   ここでの利用は「慎重側にしか動かない」wire_reconcile（trustLoosenなし）に限る＝P1適合。
    wire_reconcile(di, ctx) {
      const R = (typeof root !== 'undefined' && root.NevReconcile) || (typeof require !== 'undefined' ? require('./reconcile.js') : null);
      if (!R || !R.reconcile) return null;
      // 種別キーの正規化（reconcile.js の norm と同基準）
      const normType = s => String(s == null ? '' : s).replace(/\s+/g, '').replace(/[×xＸ]/gi, 'x').replace(/[ー−–—]/g, '-').toUpperCase();
      const annList = Array.isArray(di && di.wire_annotations) ? di.wire_annotations.filter(a => a && typeof a === 'object') : [];
      let annotationSource = Array.isArray(di && di.wire_annotation_sums) ? di.wire_annotation_sums : [];
      let annAggNote = '';
      // ── ケーブル側のコード合算（1件=1ケーブルに分解済み前提。プロンプト仕様） ──
      // 種別ごとの累算は reconcile.indexBy が行うため、ここでは1件ずつ渡す（'+'残存もindexByが分解）。
      const cableEntries = [];
      annList.forEach(a => {
        const len = toNum(a.length_m);
        const cable = String(a.cable == null ? (a.type == null ? '' : a.type) : a.cable).trim();
        if (!cable || len == null) return;
        cableEntries.push({ type: cable, total_length_m: len });
      });
      if (cableEntries.length) {
        // ── 配管側のコード合算（統括表の配管行と照合できる形で） ──
        // 統括表/記載寸法に現れる配管種別のみ照合対象に加える（統括表に配管行が無い図面で
        // 「旗上げにのみ記載」の過剰warnを出さないための限定）。
        // 共入れ（1本の配管に複数ケーブル）は分解済み一覧では同一配管が複数件に重複するため、
        // note の「共入れN」で物理長に按分する（旧 recalcConduitFromAnnotations の
        // shared_conduit_count 相当）。本数不明の共入れは按分不能→その配管種別は照合から除外。
        const tableDrawnTypes = new Set();
        [di && di.wire_table_totals, di && di.wire_drawn_lengths].forEach(arr => {
          (Array.isArray(arr) ? arr : []).forEach(it => {
            if (!it || it.type == null) return;
            String(it.type).split('+').forEach(p => { const k = normType(p); if (k) tableDrawnTypes.add(k); });
          });
        });
        const conduitSums = {};
        const conduitDisplay = {};
        const conduitUncertain = new Set();
        annList.forEach(a => {
          const len = toNum(a.length_m);
          const conduit = String(a.conduit == null ? '' : a.conduit).trim();
          if (!conduit || len == null) return;
          const k = normType(conduit);
          if (!tableDrawnTypes.has(k)) return;
          const noteStr = String(a.note == null ? '' : a.note);
          let share = 1;
          if (/共入れ/.test(noteStr)) {
            const m = noteStr.match(/共入れ\s*(\d+)/);
            if (m) share = Math.max(1, parseInt(m[1], 10));
            else { conduitUncertain.add(k); return; }
          }
          conduitSums[k] = (conduitSums[k] || 0) + len / share;
          if (!conduitDisplay[k]) conduitDisplay[k] = conduit;
        });
        const conduitEntries = Object.keys(conduitSums)
          .filter(k => !conduitUncertain.has(k))
          .map(k => ({ type: conduitDisplay[k], total_length_m: Math.round(conduitSums[k] * 10) / 10 }));
        annotationSource = cableEntries.concat(conduitEntries);
        annAggNote = ` ※旗上げ合算はコード集計（旗上げ${cableEntries.length}件${conduitEntries.length ? '・配管' + conduitEntries.length + '種別' : ''}。AI申告値より優先）。`;
      }
      const sources = {
        table: Array.isArray(di && di.wire_table_totals) ? di.wire_table_totals : [],
        annotation: annotationSource,
        drawn: Array.isArray(di && di.wire_drawn_lengths) ? di.wire_drawn_lengths : [],
      };
      const presentSources = ['table', 'annotation', 'drawn'].filter(k => Array.isArray(sources[k]) && sources[k].length);
      if (presentSources.length < 2) {
        // 2系統未満は三者照合が成立しない → 検算不能の注記（⑤）。統括表のみ等でも目視確認を促す。
        return { unfired: true, detail: '【自動検算未実施】配線数値が2系統以上（統括表/旗上げ合算/記載寸法のうち2つ）抽出できず、三者照合をスキップしました。目視確認してください。' };
      }
      const res = R.reconcile(sources);
      if (!res.discrepancies.length) {
        return { status: 'pass', detail: `【自動再検証】配線数値の三者照合に不整合なし（${res.checkedTypes}種別）。${annAggNote}`.trim() };
      }
      const items = res.discrepancies.slice(0, 5).map(d => {
        const v = d.values;
        const fmt = x => x == null ? '—' : x + 'm';
        return `${d.type}[統括${fmt(v.table)}/旗上げ${fmt(v.annotation)}/寸法${fmt(v.drawn)}]:${d.note}`;
      });
      return { status: 'warn', detail: `【自動再検証】配線数値の三者照合で不整合: ${items.join(' / ')}${annAggNote}` };
    },
  };

  // ── P1 安全網の単調性 ─────────────────────────────────
  // 決定論チェックはAI判定を「慎重側(pass→warn→fail)」へは常に動かせるが、
  // 「緩い側(fail/warn→pass/na)」へ動かせるのは、検算スコープがチェック項目の要件と
  // 完全一致すると宣言された fn（trustLoosen）のみ。サブセット検算（例: wire_reconcile は
  // 長さ照合のみ＝記載要件全体を保証しない）の pass が広い必須項目を合格化する false PASS を禁止する。
  registry.space_width_2500.trustLoosen = true;   // 対象チェック＝「幅2500mm以上」そのもの
  registry.demand_rated_count.trustLoosen = true; // 対象チェック＝「デマンド要否」そのもの（LB込み）
  const SEVERITY = { pass: 0, na: 0, warn: 1, fail: 2 };
  const _normSt = s => String(s == null ? '' : s).trim().toLowerCase();

  // rule.deterministic を実行し、{ checkId: {status, detail} } の上書き指示を返す
  //   rawResultsById: 現在の項目ステータス参照用（任意）
  //   P0-4/⑤: 検算不能（必要数値の未抽出/不足）は { unfired:true } → noteOnly 注記に変換。
  //   N2/N3: detected_info._disputedFields（多数決で割れた読取値）に必要数値が含まれる場合は
  //          検算保留（緩めも締めもしない）。割れた値からの確定は誤判定の温床。
  function run(rule, detectedInfo, rawResultsById) {
    const dets = (rule && rule.deterministic) || [];
    const overrides = {};
    const disputed = Array.isArray(detectedInfo && detectedInfo._disputedFields) ? detectedInfo._disputedFields : [];
    dets.forEach(d => {
      const fn = registry[d.fn];
      if (!fn) return;
      const reqKeys = Object.keys(d.requires || {});
      const disputedReq = reqKeys.filter(k => disputed.indexOf(k) >= 0);
      (d.targets || []).forEach(id => {
        // FA-A: AIが 'NA'/'Pass' 等を返しても矯正が素通りしないよう正規化（aggregate.jsと同基準）
        const curRaw = rawResultsById && rawResultsById[id] ? rawResultsById[id].status : undefined;
        const ctx = { currentStatus: curRaw == null ? undefined : _normSt(curRaw), rule };
        if (disputedReq.length) {
          if (!overrides[id] || overrides[id].noteOnly) {
            overrides[id] = { fn: d.fn, noteOnly: true, detail: `【自動検算保留】読取値（${disputedReq.join('/')}）が判定回間で一致しなかったため、コード検算を保留しました。図面の該当数値を目視確認してください。` };
          }
          return;
        }
        const r = fn(detectedInfo, ctx);
        if (!r) return; // null = 真の非該当（上書きも注記もしない）
        if (r.unfired) {
          // 検算不能 → 目視喚起の注記のみ（既に他fnで実体上書き済みなら触れない）
          if (!overrides[id] || overrides[id].noteOnly) {
            const detail = r.detail || `【自動検算未実施】必要な数値（${reqKeys.join('/')}）を図面から抽出できず、コードによる自動検算をスキップしました。AI判定のみのため目視確認してください。`;
            overrides[id] = { fn: d.fn, noteOnly: true, detail };
          }
          return;
        }
        overrides[id] = { fn: d.fn, status: r.status, detail: r.detail };
      });
    });
    return overrides;
  }

  // 上書きを rawResults 配列にマージ（集計前に適用する想定）
  //   noteOnly の上書きは status を変えず detail に注記を追記（対象項目がAI結果に存在する場合のみ）。
  //   P1: 緩め方向（現状より深刻度が下がる）の上書きは trustLoosen fn のみ許可。それ以外は注記化。
  //   N6: AI未回答の項目へは status を注入しない（既定fail＝安全側を維持）。
  function apply(rawResults, overrides) {
    const arr = Array.isArray(rawResults) ? rawResults.slice() : [];
    const byId = {};
    arr.forEach((r, i) => { if (r && r.id != null) byId[r.id] = i; });
    Object.keys(overrides).forEach(id => {
      const ov = overrides[id];
      if (byId[id] == null) return; // N6: 未回答項目への注入禁止（noteOnly含む）
      const cur = arr[byId[id]];
      if (ov.noteOnly) {
        arr[byId[id]] = Object.assign({}, cur, { detail: ((cur.detail || '') + ' ' + ov.detail).trim(), _deterministicNote: ov.fn });
        return;
      }
      const curSev = SEVERITY[_normSt(cur.status)] != null ? SEVERITY[_normSt(cur.status)] : 1;
      const ovSev = SEVERITY[_normSt(ov.status)] != null ? SEVERITY[_normSt(ov.status)] : 1;
      // B-2旧来対策: 検算結果がAI判定と「同status」のエコー上書きには _deterministic を付けない。
      // スタンプは根拠必須・確信度lowの両ゲートを外す強い信頼マークであり、status を変えていない
      // エコー（例: wire_reconcile の pass が AI の pass に重なる）に付けると、AIの無根拠passが
      // コード検算の権威でゲートを素通りする（2パス化でPass1抽出が単発になった今、especially危険）。
      if (_normSt(ov.status) === _normSt(cur.status)) {
        arr[byId[id]] = Object.assign({}, cur, {
          detail: ((cur.detail || '') + ' 【自動検算・同判定】' + (ov.detail || '')).trim(),
          _deterministicNote: ov.fn,
        });
        return;
      }
      const loosening = ovSev < curSev;
      const fnDef = registry[ov.fn];
      if (loosening && !(fnDef && fnDef.trustLoosen)) {
        // 緩め禁止: AI判定を維持し、検算結果は参考注記として残す（監査可能に）
        arr[byId[id]] = Object.assign({}, cur, {
          detail: ((cur.detail || '') + ' 【自動検算(参考・判定には未使用)】' + (ov.detail || '')).trim(),
          _deterministicNote: ov.fn,
        });
        return;
      }
      arr[byId[id]] = Object.assign({}, cur, { status: ov.status, detail: ov.detail, _deterministic: ov.fn });
    });
    return arr;
  }

  // rule.deterministic から、プロンプトで detected_info に要求する数値フィールドを集める
  function requiredFields(rule) {
    const out = {};
    ((rule && rule.deterministic) || []).forEach(d => {
      if (d.requires) Object.assign(out, d.requires);
    });
    return out;
  }

  const api = { DEMAND_RATED_COUNT, ratedCountFor, registry, run, apply, requiredFields };
  root.NevDeterministic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
