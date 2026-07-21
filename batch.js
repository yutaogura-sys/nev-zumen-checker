/* ============================================================
   batch.js — 案件まとめモードのオーケストレーション
   1案件の複数図面を順に判定し、図面別サマリ＋図面間の整合性（crosscheck）を表示。
   core/rules は個別チェックと共通。APIキーは localStorage を index.html と共有。
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const esc = NevUtil.escapeHtml;

  const CAP_KEY = 'nev_cost_cap_jpy';
  const savedCap = parseFloat(localStorage.getItem(CAP_KEY));
  const capTracker = new NevCost.CapTracker({ capJpy: isNaN(savedCap) ? 300 : savedCap, warnRatio: 0.8 });

  const state = { apiKey: '', model: 'gemini-2.5-flash', businessType: 'kiso', files: {} };
  const TYPES = NevRules.listTypes(); // [{type,label}]

  // ── APIキー（index.htmlと共有）──
  const savedKey = localStorage.getItem('nev_api_key');
  if (savedKey) { $('apiKeyInput').value = savedKey; state.apiKey = savedKey; $('saveApiKey').checked = true; }
  $('apiKeyInput').addEventListener('input', e => {
    state.apiKey = e.target.value.trim();
    // 保存チェックON中はキーの入力・貼り替え・消去を即時反映（app.jsと同一の順序非依存化）
    if ($('saveApiKey').checked) {
      if (state.apiKey) localStorage.setItem('nev_api_key', state.apiKey);
      else localStorage.removeItem('nev_api_key');
    }
    updateRun();
  });
  $('toggleApiKey').addEventListener('click', () => { const i = $('apiKeyInput'); i.type = i.type === 'password' ? 'text' : 'password'; });
  $('saveApiKey').addEventListener('change', e => { if (e.target.checked && state.apiKey) localStorage.setItem('nev_api_key', state.apiKey); else localStorage.removeItem('nev_api_key'); });
  // 消去ボタン: 入力欄・state・保存キー・チェックを一括クリア（app.jsと同一）
  $('clearApiKey').addEventListener('click', () => {
    $('apiKeyInput').value = ''; state.apiKey = '';
    localStorage.removeItem('nev_api_key');
    $('saveApiKey').checked = false;
    updateRun();
  });
  document.querySelectorAll('input[name="geminiModel"]').forEach(r => r.addEventListener('change', e => { state.model = e.target.value; }));
  $('bizSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.businessType = b.dataset.bt; document.querySelectorAll('#bizSeg button').forEach(x => x.classList.toggle('active', x === b)); });

  // ── アップロードスロット（図面種別ごと）──
  function buildSlots() {
    const wrap = $('slots'); wrap.innerHTML = '';
    TYPES.forEach(d => {
      const box = document.createElement('div');
      box.style.cssText = 'flex:1 1 200px;border:2px dashed var(--line);border-radius:10px;padding:12px;text-align:center;';
      box.innerHTML = `<div style="font-weight:700;font-size:14px;">${esc(d.label)}</div>
        <label class="btn btn-secondary btn-sm" style="margin-top:8px;display:inline-block;">PDF選択<input type="file" accept=".pdf" hidden data-type="${d.type}"></label>
        <div class="file-name" data-name="${d.type}" style="font-size:12px;margin-top:6px;color:var(--muted);">未選択</div>`;
      wrap.appendChild(box);
    });
    wrap.querySelectorAll('input[type=file]').forEach(inp => {
      inp.addEventListener('change', e => {
        if (running) { alert('チェック実行中はファイルを変更できません。キャンセルするか完了を待ってください。'); e.target.value = ''; return; }
        const t = e.target.dataset.type; const f = e.target.files[0];
        if (f) { state.files[t] = f; wrap.querySelector(`[data-name="${t}"]`).textContent = f.name; }
        updateRun();
      });
    });
  }

  function updateRun() {
    const n = Object.keys(state.files).length;
    const ready = state.apiKey && n >= 1;
    $('runBtn').disabled = !ready || running; // 実行中はファイル変更等で再有効化しない
    $('runNote').textContent = running ? '実行中…' : (ready ? `${n}枚の図面をチェックします` : 'APIキーと1枚以上の図面を設定してください');
    renderCostBar($('costBar'));
  }

  function renderCostBar(el) {
    if (!el) return;
    const s = capTracker.getState(); const msg = capTracker.getMessage();
    el.className = 'cost-bar' + (s.status === 'over' ? ' over' : s.status === 'warn' ? ' warn' : '');
    el.style.display = 'flex';
    // 波④-4: 累計は月別（月替わりで自動リセット）＝「今月の累計」と表示
    el.innerHTML = `<span>${msg ? esc(msg.text) : `今月の累計: 約 ${s.totalJpy.toLocaleString()} 円`} <a href="#" class="cost-reset" style="margin-left:8px;font-size:12px;">今月の累計をリセット</a></span>` +
      `<span>上限 <input type="number" min="0" step="50" class="cost-cap-input" value="${s.capJpy || 0}"> 円/月（0=無制限）</span>`;
    const ci = el.querySelector('.cost-cap-input');
    if (ci) ci.addEventListener('change', e => { const v = parseFloat(e.target.value) || 0; capTracker.setCap(v); localStorage.setItem(CAP_KEY, String(v)); renderCostBar($('costBar')); renderCostBar($('costBarResult')); });
    const rst = el.querySelector('.cost-reset');
    if (rst) rst.addEventListener('click', e => { e.preventDefault(); capTracker.reset(); renderCostBar($('costBar')); renderCostBar($('costBarResult')); });
  }

  // ── 1図面を判定 → { verdict(groups), detected_info } ──
  //   signal: AbortSignal（波④-3: 実行キャンセル。undefined なら従来どおり）
  function root_colorsanity() { return (typeof NevColorSanity !== 'undefined') ? NevColorSanity : null; }
  async function checkOne(type, file, signal) {
    const rule = NevRules.getRule(type);
    let input;
    // preferImages（配線ルート図＝色分けが判定要素）は最初からカラー画像化（app.jsと同一ポリシー）
    try {
      if (rule.settings.preferImages) throw new Error('preferImages');
      input = await NevPdf.pdfToNative(file, { maxNativeBase64: rule.settings.maxPayloadBytes });
    }
    catch (e) { input = await NevPdf.pdfToImages(file, { maxPages: rule.meta.maxPages, renderScale: rule.settings.renderScale, maxPayloadBytes: rule.settings.maxPayloadBytes }); }
    const crop = await NevPdf.pdfToTitleBlockCrop(file).catch(() => null);
    if (crop) input.images = input.images.concat([crop]);
    // 第2波: 配線ルート図の2パス（個別チェックとの精度パリティ。トグルで無効化可）
    const useTwoPass = !!(rule.settings.twoPass && $('twoPassHaisen') && $('twoPassHaisen').checked);
    let pass1Data = null;
    if (useTwoPass) {
      $('loadingText').textContent = `${rule.meta.drawingName}: 2段階読み取り 1/2（データ抽出）...`;
      try {
        const p1 = await NevGemini.callGeminiWithRetry(state.apiKey, input.images, NevPrompt.buildPass1Prompt(rule, state.businessType), state.model,
          info => { if (info && info.message) $('loadingText').textContent = `${rule.meta.drawingName}: ${info.message}`; }, { pass: 1, total: 2 },
          { maxOutputTokens: rule.settings.maxOutputTokens, signal });
        const c1 = NevCost.estimateCost(p1._usageMetadata, p1._model);
        if (c1) capTracker.addCost(c1);
        pass1Data = (p1 && p1.detected_info && typeof p1.detected_info === 'object' && !Array.isArray(p1.detected_info)) ? p1.detected_info : null; // C-1: 型崩れPass1を採用しない
      } catch (e1) {
        if (e1 && e1.usageMetadata) { const c = NevCost.estimateCost(e1.usageMetadata, state.model); if (c) capTracker.addCost(c); }
        if (e1 && e1.type === 'aborted') throw e1;
        pass1Data = null; // Pass1失敗は1パスへフォールバック（安全側＝従来挙動）
      }
    }
    const promptText = (useTwoPass && pass1Data)
      ? NevPrompt.buildPass2Prompt(rule, state.businessType, pass1Data)
      : NevPrompt.buildPrompt(rule, state.businessType);
    const result = await NevGemini.callGeminiWithRetry(state.apiKey, input.images, promptText, state.model, info => { if (info && info.message) $('loadingText').textContent = `${rule.meta.drawingName}: ${info.message}`; }, { pass: useTwoPass && pass1Data ? 2 : 1, total: useTwoPass && pass1Data ? 2 : 1 }, { maxOutputTokens: rule.settings.maxOutputTokens, signal });
    const cost = NevCost.estimateCost(result._usageMetadata, result._model);
    if (cost) capTracker.addCost(cost);
    if (useTwoPass && pass1Data) {
      // Pass1が抽出の単一情報源（app.jsと同一ポリシー。echo由来の_disputedFieldsは削除=F-5）
      result.detected_info = Object.assign({}, result.detected_info || {}, pass1Data);
      delete result.detected_info._disputedFields;
      result._twoPass = true;
      if (root_colorsanity()) root_colorsanity().apply(result); // 色観測サニティ（fail→warnのみ）
    }

    // グループ別集計（3-A: 結線は core/verdict.js の単一実装を使用）
    const groupAggs = NevVerdict.computeGroupAggs(rule, result, state.businessType);
    // FZ-1: ページ切り捨て(truncated)を戻り値に含め、結果表示で警告できるようにする
    return { type, rule, groupAggs, detectedInfo: result.detected_info || {}, truncated: !!input.truncated, twoPass: !!(useTwoPass && pass1Data), twoPassDegraded: !!(useTwoPass && !pass1Data), ts: new Date().toISOString(), fileName: file && file.name || '' };
  }

  // ── 実行 ──
  $('runBtn').addEventListener('click', run);
  $('recheckBtn').addEventListener('click', () => { $('resultSection').style.display = 'none'; $('errorSection').innerHTML = ''; window.scrollTo({ top: 0, behavior: 'smooth' }); });
  // 波④-3: 実行キャンセル（AbortController）。中断しても判定済みの図面は捨てず部分表示する。
  let abortCtrl = null;
  let running = false; // 実行中の再入・二重実行防止（実行中のファイル変更でrunBtnが再有効化されるのを防ぐ）
  $('cancelBtn').addEventListener('click', () => {
    if (!abortCtrl) return;
    abortCtrl.abort();
    $('cancelBtn').disabled = true;
    $('cancelBtn').textContent = 'キャンセル中...';
  });

  async function run() {
    if (running) return; // 二重実行防止（並走すると二重課金・キャンセル不能化・結果の相互上書きが起きる）
    const st = capTracker.getState();
    if (st.status === 'over' && !confirm(`料金上限を ${st.overageJpy.toLocaleString()} 円 オーバーしています。続行しますか？`)) return;
    running = true;
    $('errorSection').innerHTML = ''; $('resultSection').style.display = 'none';
    $('loadingSection').style.display = 'block'; $('runBtn').disabled = true;
    abortCtrl = new AbortController();
    $('cancelBtn').disabled = false;
    $('cancelBtn').innerHTML = '&#10005; キャンセル';

    const entries = Object.keys(state.files); // types
    const done = [];
    const errors = [];
    try {
    // 各図面を個別に try/catch。1枚が失敗しても他の（課金済み）結果を捨てず部分表示する。
    for (const type of entries) {
      // M2: 図面ループ途中でも上限超過をチェック（超過したまま残り図面へ課金継続しない・組織要件）
      if ((done.length + errors.length) > 0 && capTracker.getState().status === 'over') {
        errors.push({ type, message: '料金上限を超過したため以降の図面をスキップしました' });
        continue;
      }
      $('loadingText').textContent = `${NevRules.getRule(type).meta.drawingName} を解析中...`;
      try {
        done.push(await checkOne(type, state.files[type], abortCtrl.signal));
      } catch (err) {
        // FZ-5: 失敗経路（MAX_TOKENS/パース失敗）でも課金は発生 → usageがあれば計上
        if (err && err.usageMetadata) { const c = NevCost.estimateCost(err.usageMetadata, state.model); if (c) capTracker.addCost(c); }
        // 波④-3: キャンセル → 以降の図面を中止。判定済み（課金済み）の図面は捨てず部分表示。
        if (err && err.type === 'aborted') {
          errors.push({ type, message: 'キャンセルしました（実行済み・送信済みの呼び出し分は課金されます）' });
          break;
        }
        errors.push({ type, message: err && err.message || String(err) });
      }
    }
    // B-2: キャンセル等で中断した場合、未着手の図面を「未実行」として明示する
    //（無言スキップだと未検査の図面を検査済みと誤読しうる）
    entries.filter(t => !done.some(d => d.type === t) && !errors.some(er => er.type === t))
      .forEach(t => errors.push({ type: t, message: 'キャンセルにより未実行（この図面は判定されていません）' }));
    } finally {
      abortCtrl = null;
      running = false;
      $('loadingSection').style.display = 'none'; $('runBtn').disabled = false; updateRun();
    }

    if (errors.length) {
      $('errorSection').innerHTML = `<div class="error-card"><strong>一部の図面でエラー（他は結果を表示します）</strong>` +
        errors.map(e => `<p>${esc(NevRules.getRule(e.type).meta.drawingName)}: ${esc(e.message)}</p>`).join('') + `</div>`;
    }
    if (done.length) renderResults(done, errors);
    else if (!errors.length) $('errorSection').innerHTML = `<div class="error-card"><p>チェック対象がありませんでした。</p></div>`;
  }

  // 第2波: 案件まとめの記録パリティ — Excel出力（図面別＋図面間整合）
  let lastDone = null;
  let lastRunErrors = []; // R-1: エラー・キャンセル・未実行の図面もExcel記録に含める
  $('batchExcelBtn').addEventListener('click', () => {
    if (typeof XLSX === 'undefined') { alert('Excel出力ライブラリが読み込まれていません。ページを再読み込みしてください。'); return; }
    if (!lastDone) { alert('先にまとめチェックを実行してください。'); return; }
    const STJP = { pass: '合格', warn: '要確認', fail: '不合格', na: '非該当' };
    const wb = XLSX.utils.book_new();
    // シート1: 案件サマリ＋図面間整合
    const byType = {}; lastDone.forEach(d => { byType[d.type] = { detectedInfo: d.detectedInfo }; });
    const findings = NevCrossCheck.crossCheck(byType);
    const rowsS = [
      ['NeV 案件まとめチェック 判定記録'],
      ['判定日時', lastDone.length ? new Date(lastDone[0].ts).toLocaleString('ja-JP') : '', '事業区分', state.businessType === 'kiso' ? '基礎充電' : '目的地充電'],
      ['注記', 'AIによる一次判定＋人手確認の記録。最終判断は目視確認済みが前提。人手確認の記録は個別チェック（単票）で実施。'],
      [],
      ['図面', 'ファイル', '読み取り方式', 'グループ', '総合判定', '必須合格', '重大不備'],
    ];
    lastDone.forEach(d => {
      d.groupAggs.forEach(ga => {
        rowsS.push([d.rule.meta.drawingName, d.fileName, d.twoPass ? '2段階' : '1回', ga.group === 'manual' ? '旧社内基準（R6・参考）' : 'NeV要件', STJP[ga.agg.overall] || ga.agg.overall, `${ga.agg.requiredPass}/${ga.agg.requiredTotal}`, ga.agg.criticalFail || 0]);
      });
    });
    // R-1: エラー・キャンセル・未実行の図面を「未判定」として明記（無言欠落＝記録の虚偽を防ぐ）
    lastRunErrors.forEach(er => {
      const nm = (NevRules.getRule(er.type) || { meta: { drawingName: er.type } }).meta.drawingName;
      rowsS.push([nm, '', '—', '未判定', '未判定', '—', '—']);
      rowsS.push(['', '', '', '理由', er.message || '', '', '']);
    });
    if (lastRunErrors.length) {
      rowsS.push(['注記', `⚠ ${lastRunErrors.length}件の図面が未判定です。この記録は案件全図面の判定ではありません。`]);
    }
    rowsS.push([]);
    rowsS.push(['図面間の整合性チェック' + (lastRunErrors.length ? '（判定済みの図面のみで実施＝未判定図面は含まれていません）' : '')]);
    rowsS.push(['項目', '判定', '詳細', '各図面の値']);
    findings.forEach(f => {
      rowsS.push([f.label, STJP[f.status] || f.status, f.detail || '', f.values.map(v => `${v.label}:${v.raw != null && String(v.raw).trim() ? v.raw : '（未記載）'}`).join(' ／ ')]);
    });
    const wsS = XLSX.utils.aoa_to_sheet(rowsS);
    wsS['!cols'] = [{ wch: 16 }, { wch: 28 }, { wch: 10 }, { wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, wsS, '案件サマリ');
    // シート2〜: 図面別明細
    lastDone.forEach(d => {
      const rows = [[`${d.rule.meta.drawingName}（${d.fileName}）`, d.twoPass ? '2段階読み取り' : '1回読み取り'], [],
        ['グループ', '項目', '必須/任意', '判定', '検出内容', '詳細']];
      d.groupAggs.forEach(ga => {
        ga.agg.items.forEach(i => {
          rows.push([ga.group === 'manual' ? '旧社内基準（R6・参考）' : 'NeV要件', i.label || i.id, i.required ? '必須' : '任意', STJP[i.status] || i.status, i.found_text || '', i.detail || '']);
        });
      });
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 16 }, { wch: 34 }, { wch: 8 }, { wch: 8 }, { wch: 30 }, { wch: 50 }];
      const nm = d.rule.meta.drawingName.replace(/[\\/:*?\[\]]/g, '').slice(0, 28);
      XLSX.utils.book_append_sheet(wb, ws, nm || d.type);
    });
    const dt = new Date();
    const stamp = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}_${String(dt.getHours()).padStart(2, '0')}${String(dt.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `NeV案件まとめ判定_${stamp}.xlsx`);
  });

  function statusPill(s) {
    const lbl = { pass: '合格', fail: '不合格', warn: '要確認', na: '非該当' }[s] || s;
    return `<span class="status-pill ${s}">${lbl}</span>`;
  }

  function renderResults(done, runErrors) {
    lastDone = done; // Excel出力（記録パリティ）用に保持
    lastRunErrors = Array.isArray(runErrors) ? runErrors : [];
    // 図面間クロスチェック
    const byType = {}; done.forEach(d => { byType[d.type] = { detectedInfo: d.detectedInfo }; });
    const findings = NevCrossCheck.crossCheck(byType);
    const summary = NevCrossCheck.summarize(findings);
    const sumLabel = { pass: '整合', warn: '要確認', fail: '不整合あり', na: '判定対象なし' }[summary] || summary;

    let cross = `<div class="overall-result ${summary === 'na' ? 'warn' : summary}">案件整合性: ${sumLabel}</div>`;
    if (findings.length) {
      cross += findings.map(f => {
        const vals = f.values.map(v => `${esc(v.label)}: ${esc(v.raw != null && String(v.raw).trim() ? String(v.raw) : '（未記載）')}`).join(' ／ ');
        return `<div class="check-item">${statusPill(f.status)}<div class="check-main"><div class="c-label">${esc(f.label)}</div><div class="c-detail">${esc(f.detail)}</div><div class="c-found">${vals}</div></div></div>`;
      }).join('');
    } else {
      cross += '<p class="card-description">整合性を比較できる項目がありません（図面が1枚のみ等）。</p>';
    }
    $('crossSection').innerHTML = `<h3 style="font-size:15px;">&#128279; 図面間の整合性チェック</h3>${cross}`;

    // 図面別サマリ（3-C: 個別チェックと同等の品質保証UI＝根拠・重点確認チップ・明細を表示）
    const STL = { pass: '合格', fail: '不合格', warn: '要確認', na: '非該当' };
    $('perDrawing').innerHTML = done.map(d => {
      const groups = d.groupAggs.map(ga => {
        // 4-D: 作図センターマニュアル群は社内基準＝NeV合否とは別（参考）であることを明示
        const glabel = ga.group === 'manual' ? '旧・作図センター基準（R6旧マニュアル・参考／不合格断定なし）' : 'NeV要件';
        return `${statusPill(ga.agg.overall)} ${glabel}（必須 ${ga.agg.requiredPass}/${ga.agg.requiredTotal}${ga.agg.totalNa ? '・非該当' + ga.agg.totalNa : ''}${ga.agg.criticalFail ? '・重大不備' + ga.agg.criticalFail : ''}）`;
      }).join('　');
      // 重点確認チップ（fail/warn/確信度低/必須na/根拠未提示/自動検算未実施）
      const all = [].concat(...d.groupAggs.map(ga => ga.agg.items));
      const chip = (n, label, cls) => n ? `<span class="chip ${cls || ''}" style="display:inline-block;padding:1px 8px;border-radius:999px;background:#f1f5f9;border:1px solid #cbd5e1;font-size:11px;margin-right:4px;">${label} ${n}</span>` : '';
      const chips = chip(all.filter(i => i.status === 'fail').length, '不合格', 'fail')
        + chip(all.filter(i => i.status === 'warn').length, '要確認', 'warn')
        + chip(all.filter(i => i.confidence === 'low').length, '確信度低')
        + chip(all.filter(i => i.required && i.status === 'na').length, '必須が非該当')
        + chip(all.filter(i => /根拠未提示/.test(i.detail || '')).length, '根拠未提示')
        + chip(all.filter(i => /自動検算未実施|自動検算保留/.test(i.detail || '')).length, '自動検算なし');
      // FZ-1: ページ切り捨て警告（app.jsと同等の安全表示）
      const degraded = d.twoPassDegraded ? '<div class="c-detail" style="color:#92400e;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:4px 8px;margin:4px 0;">⚠ 2段階読み取りの抽出パスに失敗したため、この図面は1回読み（簡易）で判定しています。個別チェックでの再実行を推奨します。</div>' : '';
      const trunc = d.truncated ? '<div class="c-detail" style="color:#92400e;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:4px 8px;margin:4px 0;">⚠ 一部ページ未読み込み：PDFが大きく一部ページを解析できていません。未読ページは判定に含まれません。必ず目視確認してください。</div>' : '';
      // 明細（fail/warn/必須na のみ展開表示。全passでも件数を明示）
      const attention = all.filter(i => i.status === 'fail' || i.status === 'warn' || (i.required && i.status === 'na'));
      const detailRows = attention.map(i =>
        `<div class="check-item">${statusPill(i.status)}<div class="check-main"><div class="c-label">${esc(i.label || i.id)}${i.required ? '' : '<span class="opt-tag">任意</span>'}</div>${i.found_text ? `<div class="c-found">検出: ${esc(i.found_text)}</div>` : ''}${i.detail ? `<div class="c-detail">${esc(i.detail)}</div>` : ''}</div></div>`).join('');
      const details = attention.length
        ? `<details style="margin-top:6px;"><summary style="cursor:pointer;font-size:12px;">要確認・不合格の明細（${attention.length}件）を表示</summary>${detailRows}</details>`
        : '<div class="c-found" style="color:var(--pass,#2c7a52);">指摘なし（それでも最終目視を推奨）</div>';
      const di = d.detectedInfo;
      const info = [di.facility_name && `施設:${di.facility_name}`, di.charging_count && `台数:${di.charging_count}`, di.creator && `作成:${di.creator}`].filter(Boolean).join(' / ');
      return `<div class="cat-block"><h4 class="cat-title">${esc(d.rule.meta.drawingName)}</h4><div style="margin-bottom:4px;">${groups}</div>${degraded}${trunc}<div style="margin:4px 0;">${chips}</div><div class="c-found">${esc(info)}</div>${details}</div>`;
    }).join('') + '<p class="card-description" style="margin-top:8px;">※本結果はAI一次チェックです。合否の最終判断は必ず個別チェック（トップページ）での根拠確認と目視で行ってください。</p>';

    renderCostBar($('costBarResult'));
    $('resultSection').style.display = 'block';
    window.scrollTo({ top: $('resultSection').offsetTop - 20, behavior: 'smooth' });
  }

  buildSlots();
  // pdf.js（CDN）の読み込み失敗を明示する（index側と同じガード。放置すると無関係なエラー文言に化ける）
  if (typeof window.pdfjsLib === 'undefined' || !window.pdfjsLib) {
    $('errorSection').innerHTML += '<div class="error-card"><strong>⚠ PDF処理ライブラリ（pdf.js）の読み込みに失敗しました</strong><p>ネットワーク接続（CDNへのアクセス）を確認して、ページを再読み込みしてください。このままではPDFを処理できません。</p></div>';
    document.querySelectorAll('input[type=file]').forEach(i => { i.disabled = true; });
  }
  updateRun();
});
