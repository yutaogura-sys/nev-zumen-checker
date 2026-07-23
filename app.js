/* ============================================================
   app.js — 統合UIのオーケストレーション
   core/* と rules/* を束ね、実行→プロンプト生成→Gemini→集計→表示を制御する。
   料金上限の警告・超過表示（組織方針）を CapTracker で実装。
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const esc = NevUtil.escapeHtml;

  // 料金上限（円）。localStorageに保持。0=上限なし。既定は300円（運用時に調整可）。
  const CAP_KEY = 'nev_cost_cap_jpy';
  const savedCap = parseFloat(localStorage.getItem(CAP_KEY));
  const capTracker = new NevCost.CapTracker({
    capJpy: isNaN(savedCap) ? 300 : savedCap,
    warnRatio: 0.8,
  });

  const state = {
    apiKey: '',
    model: 'gemini-2.5-flash',
    drawingType: null,
    businessType: 'kiso',
    precision: 'normal', // 'normal'=1回 / 'high'=3回多数決 / 'crossmodel'=Flash+Pro一致
    file: null,
    overrides: {}, // 人手オーバーライド: `${groupIdx}:${checkId}` -> 'pass'|'warn'|'fail'|'na'
    // D: 多ページPDFのページ選択（総ページ数が図面種別の maxPages を超えるときのみ使用）
    pageCount: 0,      // アップロードPDFの総ページ数
    pageThumbs: null,  // サムネイル [{pageNumber,dataUrl}]（先頭 maxThumbs ページ分）
    selectedPages: null, // 選択ページ番号（昇順）。null=未使用（従来挙動）
  };

  // ── 図面種別タブを rules から生成 ──
  const tabIcons = { mitori: '&#128506;', heimen: '&#128207;', haisen: '&#128268;', keitou: '&#9889;' };
  const tabDesc = { mitori: '敷地・公道・入口・案内板', heimen: '設備配置・充電スペース寸法', haisen: '配線経路・電線/配管', keitou: '単線結線・ブレーカー' };
  function buildDrawingTabs() {
    const wrap = $('drawingTabs');
    wrap.innerHTML = '';
    NevRules.listTypes().forEach((d, i) => {
      const btn = document.createElement('button');
      btn.className = 'tab-btn' + (i === 0 ? ' active' : '');
      btn.dataset.type = d.type;
      btn.innerHTML = `<div class="t-icon">${tabIcons[d.type] || '&#128203;'}</div><div class="t-label">${esc(d.label)}</div><div class="t-desc">${esc(tabDesc[d.type] || '')}</div>`;
      btn.addEventListener('click', () => selectDrawing(d.type));
      wrap.appendChild(btn);
      if (i === 0) state.drawingType = d.type;
    });
  }
  function selectDrawing(type) {
    if (running) { alert('チェック実行中は図面種別を変更できません。キャンセルするか完了を待ってください。'); return; }
    state.drawingType = type;
    document.querySelectorAll('#drawingTabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
    buildPageSelect(); // D: 図面種別で maxPages が変わる（5/6）ため選択UIを再評価
    updateCheckButton();
  }

  // ── 事業区分セグメント ──
  $('bizSeg').addEventListener('click', e => {
    if (running) { alert('チェック実行中は事業区分を変更できません。キャンセルするか完了を待ってください。'); return; }
    const btn = e.target.closest('button'); if (!btn) return;
    state.businessType = btn.dataset.bt;
    document.querySelectorAll('#bizSeg button').forEach(b => b.classList.toggle('active', b === btn));
  });
  $('precSeg').addEventListener('click', e => {
    if (running) { alert('チェック実行中は精度モードを変更できません。キャンセルするか完了を待ってください。'); return; }
    const btn = e.target.closest('button'); if (!btn) return;
    state.precision = btn.dataset.pr;
    document.querySelectorAll('#precSeg button').forEach(b => b.classList.toggle('active', b === btn));
  });

  // ── APIキー ──
  $('apiKeyInput').addEventListener('input', e => {
    state.apiKey = e.target.value.trim();
    // 保存チェックON中はキーの入力・貼り替え・消去を即時反映（「チェック→貼り付け」の順でも保存されるように。
    // 旧実装はチェック変更時と接続テスト成功時しか保存せず、順序次第でリロード時にキーが消えていた）
    if ($('saveApiKey').checked) {
      if (state.apiKey) localStorage.setItem('nev_api_key', state.apiKey);
      else localStorage.removeItem('nev_api_key');
    }
    // F-3: キーが変わったら旧キーのモデル利用可否は無効（別キーの結果で「利用可能」と誤表示しない）
    modelAvailability = null; renderModelAvailability();
    const badge = $('apiKeyStatus'); if (badge.textContent) { badge.textContent = ''; badge.className = 'status-badge'; }
    updateCheckButton();
  });
  $('toggleApiKey').addEventListener('click', () => {
    const inp = $('apiKeyInput'); inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  document.querySelectorAll('input[name="geminiModel"]').forEach(r => {
    r.addEventListener('change', e => {
      state.model = e.target.value;
      refreshSelectedModelBadge(); // 利用可否が判明済みなら、選択モデルに応じてバッジを更新
    });
  });
  const savedKey = localStorage.getItem('nev_api_key');
  if (savedKey) { $('apiKeyInput').value = savedKey; state.apiKey = savedKey; $('saveApiKey').checked = true; }
  $('saveApiKey').addEventListener('change', e => {
    if (e.target.checked && state.apiKey) localStorage.setItem('nev_api_key', state.apiKey);
    else localStorage.removeItem('nev_api_key');
  });
  // 消去ボタン: 入力欄・state・このブラウザの保存キー・チェックを一括で確実にクリア
  //（欄の手動削除だけではブラウザのパスワードマネージャ等で復活したように見えるケースへの確実な導線）
  $('clearApiKey').addEventListener('click', () => {
    $('apiKeyInput').value = '';
    state.apiKey = '';
    localStorage.removeItem('nev_api_key');
    $('saveApiKey').checked = false;
    modelAvailability = null; renderModelAvailability(); // F-3: 旧キーの利用可否表示も消去
    $('apiKeyStatus').textContent = 'このブラウザの保存キーを消去しました';
    $('apiKeyStatus').className = 'status-badge';
    updateCheckButton();
  });
  // モデル別の利用可否（旧ツールの機能を復元）。接続テストで verifyAllModels（有料プラン判定込み）を実行し、
  // 各モデルカードに「✓利用可能 / ✗有料プランが必要」等を表示。選択中モデルが使えない場合は接続OKと言わない。
  //（旧実装は「キーが有効か」しか見ておらず、無料キーでProを選んでも「接続OK」と誤解を招いていた）
  let modelAvailability = null;
  function renderModelAvailability() {
    document.querySelectorAll('#modelOptions input[name="geminiModel"]').forEach(inp => {
      const card = inp.closest('.model-option').querySelector('.model-card');
      let el = card.querySelector('.model-avail');
      if (!el) { el = document.createElement('span'); el.className = 'model-avail'; el.style.cssText = 'display:block;font-size:11px;margin-top:4px;'; card.appendChild(el); }
      const r = modelAvailability && modelAvailability[inp.value];
      if (!r) { el.textContent = ''; return; }
      if (r.available) { el.textContent = '✓ 利用可能'; el.style.color = '#2c7a52'; }
      else { el.textContent = '✗ ' + (r.reason || '利用不可'); el.style.color = '#b23b3b'; }
    });
  }
  function refreshSelectedModelBadge() {
    const badge = $('apiKeyStatus');
    const r = modelAvailability && modelAvailability[state.model];
    if (!r) return;
    if (r.available) { badge.textContent = `接続OK（選択中の ${state.model} は利用可能）`; badge.className = 'status-badge ok'; }
    else { badge.textContent = `⚠ キーは有効ですが、選択中の ${state.model} は利用できません: ${r.reason || '利用不可'}`; badge.className = 'status-badge ng'; }
  }
  $('verifyApiKey').addEventListener('click', async () => {
    const badge = $('apiKeyStatus');
    if (!state.apiKey) { badge.textContent = 'キーを入力してください'; badge.className = 'status-badge ng'; return; }
    badge.textContent = '確認中...'; badge.className = 'status-badge';
    const ok = await NevGemini.verifyApiKey(state.apiKey);
    if (!ok) { badge.textContent = '接続失敗（キーを確認）'; badge.className = 'status-badge ng'; return; }
    badge.textContent = 'モデル別の利用可否を確認中...';
    try { modelAvailability = await NevGemini.verifyAllModels(state.apiKey); } catch (e) { modelAvailability = null; }
    renderModelAvailability();
    if (modelAvailability) refreshSelectedModelBadge();
    else { badge.textContent = '接続OK（モデル別の可否確認は失敗。実行時にエラーで判明します）'; badge.className = 'status-badge ok'; }
    if ($('saveApiKey').checked) localStorage.setItem('nev_api_key', state.apiKey);
  });

  // ── ファイル ──
  const uploadArea = $('uploadArea');
  $('fileInput').addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  ['dragover', 'dragenter'].forEach(ev => uploadArea.addEventListener(ev, e => { e.preventDefault(); uploadArea.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => uploadArea.addEventListener(ev, e => { e.preventDefault(); uploadArea.classList.remove('drag'); }));
  uploadArea.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
  $('removeFile').addEventListener('click', () => {
    if (running) { alert('チェック実行中はファイルを削除できません。キャンセルするか完了を待ってください。'); return; }
    state.file = null;
    state.pageCount = 0; state.pageThumbs = null; state.selectedPages = null;
    buildPageSelect();
    $('fileInfo').style.display = 'none';
    updateCheckButton();
  });

  async function handleFile(file) {
    if (running) { alert('チェック実行中はファイルを変更できません。キャンセルするか完了を待ってください。'); return; }
    if (!file.name.toLowerCase().endsWith('.pdf')) { alert('PDFファイルを選択してください'); return; }
    state.file = file;
    // 旧ファイルのページ選択が過渡的に残らないよう先にクリア（プレビュー生成のawait中の乖離防止）
    state.pageCount = 0; state.pageThumbs = null; state.selectedPages = null;
    buildPageSelect();
    $('fileName').textContent = file.name;
    $('fileSize').textContent = NevUtil.formatFileSize(file.size);
    $('fileInfo').style.display = 'block';
    const prev = $('previewContainer'); prev.innerHTML = '';
    const canvas = await NevPdf.pdfToPreview(file);
    if (canvas) prev.appendChild(canvas);
    // D: 総ページ数とサムネイルを取得し、上限超過時のみページ選択UIを表示
    state.pageCount = 0; state.pageThumbs = null; state.selectedPages = null;
    try {
      const { totalPages, thumbs } = await NevPdf.pdfGetPageThumbnails(file);
      state.pageCount = totalPages;
      state.pageThumbs = thumbs;
    } catch (e) { /* サムネイル生成失敗時は従来挙動（先頭N固定）にフォールバック */ }
    buildPageSelect();
    updateCheckButton();
  }

  // ── D: 多ページPDFのページ選択UI（旧・電気系統図ツールのサムネイル選択の移植）──
  // 総ページ数が rule.meta.maxPages を超える場合のみ表示。既定=先頭Nページ選択済み。
  // 超過しない場合は非表示＝従来と完全に同挙動（回帰ゼロ）。
  function currentMaxPages() {
    const rule = state.drawingType ? NevRules.getRule(state.drawingType) : null;
    return rule ? rule.meta.maxPages : NevPdf.DEFAULTS.maxPages;
  }
  function buildPageSelect() {
    const wrap = $('pageSelect');
    if (!wrap) return;
    const maxA = currentMaxPages();
    if (!state.file || !state.pageThumbs || state.pageCount <= maxA) {
      wrap.style.display = 'none';
      wrap.innerHTML = '';
      state.selectedPages = null;
      return;
    }
    // 既存の選択があれば引き継ぐ（図面種別切替時）。新しい上限を超える分は先頭から切り詰め。
    let selected = Array.isArray(state.selectedPages) && state.selectedPages.length
      ? state.selectedPages.filter(p => p >= 1 && p <= state.pageCount).slice(0, maxA)
      : null;
    if (!selected || !selected.length) {
      selected = [];
      for (let i = 1; i <= Math.min(maxA, state.pageCount); i++) selected.push(i);
    }
    state.selectedPages = selected;
    const thumbs = state.pageThumbs;
    const partial = thumbs.length < state.pageCount ? `（サムネイルは先頭${thumbs.length}ページ分のみ表示）` : '';
    wrap.style.display = 'block';
    wrap.innerHTML = `<div class="page-select-note">&#9888; このPDFは全${state.pageCount}ページあり、上限（${maxA}ページ）を超えています。解析するページを選択してください（最大${maxA}ページ・既定は先頭${Math.min(maxA, state.pageCount)}ページ）${esc(partial)}<span id="pageSelectCount"></span></div><div class="page-select-grid" id="pageSelectGrid"></div>`;
    const grid = wrap.querySelector('#pageSelectGrid');
    thumbs.forEach(t => {
      const label = document.createElement('label');
      label.className = 'page-thumb';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = String(t.pageNumber);
      cb.checked = selected.indexOf(t.pageNumber) >= 0;
      cb.addEventListener('change', () => onPageToggle(maxA));
      const img = document.createElement('img');
      img.src = t.dataUrl;
      img.alt = `${t.pageNumber}ページ目`;
      const cap = document.createElement('span');
      cap.className = 'page-thumb-cap';
      cap.textContent = `P${t.pageNumber}`;
      label.appendChild(cb); label.appendChild(img); label.appendChild(cap);
      grid.appendChild(label);
    });
    syncSelectedPages();
  }
  function pageCheckboxes() {
    return Array.from(document.querySelectorAll('#pageSelectGrid input[type="checkbox"]'));
  }
  function onPageToggle(maxA) {
    const checked = pageCheckboxes().filter(c => c.checked);
    if (checked.length > maxA) {
      alert(`解析できるのは最大${maxA}ページまでです。`);
      checked.slice(maxA).forEach(c => { c.checked = false; });
    }
    syncSelectedPages();
  }
  function syncSelectedPages() {
    const boxes = pageCheckboxes();
    const pages = boxes.filter(c => c.checked).map(c => parseInt(c.value, 10)).sort((a, b) => a - b);
    boxes.forEach(c => { const el = c.closest('.page-thumb'); if (el) el.classList.toggle('selected', c.checked); });
    state.selectedPages = pages.length ? pages : null;
    const cnt = $('pageSelectCount');
    if (cnt) cnt.textContent = pages.length
      ? ` ／ 選択中: ${pages.map(p => 'P' + p).join(', ')}`
      : ' ／ 未選択（未選択の場合、画像化時は先頭ページ群・PDF直接送信時は全ページが対象になります）';
  }

  function updateCheckButton() {
    const ready = state.apiKey && state.drawingType && state.file;
    $('checkBtn').disabled = !ready || running; // 実行中はファイル差し替え等で再有効化しない
    $('checkNote').textContent = running ? '実行中…' : (ready ? '準備完了。実行できます。' : 'APIキー・図面種別・ファイルを設定してください');
    renderCostBar($('costBar'));
  }

  // ── 料金バー（組織要件: 上限警告・超過表示）──
  function renderCostBar(el) {
    if (!el) return;
    const s = capTracker.getState();
    const msg = capTracker.getMessage();
    let cls = 'cost-bar';
    if (s.status === 'over') cls += ' over';
    else if (s.status === 'warn') cls += ' warn';
    const capVal = s.capJpy || 0;
    el.className = cls;
    el.style.display = 'flex';
    // 波④-4: 累計は月別（月替わりで自動リセット）＝「今月の累計」と表示
    el.innerHTML =
      `<span>${msg ? esc(msg.text) : `今月の累計: 約 ${s.totalJpy.toLocaleString()} 円`} <a href="#" class="cost-reset" style="margin-left:8px;font-size:12px;">今月の累計をリセット</a></span>` +
      `<span>上限 <input type="number" min="0" step="50" class="cost-cap-input" value="${capVal}"> 円/月（0=無制限）</span>`;
    const capInput = el.querySelector('.cost-cap-input');
    if (capInput) capInput.addEventListener('change', e => {
      const v = parseFloat(e.target.value) || 0;
      capTracker.setCap(v); localStorage.setItem(CAP_KEY, String(v));
      renderCostBar($('costBar')); renderCostBar($('costBarResult'));
    });
    const reset = el.querySelector('.cost-reset');
    if (reset) reset.addEventListener('click', e => {
      e.preventDefault(); capTracker.reset();
      renderCostBar($('costBar')); renderCostBar($('costBarResult'));
    });
  }

  // ── 実行 ──
  $('checkBtn').addEventListener('click', runCheck);
  $('recheckBtn').addEventListener('click', () => {
    $('resultSection').style.display = 'none';
    $('errorSection').innerHTML = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  // 波④-3: 実行キャンセル（AbortController）。旧・電気系統図ツールのキャンセル機能の復元。
  // abort() で実行中の fetch を中断。既に取得済みの runs は捨てず結果表示する（runCheck側で処理）。
  let abortCtrl = null;
  let running = false; // 実行中の再入・二重実行防止（実行中のファイル差し替えでcheckBtnが再有効化されるのを防ぐ）
  $('cancelBtn').addEventListener('click', () => {
    if (!abortCtrl) return;
    abortCtrl.abort();
    $('cancelBtn').disabled = true;
    $('cancelBtn').textContent = 'キャンセル中...';
  });

  async function runCheck() {
    // B-2: 絞り込み指定は最初に消費（実行中・上限confirmキャンセル等の早期returnで残留すると、
    // 次の「全項目チェック」が黙って部分実行になるため）
    const recheckIds = state.recheckIds; state.recheckIds = null;
    if (running) return; // 二重実行防止（並走すると二重課金・キャンセル不能化・結果の相互上書きが起きる）
    // 上限超過時は実行前に確認
    const st = capTracker.getState();
    if (st.status === 'over') {
      if (!confirm(`料金上限を ${st.overageJpy.toLocaleString()} 円 オーバーしています。続行しますか？`)) return;
    }
    running = true;
    $('errorSection').innerHTML = '';
    $('resultSection').style.display = 'none';
    $('loadingSection').style.display = 'block';
    $('checkBtn').disabled = true;
    abortCtrl = new AbortController();
    $('cancelBtn').disabled = false;
    $('cancelBtn').innerHTML = '&#10005; キャンセル';
    let canceled = false;

    const fullRule = NevRules.getRule(state.drawingType);
    const rule = (recheckIds && recheckIds.length)
      ? Object.assign({}, fullRule, { checks: fullRule.checks.filter(c => recheckIds.indexOf(c.id) >= 0) })
      : fullRule;
    const runFileName = state.file ? state.file.name : ''; // クリック時点の判定対象を固定（差し替え時の誤表示防止）
    try {
      // 入力生成: ネイティブPDF優先、サイズ超過時は画像化にフォールバック。
      // rule.settings.preferImages=true の図面（配線ルート図＝色分けが判定要素）は最初から画像化。
      // D: 総ページ数が上限を超え、ページ選択がある場合は「選択ページのみ画像化」して送信
      //   （ネイティブPDF送信では選択が反映されないため画像経路を使う）。
      //   上限以内のPDFでは pageOverride=null ＝ 従来と完全に同挙動。
      const pageOverride = (state.pageCount > rule.meta.maxPages && Array.isArray(state.selectedPages) && state.selectedPages.length)
        ? state.selectedPages.slice(0, rule.meta.maxPages) : null;
      let input;
      try {
        if (rule.settings.preferImages || pageOverride) throw new Error('preferImages');
        input = await NevPdf.pdfToNative(state.file, { maxNativeBase64: rule.settings.maxPayloadBytes });
      } catch (e) {
        $('loadingText').textContent = 'PDFを画像に変換中...';
        input = await NevPdf.pdfToImages(state.file, { maxPages: rule.meta.maxPages, renderScale: rule.settings.renderScale, maxPayloadBytes: rule.settings.maxPayloadBytes, pages: pageOverride || undefined });
      }
      if (pageOverride) input.selectedPages = pageOverride;

      // 表題欄の拡大画像を補助として追加（必須項目の小さな文字の読取精度向上）。失敗時は無視。
      // D: ページ選択時は選択先頭ページの表題欄を切り出す（1ページ目が未選択の場合のずれ防止）。
      const crop = await NevPdf.pdfToTitleBlockCrop(state.file, pageOverride ? { pageNum: pageOverride[0] } : undefined).catch(() => null);
      if (crop) input.images = input.images.concat([crop]);

      // ── 波③: 2パス方式（rule.settings.twoPass=true の図面＝配線ルート図のみ） ──
      // Pass1（抽出専用・1回・決定論設定）で旗上げ全件・統括表・色観測等を構造化JSONで抽出し、
      // Pass2（判定専用）のプロンプトに根拠として添付する。精度モードとは独立（高精度/2モデル
      // 一致では Pass2 のみ複数回実行し、Pass1 は共通の1回）。API料金は約2倍になる（UIに明示）。
      // Pass1 が失敗した場合は従来の1パス（buildPrompt）へフォールバック（安全側＝現行挙動）。
      const twoPass = !!rule.settings.twoPass;
      let pass1Data = null;
      if (twoPass) {
        $('loadingText').textContent = `${rule.meta.drawingName} を解析中...（2パス 1/2: データ抽出）`;
        try {
          const p1 = await NevGemini.callGeminiWithRetry(
            state.apiKey, input.images, NevPrompt.buildPass1Prompt(rule, state.businessType), state.model,
            info => { if (info && info.message) $('loadingText').textContent = info.message; },
            { pass: 1, total: 2 },
            { maxOutputTokens: rule.settings.maxOutputTokens, signal: abortCtrl.signal }
          );
          const c1 = NevCost.estimateCost(p1._usageMetadata, p1._model);
          if (c1) capTracker.addCost(c1);
          pass1Data = (p1 && p1.detected_info && typeof p1.detected_info === 'object') ? p1.detected_info : null;
        } catch (e1) {
          // 失敗経路でも課金は発生している → usageがあれば計上（FZ-5と同方針）
          if (e1 && e1.usageMetadata) { const c = NevCost.estimateCost(e1.usageMetadata, state.model); if (c) capTracker.addCost(c); }
          // 波④-3: Pass1中のキャンセルは判定結果ゼロ＝そのまま中断表示（フォールバック実行しない）
          if (e1 && e1.type === 'aborted') throw e1;
          pass1Data = null;
        }
        if (!pass1Data) {
          $('errorSection').innerHTML += `<div class="error-card" style="background:#fef3c7;border-color:#fcd34d;color:#92400e;"><strong>⚠ Pass1（データ抽出）に失敗</strong><p>2パス実行のうち抽出パスが失敗したため、従来の1パス判定にフォールバックして続行します（判定は有効ですが、色観測・数値抽出の精度向上効果はありません）。</p></div>`;
        }
      }
      const promptText = (twoPass && pass1Data)
        ? NevPrompt.buildPass2Prompt(rule, state.businessType, pass1Data)
        : NevPrompt.buildPrompt(rule, state.businessType);
      // 実行するモデル列: 通常=選択モデル1回 / 高精度=選択モデル3回多数決 / 2モデル一致=flash+proを各1回
      // いずれも NevVote.mergeRuns で統合（割れた項目はwarnに降格＝品質最優先の保守判定）。
      let models;
      if (state.precision === 'high') models = [state.model, state.model, state.model];
      else if (state.precision === 'crossmodel') models = ['gemini-2.5-flash', 'gemini-2.5-pro'];
      else models = [state.model];
      const runs = [];
      const runErrors = [];
      for (let i = 0; i < models.length; i++) {
        // M2: 2回目以降の呼び出し前に上限超過を再チェック（超過したまま追加課金しない・組織要件）
        if (i > 0 && capTracker.getState().status === 'over') {
          runErrors.push({ model: models[i], message: '料金上限を超過したため以降の実行をスキップしました' });
          continue;
        }
        const modeNote = state.precision === 'crossmodel' ? `2モデル一致 ${models[i]}（${i + 1}/${models.length}）`
          : models.length > 1 ? `高精度 ${i + 1}/${models.length}回目` : '30秒〜2分程度';
        const passNote = pass1Data ? '2パス 2/2: 判定・' : '';
        $('loadingText').textContent = `${rule.meta.drawingName} を解析中...（${passNote}${modeNote}）`;
        try {
          const r = await NevGemini.callGeminiWithRetry(
            state.apiKey, input.images, promptText, models[i],
            info => { if (info && info.message) $('loadingText').textContent = info.message; },
            { pass: 1, total: 1 },
            Object.assign(
              { maxOutputTokens: rule.settings.maxOutputTokens, signal: abortCtrl.signal },
              // 高精度(3回多数決)の2回目以降は意図的に揺らして独立な意見を得る（旧ツールの精密モード準拠）。
              // 全回 temperature 0 だとほぼ同一応答の多数決になり、料金3倍の割に頑健化効果が薄い。
              // 1回目は決定論設定のまま＝再現性の基準点を残す。割れれば安全側(warn)に倒れる。
              (state.precision === 'high' && i > 0) ? { temperature: 0.4, topK: 40 } : {}
            )
          );
          const c = NevCost.estimateCost(r._usageMetadata, r._model);
          if (c) capTracker.addCost(c);
          runs.push(r);
        } catch (e) {
          // FZ-5: 失敗経路（MAX_TOKENS/パース失敗）でも課金は発生している → usageがあれば計上（上限警告の遅発防止）
          if (e && e.usageMetadata) { const c = NevCost.estimateCost(e.usageMetadata, models[i]); if (c) capTracker.addCost(c); }
          // 波④-3: キャンセル → 以降の実行を中止。既に取得済み（課金済み）の runs は捨てず結果表示する。
          if (e && e.type === 'aborted') {
            canceled = true;
            runErrors.push({ model: models[i], message: 'ユーザーによるキャンセル' });
            break;
          }
          // 1回分が失敗しても、既に成功した（課金済みの）実行は捨てない。全滅時のみ throw。
          runErrors.push({ model: models[i], message: e && e.message || String(e) });
        }
      }
      // 波④-3: 全実行前にキャンセルされた場合は中断メッセージ（課金注記付き）で終了
      if (canceled && runs.length === 0) throw Object.assign(new Error('キャンセルしました（実行済み分は課金されています）'), { suggestions: [] });
      if (runs.length === 0) throw (runErrors[0] ? Object.assign(new Error(runErrors[0].message), { suggestions: [] }) : new Error('判定に失敗しました'));
      if (canceled) {
        $('errorSection').innerHTML += `<div class="error-card" style="background:#fef3c7;border-color:#fcd34d;color:#92400e;"><strong>⚠ キャンセルしました（実行済み・送信済みの呼び出し分は課金されます。未送信分の課金はありません）</strong><p>取得済みの ${runs.length} 回分で判定結果を表示します（${state.precision === 'crossmodel' ? '2モデル一致の保守性が低下' : '多数決の票数が減少'}）。目視確認を強く推奨します。</p></div>`;
      }
      const result = NevVote.mergeRuns(runs);
      // 波③: 2パス時は Pass1 の抽出結果を detected_info に統合（Pass1 が抽出の単一情報源。
      // Pass2 は detected_info を出力しない指示だが、万一 echo しても Pass1 側を優先する）。
      // 決定論検算（wire_reconcile 等）・旗上げ一覧表示・色観測サニティはこの統合後の値を使う。
      if (twoPass && pass1Data) {
        result.detected_info = Object.assign({}, result.detected_info || {}, pass1Data);
        // F-5: 2パスでは抽出の単一情報源はPass1。Pass2が指示違反でdetected_infoをechoして
        // 多数決の「割れ」(_disputedFields)を生成しても、それはechoの揺れでありPass1の信頼性と無関係。
        // 残すと決定論検算が「検算保留」に化け、Pass1由来の乖離warnを握り潰す（false-PASS方向）。
        delete result.detected_info._disputedFields;
        result._twoPass = true;
        // 波③: 色観測サニティ（後処理）。Pass1 が「色観測不能/1色のみ」を報告した場合に限り、
        // 色依存項目の fail を warn に降格（モノクロ誤認による false-FAIL 防止・旧ツール準拠）。
        // fail→warn の降格のみ（pass 化は一切しない＝P1 の明示的例外として組織承認済み）。
        const sanity = NevColorSanity.apply(result);
        if (sanity.count) {
          const why = sanity.reason === 'contradiction'
            ? `Pass1で複数色（${esc((sanity.observed || []).join('・'))}）を観測済みにもかかわらず色分け系が不合格判定＝観測と判定の矛盾（見落とし/誤認の可能性）`
            : 'Pass1で配線ルート線の色を十分に観測できなかったため、モノクロ誤認の可能性';
          $('errorSection').innerHTML += `<div class="error-card" style="background:#fef3c7;border-color:#fcd34d;color:#92400e;"><strong>⚠ 色観測サニティによる自動降格 ${sanity.count}件</strong><p>${why}があるため、色依存項目（${esc(sanity.downgrades.map(d => d.id).join(', '))}）の「不合格」を「要確認」に降格しました。お手元の図面の色分けを直接目視で確認してください。</p></div>`;
        }
      }
      result._ts = new Date().toISOString(); // 判定時刻（エクスポート時刻と区別。監査証跡の正確性）
      result._precisionMode = state.precision;
      result._models = models;
      result._ranModels = runs.map(r => r._model);
      result._runErrors = runErrors;
      // モード上必要な実行数に満たない場合（例: 2モデル一致で片方失敗）は注意を表示
      //（キャンセル時は上の専用メッセージと重複するため出さない）
      if (runs.length < models.length && !canceled) {
        // M1: 追記（+=）にして他の安全警告と共存させる（上書きで警告が消えるのを防ぐ）
        $('errorSection').innerHTML += `<div class="error-card" style="background:#fef3c7;border-color:#fcd34d;color:#92400e;"><strong>⚠ 一部モデルが未実行</strong><p>${esc(runErrors.map(e => e.model + ': ' + e.message).join(' / '))}<br>成功した ${runs.length} 回分で判定しています（${state.precision === 'crossmodel' ? '2モデル一致の保守性が一部低下' : '多数決の票数が減少'}）。目視確認を強く推奨します。</p></div>`;
      }
      result._fileName = runFileName; // 結果がどのファイルの判定かを刻印（履歴にも保存される）
      result._drawingType = state.drawingType; result._businessType = state.businessType; // 取り違えガード用の刻印
      if (recheckIds && recheckIds.length) result._partialCheck = recheckIds.length;
      renderResult(rule, result, input, null);
      // 波④-2: 判定完了時に履歴へ保存（部分チェックは保存しない＝全項目の記録と混ざらないように）
      if (!result._partialCheck) {
        state._historyId = pushHistory(rule, result);
        state.ovMemos = {};
      } else {
        state._historyId = null;
      }
    } catch (err) {
      showError(err);
    } finally {
      running = false;
      abortCtrl = null; // 波④-3: 実行終了後の abort() を無効化
      $('loadingSection').style.display = 'none';
      $('checkBtn').disabled = false;
      updateCheckButton();
    }
  }

  // グループ別の集計（3-A: 結線は core/verdict.js の単一実装を使用）
  function computeAggs(rule, result) {
    return NevVerdict.computeGroupAggs(rule, result, state.businessType);
  }

  // 決定論チェックで裏取りされる項目ID集合（コード検算バッジ用）
  function codeBackedIds(rule) {
    const s = new Set();
    (rule.deterministic || []).forEach(d => (d.targets || []).forEach(id => s.add(id)));
    return s;
  }
  const STLABEL = { pass: '合格', fail: '不合格', warn: '要確認', na: '非該当' };
  // 人手オーバーライドを反映した実効ステータス
  function effStatus(idx, item) { return state.overrides[idx + ':' + item.id] || item.status; }
  state.ovMemos = state.ovMemos || {};   // 人手確認の理由メモ（履歴に保存）
  state.recheckIds = null;               // 絞り込み再チェックの対象id（1回で消費）
  state._historyId = null;               // 直近runの履歴エントリid（人手確認の追記保存先）

  // 第2波: 人手確認（override＋メモ）を履歴エントリへ追記保存（翌日持ち越し・監査記録）
  function persistOverrides() {
    if (!state._historyId) return;
    try {
      const arr = getHistory();
      const e = arr.find(x => x.id === state._historyId);
      if (!e) return;
      e.overrides = Object.assign({}, state.overrides);
      e.ovMemos = Object.assign({}, state.ovMemos);
      saveHistoryArr(arr);
    } catch (err) { /* 保存失敗は判定機能に影響させない */ }
  }

  // B-4: 保存済み結果に存在する項目だけにルールを絞る（ルール改定後に、当時無かった新項目が
  // 「判定結果が取得できませんでした」の phantom fail として過去記録に混ざるのを防ぐ）
  function ruleForStoredResult(rule, storedResult) {
    try {
      const present = new Set();
      ['results', 'nev_results', 'manual_results'].forEach(k => {
        (Array.isArray(storedResult && storedResult[k]) ? storedResult[k] : []).forEach(r => { if (r && r.id != null) present.add(r.id); });
      });
      if (!present.size) return rule;
      const filtered = rule.checks.filter(c => present.has(c.id));
      if (!filtered.length || filtered.length === rule.checks.length) return rule;
      return Object.assign({}, rule, { checks: filtered });
    } catch (e) { return rule; }
  }

  // 第2波: 前回結果との差分（同一ファイル名・図面種別の直近履歴。部分チェックでは使わない）
  function computePrevDiff(rule, result, excludeId) {
    try {
      if (result._partialCheck) return null;
      const fn = result._fileName;
      if (!fn) return null;
      // B-3: 「前回」は自分より古いエントリに限定（古い履歴を復元したとき未来のrunと逆向き比較しない）
      const curTs = result._ts || null;
      const prev = getHistory().find(e => e.id !== excludeId && e.drawingType === state.drawingType && e.fileName === fn && e.result
        && (!curTs || !e.ts || e.ts < curTs));
      if (!prev) return null;
      const prevAggs = NevVerdict.computeGroupAggs(ruleForStoredResult(rule, prev.result), prev.result, prev.businessType || state.businessType);
      const map = {};
      prevAggs.forEach(({ group, agg }) => {
        map[group] = {};
        agg.items.forEach(i => { map[group][i.id] = i.status; });
      });
      return { ts: prev.ts, map };
    } catch (e) { return null; }
  }

  // ── 結果描画 ──
  function renderResult(rule, result, input, cost) {
    state.overrides = {}; // 新しい判定ごとに人手上書きをリセット
    state.ovMemos = {};   // メモも同時にリセット（復元時はrestoreHistoryが描画後に再適用する）
    const aggs = computeAggs(rule, result);
    const groups = aggs.map(a => a.group);
    // 4-D: manual群は社内基準＝NeV合否とは別（参考）であることをラベルで明示
    const groupLabel = { nev: 'NeV要件判定', manual: '旧・作図センター基準（R6旧マニュアル・参考／不合格断定なし）' };
    // 3-B: グループ枠（tabContentN/overallN/catsN）を件数分だけ動的生成（2枠決め打ちの撤廃）
    $('tabContents').innerHTML = aggs.map((_, i) =>
      `<div class="result-tab-content${i === 0 ? ' active' : ''}" id="tabContent${i}"><div class="overall-result" id="overall${i}"></div><div id="cats${i}"></div></div>`).join('');
    const backed = codeBackedIds(rule);
    lastRender = { rule, aggs, backed, result, ruleType: state.drawingType };
    lastRender.prevDiff = computePrevDiff(rule, result, state._restoringEntryId || null);

    // タブ生成
    const tabs = $('resultTabs'); tabs.innerHTML = '';
    aggs.forEach(({ group: g, agg }, i) => {
      const btn = document.createElement('button');
      btn.className = 'result-tab' + (i === 0 ? ' active' : '');
      btn.textContent = `${groupLabel[g] || g}（必須 ${agg.requiredPass}/${agg.requiredTotal}）`;
      btn.addEventListener('click', () => switchResultTab(i));
      tabs.appendChild(btn);
      renderGroup(rule, g, agg, i, backed);
    });
    renderReviewSummary(aggs, result);
    // 第2波: 部分チェック（絞り込み再実行）の明示
    if (result._partialCheck) {
      $('errorSection').innerHTML += `<div class="error-card" style="background:#eff6ff;border-color:#bfdbfe;color:#1e40af;"><strong>&#128260; 部分チェック（${result._partialCheck}項目のみ再実行）</strong><p>選択した項目だけを再チェックした参考結果です。<b>総合判定は全項目チェックの代わりになりません</b>。この結果は履歴に保存されません。提出前には全項目チェックを実行してください。</p></div>`;
    }
    // 使わないタブを隠す
    switchResultTab(0);

    // 読み取り情報
    const di = result.detected_info || {};
    // M4: 配列/オブジェクトを可読整形（"[object Object]" 防止）。内部キー（_始まり）は非表示。
    const fmtDi = v => {
      if (typeof v === 'boolean') return v ? 'はい' : 'いいえ'; // 波③: is_color_drawing 等
      if (Array.isArray(v)) return v.map(x => (x && typeof x === 'object') ? Object.keys(x).map(kk => `${kk}:${x[kk]}`).join(' ') : String(x)).join('、');
      if (v && typeof v === 'object') return Object.keys(v).map(kk => `${kk}:${v[kk]}`).join('、');
      return String(v);
    };
    // 波③: boolean(false) も表示対象（カラー図面か=いいえ は重要情報）。空配列は非表示。
    $('detectedInfo').innerHTML = Object.keys(di).filter(k =>
      (di[k] || di[k] === false) && k.charAt(0) !== '_' && k !== 'wire_annotations'
      && !(Array.isArray(di[k]) && !di[k].length)).map(k =>
      `<div><strong>${esc(labelForInfo(k))}:</strong> ${esc(fmtDi(di[k]))}</div>`).join('') || '<div>（読み取り情報なし）</div>';
    // 旗上げ（各区間の注記）一覧: 1件ずつ番号付きで表示（旧・配線ルート図ツールの一覧表示の復元。目視確認の補助）
    const flags = Array.isArray(di.wire_annotations) ? di.wire_annotations : [];
    if (flags.length) {
      $('detectedInfo').innerHTML += `<div style="margin-top:8px;"><strong>旗上げ（各区間の注記）一覧 ${flags.length}件:</strong>` +
        flags.map((a, i) => `<div style="padding-left:1em;">${esc(fmtFlagRow(a, i))}</div>`).join('') + '</div>';
    }

    $('aiComment').textContent = result.overall_comment || '（コメントなし）';
    const dis = (result._voteDisagreements || []).length;
    const precLabel = precisionLabelFor(result);
    $('resultTypeLabel').textContent = `${rule.meta.drawingName} / ${state.businessType === 'kiso' ? '基礎充電' : '目的地充電'} / ${precLabel}` + (dis ? ` / 判定ゆれ${dis}項目` : '') + (result._fileName ? ` ／ ファイル: ${result._fileName}` : '');

    // ページ切り捨て警告（画像化フォールバックで一部ページが未読の場合）
    if (input && input.truncated) {
      // D: ページ選択で実行した場合は、どのページを解析したかを明示する
      const body = Array.isArray(input.selectedPages) && input.selectedPages.length
        ? `解析対象: ${input.selectedPages.map(p => 'P' + p).join(', ')}（全${input.pageCount}ページ中・ページ選択による）。選択しなかったページの内容は判定に含まれていません。目視で確認してください。`
        : 'PDFのページ数/サイズが大きく、一部ページを解析できませんでした。未読ページの内容は判定に含まれていません。目視で確認してください。';
      // M1: 追記（+=）にして「一部モデル未実行」警告を上書き消去しない
      $('errorSection').innerHTML += `<div class="error-card" style="background:#fef3c7;border-color:#fcd34d;color:#92400e;"><strong>⚠ 一部ページ未読み込み</strong><p>${esc(body)}</p></div>`;
    }

    // 料金（多数決の累計は capTracker に加算済み。常に最新の累計を表示）
    renderCostBar($('costBarResult'));

    $('resultSection').style.display = 'block';
    window.scrollTo({ top: $('resultSection').offsetTop - 20, behavior: 'smooth' });
  }

  function renderGroup(rule, group, agg, idx, backed) {
    // 結果枠は overall0/1・cats0/1 の2枠のみ用意。3グループ以上の規則が来ても
    // null参照でクラッシュしないようガード（現行4規則は最大2グループ）。
    if (!$('overall' + idx) || !$('cats' + idx)) { console.warn('結果表示枠が不足しています（グループ数>2）'); return; }
    const cats = rule.categories || {};
    const catIds = Object.keys(agg.categoryResults).sort((a, b) => ((cats[a] || {}).order || 0) - ((cats[b] || {}).order || 0));
    const html = catIds.map(cid => {
      const cat = agg.categoryResults[cid];
      const items = cat.items.map(it => renderCheckItem(it, idx, backed && backed.has(it.id), group)).join('');
      return `<div class="cat-block"><h4 class="cat-title">${esc((cats[cid] || {}).title || cid)}</h4>${items}</div>`;
    }).join('');
    $('cats' + idx).innerHTML = html;
    updateOverall(idx);
  }

  // 人手上書きを反映して総合判定を再計算・再表示（overall要素 + サマリ）
  function updateOverall(idx) {
    if (!lastRender || !lastRender.aggs[idx]) return;
    const { rule, aggs } = lastRender;
    const items = aggs[idx].agg.items;
    const reqFailForWarn = rule.settings.requiredFailForWarn;
    const req = items.filter(i => i.required && effStatus(idx, i) !== 'na');
    const reqFail = req.filter(i => effStatus(idx, i) === 'fail').length;
    const reqWarn = req.filter(i => effStatus(idx, i) === 'warn').length;
    const reqPass = req.filter(i => effStatus(idx, i) === 'pass').length;
    const totalPass = items.filter(i => effStatus(idx, i) === 'pass').length;
    const totalNa = items.filter(i => effStatus(idx, i) === 'na').length;
    const nOv = items.filter(i => state.overrides[idx + ':' + i.id]).length;
    // 0-B/4-C: 総合判定式は aggregate.js の decideOverall を使用（二重実装の解消）。
    // criticalFail は人手override後の実効ステータスで再計算（人手で確認すればfail解除できる）。
    const critFail = items.filter(i => i.critical && i.required && effStatus(idx, i) === 'fail').length;
    const overall = NevAggregate.decideOverall({ requiredFail: reqFail, requiredWarn: reqWarn, criticalFail: critFail, requiredFailForWarn: reqFailForWarn });
    const el = $('overall' + idx); if (!el) return;
    el.className = 'overall-result ' + overall;
    const label = overall === 'pass' ? '合格' : overall === 'warn' ? '要確認' : '不合格';
    el.textContent = `${nOv ? '確認済み判定' : 'AI判定'}: ${label} ／ 合格 ${totalPass}/${items.length}（必須 ${reqPass}/${req.length}${totalNa ? ' ・非該当' + totalNa : ''}）` + (nOv ? ` ／ 人手調整${nOv}項目` : '');
  }

  // 出典表示: nev群=手引き5-9-N（図面種別から導出）/ manual群=社内基準。item.src で個別上書き可
  const SRC_59 = { mitori: '手引き5-9-1', heimen: '手引き5-9-2', haisen: '手引き5-9-3', keitou: '手引き5-9-4' };
  function srcLabelFor(item, groupName) {
    if (item.src === '社内基準') return '旧社内基準(R6)'; // 旧基準扱い（2026-07-17決定）
    if (item.src) return item.src;
    if (groupName === 'manual') return '旧社内基準(R6)';
    const t = (lastRender && lastRender.ruleType) || state.drawingType; // B-8: タブ切替後の誤表示防止
    return SRC_59[t] || '手引き5-9';
  }
  function renderCheckItem(item, idx, isBacked, groupName) {
    const eff = effStatus(idx, item);
    const overridden = !!state.overrides[idx + ':' + item.id];
    const badge = isBacked ? '<span class="src-badge code">コード検算</span>' : '<span class="src-badge ai">AI判定</span>';
    const confBadge = item.confidence === 'low' ? '<span class="src-badge low">確信度低</span>' : '';
    // 第1波: 出典（何に基づく判定か）を項目単位で明示 — 「AIがそう言った」→「手引きがそう言っている」
    const srcBadge = `<span class="src-badge" style="background:#eef2ff;color:#3730a3;" title="この項目の判定根拠">出典:${esc(srcLabelFor(item, groupName))}</span>`;
    // 第2波: 前回結果との差分チップ（同一ファイル・同一種別の直近履歴と比較）
    let diffChip = '';
    const pd = lastRender && lastRender.prevDiff;
    if (pd && pd.map[groupName]) {
      const prev = pd.map[groupName][item.id];
      const bad = s => s === 'fail' || s === 'warn';
      if (prev != null) {
        if (bad(prev) && !bad(item.status)) diffChip = '<span class="src-badge" style="background:#dcfce7;color:#166534;">前回比:解消</span>';
        else if (!bad(prev) && bad(item.status)) diffChip = '<span class="src-badge" style="background:#fee2e2;color:#991b1b;">前回比:新規</span>';
        else if (bad(prev) && bad(item.status)) diffChip = '<span class="src-badge" style="background:#fef3c7;color:#92400e;">前回比:未解消</span>';
      }
    }
    const opts = ['pass', 'warn', 'fail', 'na'].map(s => `<option value="${s}"${eff === s && overridden ? ' selected' : ''}>${STLABEL[s]}</option>`).join('');
    return `<div class="check-item${overridden ? ' overridden' : ''}">
      <span class="status-pill ${eff}">${STLABEL[eff] || eff}</span>
      <div class="check-main">
        <div class="c-label">${esc(item.label)}${item.required ? '' : '<span class="opt-tag">任意</span>'} ${badge}${confBadge}${srcBadge}${diffChip}${overridden ? '<span class="src-badge human">人手</span>' : ''}</div>
        ${item.found_text ? `<div class="c-found">検出: ${esc(item.found_text)}</div>` : '<div class="c-found" style="color:var(--fail)">※読み取り内容なし</div>'}
        ${item.detail ? `<div class="c-detail">${esc(item.detail)}</div>` : ''}
        <div class="c-override">確認/修正:
          <select class="ov-select" data-k="${idx}:${item.id}">
            <option value=""${overridden ? '' : ' selected'}>${item.original_status ? `自動降格のまま（AI判定${STLABEL[item.original_status] || item.original_status}→${STLABEL[item.status] || item.status}）` : `AIのまま（${STLABEL[item.status] || item.status}）`}</option>
            ${opts}
          </select>${overridden ? `<input type="text" class="ov-memo" data-k="${idx}:${item.id}" placeholder="確認/却下理由メモ（任意・履歴に保存）" value="${esc(state.ovMemos[idx + ':' + item.id] || '')}" style="margin-left:8px;width:280px;font-size:12px;padding:2px 6px;border:1px solid var(--line);border-radius:4px;">` : ''}</div>
      </div></div>`;
  }

  // 不確実性サマリ（どこを重点的に目視すべきか）。
  // ⑥ 人手オーバーライド後の実効ステータス(effStatus)で再集計し、人手確認済み項目は
  //    「重点確認」から外す（不合格/要確認の件数、および診断フラグの計上から除外）。
  function renderReviewSummary(aggs, result) {
    // 第2波: 差分サマリ（前回比）。ここで生成することで、人手確認・履歴復元による再描画でも消えない
    let diffNote = '';
    if (lastRender && lastRender.prevDiff) {
      let solved = 0, newBad = 0, remain = 0;
      const bad = s => s === 'fail' || s === 'warn';
      aggs.forEach(({ group, agg }) => {
        const pm = lastRender.prevDiff.map[group] || {};
        agg.items.forEach(i => {
          const prev = pm[i.id];
          if (prev == null) return;
          if (bad(prev) && !bad(i.status)) solved++;
          else if (!bad(prev) && bad(i.status)) newBad++;
          else if (bad(prev) && bad(i.status)) remain++;
        });
      });
      let pts = lastRender.prevDiff.ts; try { pts = new Date(pts).toLocaleString('ja-JP'); } catch (e) { /* raw */ }
      diffNote = `<div class="review-note" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534;">&#128200; 前回（${esc(pts)}・同名ファイル）比: 解消 ${solved} ／ 新規 ${newBad} ／ 未解消 ${remain}。各項目の「前回比」チップも参照（判定にAIの揺れが含まれる場合があります。差分ゼロ＝安全ではありません）。</div>`;
    }
    let cFail = 0, cWarn = 0, cLow = 0, cNote = 0, cNoEvidence = 0, cReqNa = 0;
    const overriddenIds = new Set();
    aggs.forEach(({ agg }, idx) => {
      agg.items.forEach(item => {
        const ov = !!state.overrides[idx + ':' + item.id];
        if (ov) overriddenIds.add(item.id);
        const eff = effStatus(idx, item);
        if (eff === 'fail') cFail++;
        else if (eff === 'warn') cWarn++;
        // 診断フラグ（確信度低・自動検算未実施・根拠未提示）は、まだAI判定に依存している
        // （人手未確認の）項目のみ計上する。人手で確定した項目は目視済みとみなす。
        if (!ov) {
          if (item.confidence === 'low') cLow++;
          if (/自動検算未実施/.test(item.detail || '')) cNote++;
          if (/根拠未提示/.test(item.detail || '')) cNoEvidence++;
          // F2: 必須項目が「非該当(na)」＝合否の分母から外れる。AIのna誤用を見逃さないよう可視化。
          if (item.required && eff === 'na') cReqNa++;
        }
      });
    });
    const dis = (result._voteDisagreements || []).filter(id => !overriddenIds.has(id)).length;
    const modeTxt = result._precisionMode === 'crossmodel' ? '2モデル一致(Flash+Pro)'
      : result._voteRuns > 1 ? `高精度${result._voteRuns}回多数決` : '通常(1回)';
    const chips = [];
    if (cFail) chips.push(`<span class="chip fail">不合格 ${cFail}</span>`);
    if (cWarn) chips.push(`<span class="chip warn">要確認 ${cWarn}</span>`);
    if (cLow) chips.push(`<span class="chip">確信度低 ${cLow}</span>`);
    if (dis) chips.push(`<span class="chip">判定ゆれ ${dis}</span>`);
    if (cNote) chips.push(`<span class="chip">自動検算未実施 ${cNote}</span>`);
    if (cNoEvidence) chips.push(`<span class="chip">根拠未提示 ${cNoEvidence}</span>`);
    if (cReqNa) chips.push(`<span class="chip">必須が非該当 ${cReqNa}</span>`);
    const focus = (cFail + cWarn + cLow + dis + cNote + cNoEvidence + cReqNa) === 0
      ? '<span style="color:var(--pass)">重点確認項目なし（全項目に根拠あり・確信度良好）。それでも最終目視を推奨。</span>'
      : (cReqNa ? `必須項目のうち ${cReqNa} 件が「非該当」と判定され合否計算から除外されています。本当に非該当か必ず確認してください。 ` : '') + '上記の項目を重点的に目視確認してください。';
    $('reviewSummary').innerHTML = diffNote + `<div class="review-summary">
      <div><strong>&#128269; 重点確認サマリ</strong>（判定モード: ${esc(modeTxt)}）</div>
      <div class="chips">${chips.join('') || '<span class="chip pass">指摘なし</span>'}</div>
      <div class="focus-note">${focus}</div></div>`;
  }

  // 人手オーバーライドのイベント（委譲）
  $('resultSection').addEventListener('change', e => {
    const sel = e.target.closest('.ov-select'); if (!sel) return;
    const k = sel.dataset.k; const v = sel.value;
    const idx = Number(k.split(':')[0]);
    const id = k.slice(k.indexOf(':') + 1);
    // ⑦ AIの元判定と同じ値を選び直した場合は「人手調整」とみなさない（監査カウントの水増し防止）。
    const aiItem = lastRender && lastRender.aggs[idx] && lastRender.aggs[idx].agg.items.find(it => it.id === id);
    const aiStatus = aiItem ? aiItem.status : null;
    if (v && v !== aiStatus) state.overrides[k] = v; else { delete state.overrides[k]; delete state.ovMemos[k]; } // C-2: 解除時はメモも消す
    // 対象項目の行を再描画（pill/バッジ更新）＋総合再計算＋サマリ更新
    const g = lastRender && lastRender.aggs[idx];
    if (!g) return; // FA-F: 防御（結果未描画時のchangeイベントで例外にしない）
    renderGroup(lastRender.rule, g.group, g.agg, idx, lastRender.backed);
    renderReviewSummary(lastRender.aggs, lastRender.result || {});
    persistOverrides(); // 第2波: 人手確認を履歴へ即時保存（翌日持ち越し）
  });
  // 第2波: 理由メモの入力（override時に表示される .ov-memo）
  $('resultSection').addEventListener('input', e => {
    const inp = e.target.closest('.ov-memo'); if (!inp) return;
    const k = inp.dataset.k;
    if (inp.value) state.ovMemos[k] = inp.value; else delete state.ovMemos[k];
    persistOverrides();
  });

  function switchResultTab(i) {
    document.querySelectorAll('#resultTabs .result-tab').forEach((b, bi) => b.classList.toggle('active', bi === i));
    // 3-B: N枠対応（0/1決め打ちの撤廃）
    document.querySelectorAll('#tabContents .result-tab-content').forEach((el, ei) => el.classList.toggle('active', ei === i));
  }

  function labelForInfo(k) {
    return {
      facility_name: '設置場所/施設名', drawing_title: '図面名称', creator: '作成者', scale: '縮尺', creation_date: '作成日',
      charging_count: '充電台数/スペース数', charging_space_widths_mm: '充電スペース幅(mm)',
      main_breaker_at: '主幹ブレーカー(AT)', charger_count: '充電器台数', simultaneous_count: '同時運転台数',
      main_breaker_af: '主幹ブレーカー(AF)', branch_breaker_ats: '分岐ブレーカー(AT)',
      wire_table_totals: '統括表の記載値', wire_annotation_sums: '旗上げ合算（種別別）',
      wire_drawn_lengths: '記載寸法合算（種別別）', cable_conduit_pairs: 'ケーブル⇔配管の対',
      // 波③: Pass1 の色観測フィールド（配線ルート図の2パス時のみ出現）
      is_color_drawing: 'カラー図面か', color_observation_summary: '色の観測サマリ',
      color_legend_observed: '凡例の色分けルール', color_legend_location: '凡例の所在',
      wire_color_distinction: '配線ルート線の色', hatching_colors_observed: 'ハッチング色',
      hatching_locations: 'ハッチング所在・用途',
    }[k] || k;
  }

  // 旗上げ注記1件を「1. ケーブル / 配管 | 配線方法 | 距離m（補足）」形式に整形（画面・コピー共用）
  function fmtFlagRow(a, i) {
    if (!a || typeof a !== 'object') return `${i + 1}. ${String(a)}`;
    const cable = a.cable || a.type || '';
    const conduit = a.conduit ? ' / ' + a.conduit : '';
    const method = a.method ? ' | ' + a.method : '';
    const len = (a.length_m != null && String(a.length_m) !== '') ? ' | ' + a.length_m + 'm' : '';
    const note = a.note ? `（${a.note}）` : '';
    return `${i + 1}. ${cable}${conduit}${method}${len} ${note}`.trim();
  }

  // 実行内容に忠実な精度表記（モード＋実際の実行数。キャンセル等の部分実行を隠さない＝監査証跡の正確性）
  function precisionLabelFor(result) {
    const mode = result && result._precisionMode;
    const base = mode === 'crossmodel' ? '2モデル一致(Flash+Pro)' : mode === 'high' ? '高精度(3回多数決)'
      : mode ? '通常(1回)' : (result && result._voteRuns > 1 ? `高精度${result._voteRuns}回` : '通常(1回)');
    const planned = result && Array.isArray(result._models) ? result._models.length : null;
    const ran = result && Array.isArray(result._ranModels) ? result._ranModels.length : ((result && result._voteRuns) || null);
    return (planned && ran != null && ran < planned) ? `${base}・実行${ran}/${planned}回（部分結果）` : base;
  }

  let lastRender = null;
  $('copyBtn').addEventListener('click', () => {
    if (!lastRender) return;
    const { rule, aggs, result } = lastRender;
    // L5: 監査に使える記録として、総合判定・件数・モード・日時・読み取り情報・AIコメントを含める
    // S3-3: 判定日時は「判定した時刻」（result._ts）。エクスポート時刻を判定日時として書くと監査記録の虚偽になる。
    const precLabel = precisionLabelFor(result);
    const judgedIso = (result && result._ts) || lastRender.restoredTs || null;
    const judgedStr = judgedIso ? new Date(judgedIso).toLocaleString('ja-JP') : new Date().toLocaleString('ja-JP');
    let txt = `=== NeV ${rule.meta.drawingName} 判定結果（${state.businessType === 'kiso' ? '基礎充電' : '目的地充電'}）===\n`;
    txt += `判定日時: ${judgedStr} ／ 判定モード: ${precLabel}\n`;
    if (lastRender.restoredTs) txt += `※履歴からの再表示を出力しています（エクスポート日時: ${new Date().toLocaleString('ja-JP')}）\n`;
    if (result && result._partialCheck) txt += `※部分チェック（${result._partialCheck}項目のみ再実行）: 全項目チェックの代わりになりません。\n`;
    const runErrsCp = (result && result._runErrors) || [];
    if (runErrsCp.length) txt += `※部分結果: 一部が未実行（${runErrsCp.map(e => (e.model || '') + ': ' + (e.message || '')).join(' / ')}）。目視確認を強く推奨。\n`;
    txt += `※AI一次判定＋人手確認。最終判断は目視確認済み前提。\n\n`;
    const STJP = { pass: '合格', warn: '要確認', fail: '不合格', na: '非該当' };
    aggs.forEach(({ group: g, agg }, idx) => {
      // 総合（人手override反映後の実効値で再計算）
      const req = agg.items.filter(i => i.required && effStatus(idx, i) !== 'na');
      const reqFail = req.filter(i => effStatus(idx, i) === 'fail').length;
      const reqWarn = req.filter(i => effStatus(idx, i) === 'warn').length;
      const critFail = agg.items.filter(i => i.critical && i.required && effStatus(idx, i) === 'fail').length;
      const overall = NevAggregate.decideOverall({ requiredFail: reqFail, requiredWarn: reqWarn, criticalFail: critFail, requiredFailForWarn: rule.settings.requiredFailForWarn });
      const passCnt = agg.items.filter(i => effStatus(idx, i) === 'pass').length;
      const naCnt = agg.items.filter(i => effStatus(idx, i) === 'na').length;
      txt += `■ ${g === 'manual' ? '旧・作図センター基準（R6旧マニュアル・参考／不合格断定なし）' : 'NeV要件判定'}: ${STJP[overall]}\n`;
      txt += `  合格 ${passCnt} / ${agg.items.length} 項目（必須 ${req.filter(i => effStatus(idx, i) === 'pass').length}/${req.length}${naCnt ? '・非該当' + naCnt : ''}${reqWarn ? '・要確認' + reqWarn : ''}${reqFail ? '・不合格' + reqFail : ''}）\n\n`;
      agg.items.forEach(it => {
        const eff = effStatus(idx, it);
        const ov = state.overrides[idx + ':' + it.id];
        const m = { pass: '[OK]', fail: '[NG]', warn: '[!?]', na: '[--]' }[eff] || '[?]';
        txt += `${m} ${it.label}${it.required ? '' : ' [任意]'}${ov ? '（人手: AI=' + it.status + (it.original_status ? '(降格前:' + it.original_status + ')' : '') + '→' + eff + '）' : ''}${state.ovMemos[idx + ':' + it.id] ? '（メモ: ' + state.ovMemos[idx + ':' + it.id] + '）' : ''}\n`;
        if (it.found_text) txt += `    検出: ${it.found_text}\n`;
        if (it.detail) txt += `    ${it.detail}\n`;
      });
      txt += '\n';
    });
    // 読み取り情報（配線の統括表/旗上げ合算等の検算用数値も監査記録として含める）
    const di = (result && result.detected_info) || {};
    const fmtV = v => typeof v === 'boolean' ? (v ? 'はい' : 'いいえ') : Array.isArray(v) ? v.map(x => (x && typeof x === 'object') ? Object.keys(x).map(kk => `${kk}:${x[kk]}`).join(' ') : String(x)).join('、') : (v && typeof v === 'object') ? Object.keys(v).map(kk => `${kk}:${v[kk]}`).join('、') : String(v);
    const diKeys = Object.keys(di).filter(k => (di[k] || di[k] === false) && k.charAt(0) !== '_' && k !== 'wire_annotations' && !(Array.isArray(di[k]) && !di[k].length));
    if (diKeys.length) {
      txt += '--- 読み取り情報 ---\n';
      diKeys.forEach(k => { txt += `${labelForInfo(k)}: ${fmtV(di[k])}\n`; });
      txt += '\n';
    }
    const flagRows = Array.isArray(di.wire_annotations) ? di.wire_annotations : [];
    if (flagRows.length) {
      txt += '--- 旗上げ（各区間の注記）一覧 ---\n';
      flagRows.forEach((a, i) => { txt += fmtFlagRow(a, i) + '\n'; });
      txt += '\n';
    }
    if (result && result.overall_comment) txt += `--- AI コメント ---\n${result.overall_comment}\n`;
    navigator.clipboard.writeText(txt).then(() => { $('copyBtn').textContent = '✓ コピーしました'; setTimeout(() => $('copyBtn').innerHTML = '&#128203; 結果をコピー', 1500); });
  });

  // ── 波④-1: Excelエクスポート（旧4ツールのExcel出力の復元・SheetJS利用） ──
  // シート構成: 「判定結果」「読み取り情報」「旗上げ一覧」（旗上げは配線ルート図のみ）。
  // CDN読込失敗時（オフライン・CDN障害）はボタンを無効化し説明を表示（機能自体は判定に必須でない）。
  if (typeof XLSX === 'undefined') {
    $('excelBtn').disabled = true;
    $('excelBtn').title = 'Excel出力ライブラリの読み込みに失敗したため利用できません（ページを再読み込みしてください）';
    $('excelNote').style.display = 'block';
  }
  $('excelBtn').addEventListener('click', () => {
    if (!lastRender || typeof XLSX === 'undefined') return;
    const { rule, aggs, result } = lastRender;
    const STJP = { pass: '合格', warn: '要確認', fail: '不合格', na: '非該当' };
    const groupLabelX = { nev: 'NeV要件判定', manual: '旧・作図センター基準（R6旧マニュアル・参考／不合格断定なし）' };
    const cats = rule.categories || {};
    const precLabel = precisionLabelFor(result) + ((result && result._partialCheck) ? `・部分チェック(${result._partialCheck}項目のみ)` : '');
    const judgedIso = (result && result._ts) || lastRender.restoredTs || null;
    const judgedStr = judgedIso ? new Date(judgedIso).toLocaleString('ja-JP') : new Date().toLocaleString('ja-JP');
    const runErrsXl = (result && result._runErrors) || [];

    // シート1: 判定結果（メタ情報＋総合＋項目明細。人手オーバーライド反映後の実効値で出力）
    const rows1 = [
      [(window.LOCAL_PACK_LABEL || 'NeV 図面チェックツール（統合版）') + ' 判定結果'],
      ['図面種別', rule.meta.drawingName, '事業区分', state.businessType === 'kiso' ? '基礎充電' : '目的地充電'],
      ['判定日時', judgedStr, '判定モード', precLabel],
      ['注記', 'AIによる一次判定＋人手確認の記録です。最終判断は目視確認済みが前提です。'],
      ...(lastRender.restoredTs ? [['注記', `履歴からの再表示を出力（エクスポート日時: ${new Date().toLocaleString('ja-JP')}）`]] : []),
      ...(runErrsXl.length ? [['注記', `部分結果: 一部が未実行（${runErrsXl.map(e => (e.model || '') + ': ' + (e.message || '')).join(' / ')}）。目視確認を強く推奨。`]] : []),
      ...((result && result._partialCheck) ? [['注記', `⚠ 部分チェック（${result._partialCheck}項目のみ再実行）: この記録は全項目チェックの代わりになりません。提出前には全項目チェックを実行してください。`]] : []),
      [],
      ['グループ', 'カテゴリ', '項目', '必須/任意', '判定（実効）', 'AI判定', '人手調整', '人手メモ', '検出内容', '詳細'],
    ];
    aggs.forEach(({ group: g, agg }, idx) => {
      const req = agg.items.filter(i => i.required && effStatus(idx, i) !== 'na');
      const reqFail = req.filter(i => effStatus(idx, i) === 'fail').length;
      const reqWarn = req.filter(i => effStatus(idx, i) === 'warn').length;
      const critFail = agg.items.filter(i => i.critical && i.required && effStatus(idx, i) === 'fail').length;
      const overall = NevAggregate.decideOverall({ requiredFail: reqFail, requiredWarn: reqWarn, criticalFail: critFail, requiredFailForWarn: rule.settings.requiredFailForWarn });
      rows1.push([groupLabelX[g] || g, '', '【総合判定】', '', STJP[overall] || overall, '', '', '',
        `合格 ${agg.items.filter(i => effStatus(idx, i) === 'pass').length}/${agg.items.length} 項目（必須 ${req.filter(i => effStatus(idx, i) === 'pass').length}/${req.length}）`, '']);
      agg.items.forEach(it => {
        const eff = effStatus(idx, it);
        const ov = state.overrides[idx + ':' + it.id];
        rows1.push([
          groupLabelX[g] || g,
          (cats[it.category] || {}).title || it.category || '',
          it.label || it.id,
          it.required ? '必須' : '任意',
          STJP[eff] || eff,
          (STJP[it.status] || it.status) + (it.original_status ? `（自動降格前:${STJP[it.original_status] || it.original_status}）` : ''),
          ov ? `あり（AI:${STJP[it.status] || it.status}→${STJP[eff] || eff}）` : '',
          state.ovMemos[idx + ':' + it.id] || '',
          it.found_text || '',
          it.detail || '',
        ]);
      });
      rows1.push([]);
    });

    // シート2: 読み取り情報（画面と同じラベル・整形）
    const di = (result && result.detected_info) || {};
    const fmtX = v => typeof v === 'boolean' ? (v ? 'はい' : 'いいえ')
      : Array.isArray(v) ? v.map(x => (x && typeof x === 'object') ? Object.keys(x).map(kk => `${kk}:${x[kk]}`).join(' ') : String(x)).join('、')
      : (v && typeof v === 'object') ? Object.keys(v).map(kk => `${kk}:${v[kk]}`).join('、') : String(v);
    const rows2 = [['項目', '読み取り値']];
    Object.keys(di).filter(k => (di[k] || di[k] === false) && k.charAt(0) !== '_' && k !== 'wire_annotations' && !(Array.isArray(di[k]) && !di[k].length))
      .forEach(k => rows2.push([labelForInfo(k), fmtX(di[k])]));
    if (rows2.length === 1) rows2.push(['（読み取り情報なし）', '']);

    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet(rows1);
    ws1['!cols'] = [{ wch: 22 }, { wch: 24 }, { wch: 32 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 22 }, { wch: 24 }, { wch: 40 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws1, '判定結果');
    const ws2 = XLSX.utils.aoa_to_sheet(rows2);
    ws2['!cols'] = [{ wch: 24 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(wb, ws2, '読み取り情報');

    // シート3: 旗上げ一覧（配線ルート図のみ＝wire_annotations がある場合のみ）
    const flags = Array.isArray(di.wire_annotations) ? di.wire_annotations : [];
    if (flags.length) {
      const rows3 = [['No', 'ケーブル', '配管', '配線方法', '距離(m)', '補足']];
      flags.forEach((a, i) => {
        const o = (a && typeof a === 'object') ? a : {};
        rows3.push([i + 1, o.cable || o.type || String(a || ''), o.conduit || '', o.method || '',
          (o.length_m != null && String(o.length_m) !== '') ? o.length_m : '', o.note || '']);
      });
      const ws3 = XLSX.utils.aoa_to_sheet(rows3);
      ws3['!cols'] = [{ wch: 5 }, { wch: 20 }, { wch: 14 }, { wch: 20 }, { wch: 10 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, ws3, '旗上げ一覧');
    }

    // ファイル名: 図面種別＋施設名（あれば）＋日時。Windowsで不正な文字は除去。
    const facility = String(di.facility_name || '').replace(/[\\\/:*?"<>|]/g, '').slice(0, 20);
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    XLSX.writeFile(wb, `NeV判定_${rule.meta.drawingName}${facility ? '_' + facility : ''}_${stamp}.xlsx`);
    $('excelBtn').textContent = '✓ ダウンロードしました';
    setTimeout(() => { $('excelBtn').innerHTML = '&#128202; Excelダウンロード'; }, 1500);
  });

  function showError(err) {
    const suggestions = (err.suggestions || []).map(s => `<li>${esc(s)}</li>`).join('');
    $('errorSection').innerHTML = `<div class="error-card">
      <strong>エラーが発生しました</strong>
      <p>${esc(err.message || String(err))}</p>
      ${suggestions ? `<ul>${suggestions}</ul>` : ''}
    </div>`;
  }

  // ── 波④-2: 判定履歴（localStorage・直近10件。旧・電気系統図ツールの履歴機能の復元） ──
  // 保存対象: マージ済み判定結果＋メタ情報。人手オーバーライドの状態は保存しない（UIに明記）。
  const HISTORY_KEY = 'nev_history';
  const HISTORY_MAX = 10;
  function getHistory() {
    try { const a = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function saveHistoryArr(arr) {
    // 容量超過（QuotaExceeded）は黙って古い順に間引いて再試行（履歴は補助機能＝失敗しても判定に影響させない）
    let a = arr;
    while (a.length) {
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(a)); return; } catch (e) { a = a.slice(0, a.length - 1); }
    }
    try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* noop */ }
  }
  function pushHistory(rule, result) {
    try {
      const aggs = NevVerdict.computeGroupAggs(rule, result, state.businessType);
      const overall = {};
      const counts = { fail: 0, warn: 0, pass: 0 };
      aggs.forEach(({ group, agg }) => {
        overall[group] = agg.overall;
        agg.items.forEach(i => { if (counts[i.status] != null) counts[i.status]++; });
      });
      const entry = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        ts: new Date().toISOString(),
        drawingType: state.drawingType,
        drawingName: rule.meta.drawingName,
        businessType: state.businessType,
        precision: state.precision,
        fileName: state.file ? state.file.name : '',
        overall, counts,
        result, // 復元用のマージ済み結果（override状態は含めない）
      };
      const arr = getHistory();
      arr.unshift(entry);
      saveHistoryArr(arr.slice(0, HISTORY_MAX));
      renderHistoryList();
      return entry.id;
    } catch (e) { /* 履歴保存の失敗は判定機能に影響させない */ }
  }
  function renderHistoryList() {
    const list = $('historyList');
    if (!list) return;
    const arr = getHistory();
    if (!arr.length) { list.innerHTML = '<p class="card-description">履歴はまだありません。判定を実行すると自動で保存されます（直近10件）。</p>'; return; }
    const STJP = { pass: '合格', warn: '要確認', fail: '不合格', na: '非該当' };
    const PRECJP = { normal: '通常(1回)', high: '高精度(3回多数決)', crossmodel: '2モデル一致' };
    list.innerHTML = arr.map(e => {
      const ov = Object.keys(e.overall || {}).map(g => `${g === 'manual' ? '参考' : 'NeV'}: ${STJP[e.overall[g]] || e.overall[g]}`).join(' ／ ');
      const cnt = e.counts ? `（不合格${e.counts.fail}・要確認${e.counts.warn}・合格${e.counts.pass}）` : '';
      let ts = e.ts; try { ts = new Date(e.ts).toLocaleString('ja-JP'); } catch (er) { /* keep raw */ }
      const partial = e.result && ((Array.isArray(e.result._runErrors) && e.result._runErrors.length) || (Array.isArray(e.result._models) && Array.isArray(e.result._ranModels) && e.result._ranModels.length < e.result._models.length)) ? '（部分結果）' : '';
      return `<button type="button" class="history-item" data-hid="${esc(e.id)}" style="display:block;width:100%;text-align:left;padding:8px 10px;margin-top:6px;border:1px solid var(--line);border-radius:8px;background:var(--card,#fff);cursor:pointer;font-size:13px;">
        <strong>${esc(e.drawingName || e.drawingType)}</strong> ／ ${e.businessType === 'kiso' ? '基礎充電' : '目的地充電'} ／ ${esc((PRECJP[e.precision] || e.precision || '') + partial)} ／ ${esc(ov)} ${esc(cnt)}<br>
        <span style="color:var(--muted);font-size:12px;">${esc(ts)}${e.fileName ? '　' + esc(e.fileName) : ''}</span>
      </button>`;
    }).join('');
  }
  function restoreHistory(entry) {
    if (running) { alert('チェック実行中は履歴を復元できません。キャンセルするか完了を待ってください。'); return; }
    const rule = NevRules.getRule(entry.drawingType);
    if (!rule || !entry.result) { alert('この履歴は復元できません（データ不足）'); return; }
    // 当時の事業区分・精度モード・図面種別にUIを同期（判定式・表示ラベルの整合のため）
    if (entry.businessType) {
      state.businessType = entry.businessType;
      document.querySelectorAll('#bizSeg button').forEach(b => b.classList.toggle('active', b.dataset.bt === state.businessType));
    }
    if (entry.precision) {
      state.precision = entry.precision;
      document.querySelectorAll('#precSeg button').forEach(b => b.classList.toggle('active', b.dataset.pr === state.precision));
    }
    selectDrawing(entry.drawingType);
    $('errorSection').innerHTML = '';
    state._restoringEntryId = entry.id; // 差分比較で自分自身と比較しないため
    try {
      // B-4: 当時の項目集合で表示（改定後の新項目を過去記録にphantom failとして混ぜない）
      renderResult(ruleForStoredResult(rule, entry.result), entry.result, null, null);
    } finally {
      state._restoringEntryId = null; // C-3: 例外時のリーク防止
    }
    if (lastRender) lastRender.restoredTs = entry.ts; // エクスポートに判定時刻・再表示注記を伝える（S3-3）
    // 第2波: 保存済みの人手確認（override＋メモ）を復元し、続きから編集可能にする
    state.overrides = Object.assign({}, entry.overrides || {});
    state.ovMemos = Object.assign({}, entry.ovMemos || {});
    state._historyId = entry.id;
    if (lastRender) {
      lastRender.aggs.forEach((g, i) => renderGroup(rule, g.group, g.agg, i, lastRender.backed));
      renderReviewSummary(lastRender.aggs, lastRender.result || {});
    }
    // S3-2: 当時の「部分結果」警告を再表示（保存済みの _runErrors を使う。出さないと完全な結果に見える＝誤安心）
    const rErrsH = Array.isArray(entry.result._runErrors) ? entry.result._runErrors : [];
    const plannedH = Array.isArray(entry.result._models) ? entry.result._models.length : null;
    const ranH = Array.isArray(entry.result._ranModels) ? entry.result._ranModels.length : (entry.result._voteRuns || null);
    if (rErrsH.length || (plannedH && ranH != null && ranH < plannedH)) {
      $('errorSection').innerHTML += `<div class="error-card" style="background:#fef3c7;border-color:#fcd34d;color:#92400e;"><strong>⚠ この判定は部分結果です${plannedH ? `（実行${ranH != null ? ranH : '?'}/${plannedH}回）` : ''}</strong><p>${esc(rErrsH.map(er => (er.model || '') + ': ' + (er.message || '')).join(' / ') || 'キャンセルまたはエラーにより一部が未実行のまま保存された判定です。')}<br>目視確認を強く推奨します。</p></div>`;
    }
    let ts = entry.ts; try { ts = new Date(entry.ts).toLocaleString('ja-JP'); } catch (er) { /* keep raw */ }
    $('resultTypeLabel').textContent += ' ／ 履歴表示';
    $('reviewSummary').insertAdjacentHTML('afterbegin',
      `<div class="review-note" style="background:#eff6ff;border-color:#bfdbfe;color:#1e40af;">&#128337; ${esc(ts)} の判定結果を履歴から再表示しています。人手確認（プルダウン・メモ）はこの履歴に保存され、続きから編集できます。設定（図面種別・事業区分・精度モード）も当時の値に切り替えているため、次回の実行前にご確認ください。※判定ルールが改定された場合、現在のルールで再集計するため、総合判定が履歴一覧のバッジと異なることがあります（例: 旧基準項目の不合格→要確認格下げ）。</div>`);
  }
  $('historyToggle').addEventListener('click', e => {
    e.preventDefault();
    const sec = $('historySection');
    const show = sec.style.display === 'none';
    if (show) renderHistoryList();
    sec.style.display = show ? 'block' : 'none';
    if (show) window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('historyClear').addEventListener('click', () => {
    if (!confirm('判定履歴（直近10件）をこのブラウザから削除します。よろしいですか？')) return;
    try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* noop */ }
    renderHistoryList();
  });
  $('historyList').addEventListener('click', e => {
    const btn = e.target.closest('.history-item'); if (!btn) return;
    const entry = getHistory().find(x => x.id === btn.dataset.hid);
    if (entry) restoreHistory(entry);
  });

  // 第2波: 不合格・要確認のみ再チェック（部分チェック・履歴保存なし）
  $('recheckFailBtn').addEventListener('click', () => {
    if (!lastRender) { alert('先にチェックを実行してください。'); return; }
    if (lastRender.result && lastRender.result._partialCheck) { alert('部分チェックの結果からは再絞り込みできません。全項目チェックを実行してください。'); return; }
    if (!state.file) { alert('チェック対象のPDFが読み込まれていません。対象のファイルを選択してから実行してください。'); return; }
    const rn = lastRender.result && lastRender.result._fileName;
    if (rn && state.file.name !== rn) { alert(`表示中の結果は「${rn}」のものですが、現在読み込まれているファイルは「${state.file.name}」です。取り違え防止のため中止しました。対象のPDFを選び直してください。`); return; }
    const rdt = lastRender.result && lastRender.result._drawingType;
    if (rdt && state.drawingType !== rdt) { alert('表示中の結果と現在選択中の図面種別が異なります。取り違え防止のため中止しました（図面種別タブを結果と同じものに戻してください）。'); return; }
    const rbt = lastRender.result && lastRender.result._businessType;
    if (rbt && state.businessType !== rbt) { alert('表示中の結果と現在選択中の事業区分が異なります。取り違え防止のため中止しました。'); return; }
    const ids = [];
    lastRender.aggs.forEach(({ agg }, idx) => {
      agg.items.forEach(i => { const eff = effStatus(idx, i); if (eff === 'fail' || eff === 'warn') ids.push(i.id); });
    });
    if (!ids.length) { alert('不合格・要確認の項目はありません。'); return; }
    if (!confirm(`不合格・要確認の ${ids.length} 項目のみ再チェックします（部分チェック・履歴保存なし）。実行しますか？`)) return;
    state.recheckIds = ids;
    runCheck();
  });

  // 第2波: 修正指示書（不合格・要確認のみ抽出・CAD担当/外注へ渡す様式）
  $('fixSheetBtn').addEventListener('click', () => {
    if (typeof XLSX === 'undefined') { alert('Excel出力ライブラリが読み込まれていません。ページを再読み込みしてください。'); return; }
    if (!lastRender) { alert('先にチェックを実行してください。'); return; }
    const { rule, aggs, result } = lastRender;
    const STJP = { pass: '合格', warn: '要確認', fail: '不合格', na: '非該当' };
    const cats = rule.categories || {};
    const rows = [
      ['NeV図面 修正指示書（AI一次チェック＋人手確認に基づく）'],
      ['図面種別', rule.meta.drawingName, 'ファイル', (result && result._fileName) || '', '作成日時', new Date().toLocaleString('ja-JP')],
      ['注記', 'AIの指摘には誤りがあり得ます。修正前に必ず原図面と突き合わせてください。人手確認済みの項目（メモ欄参照）を優先してください。'],
      ...((result && result._partialCheck) ? [['注記', `⚠ 部分チェック（${result._partialCheck}項目のみ）の結果から作成した指示書です。全項目の指摘ではありません。`]] : []),
      [],
      ['No', 'グループ', 'カテゴリ', '項目', '判定', 'ページ・位置', '検出内容', '判定理由', '要件（直すべき内容）', '出典', '人手確認メモ', '修正者記入欄'],
    ];
    let no = 0;
    const checkById = {};
    (rule.checks || []).forEach(c => { checkById[c.id] = c; });
    aggs.forEach(({ group: g, agg }, idx) => {
      agg.items.forEach(it => {
        const eff = effStatus(idx, it);
        if (eff !== 'fail' && eff !== 'warn') return;
        no++;
        const posM = String(it.detail || '').match(/P\d+[^。、]{0,24}/);
        const def = checkById[it.id] || {};
        rows.push([
          no,
          g === 'manual' ? '旧社内基準（R6・参考）' : 'NeV要件',
          (cats[it.category] || {}).title || it.category || '',
          it.label || it.id,
          STJP[eff] || eff,
          posM ? posM[0] : '',
          it.found_text || '',
          it.detail || '',
          def.description || '',
          srcLabelFor(it, g),
          state.ovMemos[idx + ':' + it.id] || '',
          '',
        ]);
      });
    });
    if (no === 0) { alert('不合格・要確認の項目はありません（修正指示書の対象なし）。'); return; }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 4 }, { wch: 14 }, { wch: 14 }, { wch: 32 }, { wch: 8 }, { wch: 18 }, { wch: 28 }, { wch: 40 }, { wch: 40 }, { wch: 12 }, { wch: 24 }, { wch: 24 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '修正指示書');
    const dt = new Date();
    const stamp = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}_${String(dt.getHours()).padStart(2, '0')}${String(dt.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `NeV修正指示書_${rule.meta.drawingName}_${stamp}.xlsx`);
  });

  // ── 起動 ──
  buildDrawingTabs();
  // ローカル個別ツール版（build-local-pack生成ページ）: 図面種別を固定しタブを隠す。未定義なら従来どおり
  if (window.LOCK_DRAWING_TYPE && NevRules.getRule(window.LOCK_DRAWING_TYPE)) {
    selectDrawing(window.LOCK_DRAWING_TYPE);
    const tabs = $('drawingTabs'); if (tabs) tabs.style.display = 'none';
  }
  // pdf.js（CDN）の読み込み失敗を明示する。放置すると「ファイルが破損している可能性」等の
  // 無関係なエラー文言に化けて誤誘導になる（XLSX側の同等ガードとの対称化）。
  if (typeof window.pdfjsLib === 'undefined' || !window.pdfjsLib) {
    $('errorSection').innerHTML += '<div class="error-card"><strong>⚠ PDF処理ライブラリ（pdf.js）の読み込みに失敗しました</strong><p>ネットワーク接続（CDNへのアクセス）を確認して、ページを再読み込みしてください。このままではPDFを処理できません。</p></div>';
  } else {
    $('fileInput').disabled = false; // 初期化完了までは無効（低速回線でリスナー未登録のまま選択→黙って捨てられるのを防ぐ）
  }
  updateCheckButton();
});
