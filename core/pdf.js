/* ============================================================
   core/pdf.js — PDF → 画像化 / PDFネイティブ入力 / プレビュー生成
   出典: 配線ルート図ツール checker.js から抽出。図面種別に依存しないよう
         ページ数・スケール・ペイロード上限を opts で受けられるよう一般化。
   依存: pdf.js（pdfjsLib）, document/canvas（ブラウザ専用）
   ============================================================ */
(function (root) {
  'use strict';

  const MAX_CANVAS_PIXELS = 16_000_000;
  const MAX_CANVAS_DIM = 4096;

  const DEFAULTS = {
    maxPages: 6,
    renderScale: 3.0,
    maxPayloadBytes: 18_000_000,     // JPEG化: base64合計の安全上限
    maxNativeBase64: 18_000_000,     // ネイティブ入力: inline_data(20MB)の安全マージン
    previewScale: 1.5,
    jpegQuality: 0.92,
  };

  // キャンバス上限を超えないよう安全なスケールへ丸める
  function calcSafeScale(page, targetScale) {
    const viewport = page.getViewport({ scale: targetScale });
    const w = viewport.width;
    const h = viewport.height;
    if (w > MAX_CANVAS_DIM || h > MAX_CANVAS_DIM) {
      const dimRatio = Math.min(MAX_CANVAS_DIM / w, MAX_CANVAS_DIM / h);
      return targetScale * dimRatio;
    }
    if (w * h > MAX_CANVAS_PIXELS) {
      const pixelRatio = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
      return targetScale * pixelRatio;
    }
    return targetScale;
  }

  // D: 解析対象ページの解決（純関数・Nodeテスト可能）。
  //   pages 未指定 → 先頭 maxPages ページ（従来と同一挙動＝回帰ゼロ）。
  //   pages 指定   → 1..pageCount 内の整数のみ・一意化・昇順・最大 maxPages 枚に制限。
  //   有効なページが1枚も残らなければ先頭Nにフォールバック（空選択で解析不能にしない）。
  function resolveTargetPages(pageCount, maxPages, pages) {
    const cap = Math.min(pageCount, maxPages);
    if (Array.isArray(pages) && pages.length) {
      const valid = Array.from(new Set(pages))
        .filter(n => Number.isInteger(n) && n >= 1 && n <= pageCount)
        .sort((a, b) => a - b)
        .slice(0, maxPages);
      if (valid.length) return valid;
    }
    const out = [];
    for (let i = 1; i <= cap; i++) out.push(i);
    return out;
  }

  // pdf.js の render は環境（GPU/ドライバ/ヘッドレス）によって解決も拒否もしないままハングすることがある
  // （2026-07-23 検証環境で実測: page.render が console エラーなしで永久未解決）。ハングすると呼び出し側の
  // await が永久待機し、キャンセル（AbortSignal は fetch のみ）でも中断できずリロード以外に復旧手段がなくなる。
  // → 全 render 呼び出しにタイムアウトを設ける。補助画像（プレビュー/クロップ/サムネイル）は既存の
  //   「失敗時スキップ」設計に乗せ、本命の画像化（pdfToImages）は明示エラーで可視化する。
  function renderWithTimeout(renderTask, ms, label) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        try { renderTask.cancel(); } catch (e) { /* noop */ }
        reject(new Error(`${label || 'PDFレンダリング'}がタイムアウトしました（${Math.round(ms / 1000)}秒）。ページを再読み込みして再実行してください。`));
      }, ms);
      renderTask.promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
  }

  // PDF → ページ単位の JPEG（base64）配列。maxPages で打ち切り。
  // truncated: ページ超過/ペイロード超過で一部ページを含められなかった場合 true（見逃し防止の警告用）。
  // scanned: テキスト層が無い（スキャン画像）と判定した場合 true。その場合は描画スケールを上げてOCR精度を確保。
  // opts.pages: 解析対象ページ番号の配列（例 [1,3,5]。1-indexed）。省略時は先頭 maxPages ページ（従来挙動）。
  async function pdfToImages(file, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    let pdf;
    try {
      const arrayBuffer = await file.arrayBuffer();
      pdf = await pdfjsLib.getDocument({ data: arrayBuffer, isEvalSupported: false /* FZ-2: CVE-2024-4367対策 */ }).promise;
    } catch (e) {
      throw new Error('PDFファイルの読み込みに失敗しました。ファイルが破損しているか、パスワードで保護されている可能性があります。');
    }

    const images = [];
    const pageCount = pdf.numPages;
    const targetPages = resolveTargetPages(pageCount, o.maxPages, o.pages);
    let totalBase64Size = 0;

    // テキスト層の有無を1ページ目で判定（無ければスキャンPDF→高DPIでOCR精度確保）
    let scanned = false;
    try {
      const tc = await (await pdf.getPage(1)).getTextContent();
      scanned = !tc || !tc.items || tc.items.length === 0;
    } catch (e) { /* 判定不能時は通常スケール */ }
    const baseScale = scanned ? (o.scannedScale || 4.0) : o.renderScale;

    for (const i of targetPages) {
      const page = await pdf.getPage(i);
      const safeScale = calcSafeScale(page, baseScale);
      const viewport = page.getViewport({ scale: safeScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');

      await renderWithTimeout(page.render({ canvasContext: ctx, viewport }), o.renderTimeoutMs || 60000, `ページ${i}の画像化`);
      const dataUrl = canvas.toDataURL('image/jpeg', o.jpegQuality);
      const base64 = dataUrl.split(',')[1];
      totalBase64Size += base64.length;

      if (totalBase64Size > o.maxPayloadBytes) {
        console.warn(`ページ${i}でペイロードサイズ上限に近づいたため、以降のページをスキップします`);
        canvas.width = 0; canvas.height = 0;
        break;
      }

      images.push({ base64, mimeType: 'image/jpeg', pageNum: i });
      canvas.width = 0; canvas.height = 0;
    }

    if (images.length === 0) throw new Error('PDFから画像を生成できませんでした。');
    return { images, pageCount, truncated: images.length < pageCount, scanned };
  }

  // D: ページ選択UI用の軽量サムネイル生成（旧・電気系統図ツール pdfGetPageThumbnails の移植）。
  // 先頭 maxThumbs ページ分の小さな JPEG dataUrl を返す。失敗ページはスキップ。
  async function pdfGetPageThumbnails(file, opts) {
    const o = Object.assign({ maxThumbs: 12, thumbW: 220, thumbH: 160 }, opts || {});
    const arrayBuffer = await file.arrayBuffer();
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({ data: arrayBuffer, isEvalSupported: false /* FZ-2 */ }).promise;
    } catch (e) {
      throw new Error('PDFファイルの読み込みに失敗しました。');
    }
    try {
      const totalPages = pdf.numPages;
      const n = Math.min(totalPages, o.maxThumbs);
      const thumbs = [];
      for (let i = 1; i <= n; i++) {
        try {
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          const scale = Math.min(o.thumbW / vp.width, o.thumbH / vp.height, 1);
          const sv = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.floor(sv.width));
          canvas.height = Math.max(1, Math.floor(sv.height));
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await renderWithTimeout(page.render({ canvasContext: ctx, viewport: sv }), o.auxRenderTimeoutMs || 15000, `ページ${i}のサムネイル生成`);
          thumbs.push({ pageNumber: i, dataUrl: canvas.toDataURL('image/jpeg', 0.6) });
          canvas.width = 0; canvas.height = 0;
        } catch (e) { /* このページのサムネイルのみ諦める */ }
      }
      return { totalPages, thumbs };
    } finally {
      try { pdf.destroy(); } catch (e) { /* noop */ }
    }
  }

  // PDF をそのまま base64 で Gemini に渡す（テキスト層を保持し誤読を抑制）。
  // サイズ超過時は呼び出し側で pdfToImages にフォールバックする想定。
  async function pdfToNative(file, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const arrayBuffer = await file.arrayBuffer();

    let pageCount = 0;
    try {
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0), isEvalSupported: false }).promise;
      pageCount = pdf.numPages;
      pdf.destroy();
    } catch (e) {
      throw new Error('PDFファイルの読み込みに失敗しました。ファイルが破損しているか、パスワードで保護されている可能性があります。');
    }

    let bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const base64 = btoa(binary);
    binary = null; bytes = null;

    if (base64.length > o.maxNativeBase64) {
      throw new Error(`PDFサイズが大きすぎます（${Math.round(base64.length / 1_000_000)}MB）。画像変換モードにフォールバックします。`);
    }

    return {
      images: [{ base64, mimeType: 'application/pdf' }],
      pageCount,
      nativeMode: true,
    };
  }

  // 1ページ目のプレビュー用 canvas を返す（失敗時 null）。
  async function pdfToPreview(file, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer, isEvalSupported: false /* FZ-2: CVE-2024-4367対策 */ }).promise;
      const page = await pdf.getPage(1);
      const safeScale = calcSafeScale(page, o.previewScale);
      const viewport = page.getViewport({ scale: safeScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas context の取得に失敗しました');
      await renderWithTimeout(page.render({ canvasContext: ctx, viewport }), o.auxRenderTimeoutMs || 30000, 'プレビュー生成');
      return canvas;
    } catch (e) {
      console.error('プレビュー生成エラー:', e);
      return null;
    }
  }

  // 表題欄の拡大読み取り用: 対象ページ（既定1ページ目）を高倍率でレンダリングし、下部帯（表題欄がある領域）を切り出す。
  // 必須項目（設置場所/図面名称/作成者/縮尺/作成日）が集中する小さな文字の読取精度を上げる補助画像。
  // opts.pageNum: 切り出すページ番号（D: ページ選択時は選択先頭ページに合わせる）。失敗時は null（呼び出し側は付けずに続行）。
  async function pdfToTitleBlockCrop(file, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer, isEvalSupported: false /* FZ-2: CVE-2024-4367対策 */ }).promise;
      const pageNum = (Number.isInteger(o.pageNum) && o.pageNum >= 1 && o.pageNum <= pdf.numPages) ? o.pageNum : 1;
      const page = await pdf.getPage(pageNum);
      const scale = calcSafeScale(page, o.titleBlockScale || 4.0);
      const viewport = page.getViewport({ scale });
      const full = document.createElement('canvas');
      full.width = Math.floor(viewport.width);
      full.height = Math.floor(viewport.height);
      const ctx = full.getContext('2d');
      if (!ctx) return null;
      await renderWithTimeout(page.render({ canvasContext: ctx, viewport }), o.auxRenderTimeoutMs || 30000, '表題欄クロップ生成');
      // 下部35%の帯（表題欄は下辺に沿って配置されることが多い）を切り出す
      const bandRatio = o.titleBlockBandRatio || 0.35;
      const cropY = Math.floor(full.height * (1 - bandRatio));
      const cropH = full.height - cropY;
      const crop = document.createElement('canvas');
      crop.width = full.width;
      crop.height = cropH;
      crop.getContext('2d').drawImage(full, 0, cropY, full.width, cropH, 0, 0, full.width, cropH);
      const dataUrl = crop.toDataURL('image/jpeg', o.jpegQuality);
      full.width = 0; full.height = 0; crop.width = 0; crop.height = 0;
      return { base64: dataUrl.split(',')[1], mimeType: 'image/jpeg', titleBlock: true };
    } catch (e) {
      console.warn('表題欄クロップ生成に失敗（スキップ）:', e && e.message);
      return null;
    }
  }

  root.NevPdf = { DEFAULTS, calcSafeScale, resolveTargetPages, pdfToImages, pdfToNative, pdfToPreview, pdfToTitleBlockCrop, pdfGetPageThumbnails };
  // Node（テスト）からは純関数部分（resolveTargetPages 等）のみ利用可能。描画系はブラウザ専用。
  if (typeof module !== 'undefined' && module.exports) module.exports = root.NevPdf;

})(typeof window !== 'undefined' ? window : globalThis);
