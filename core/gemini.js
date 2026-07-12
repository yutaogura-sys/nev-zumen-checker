/* ============================================================
   core/gemini.js — Gemini API 呼び出し・リトライ・モデル検証・JSON抽出
   出典: 配線ルート図ツール checker.js から抽出（ロジックは同一）。
   依存: fetch / btoa（ブラウザ or Node18+）。図面種別に依存しない。
   ============================================================ */
(function (root) {
  'use strict';

  const MODELS = [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'free' },
    { id: 'gemini-2.5-pro',   name: 'Gemini 2.5 Pro',   tier: 'paid' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', tier: 'free' },
  ];

  // モデル別の最大出力トークン（2.5系は内部推論=thinkingがバジェットを消費するため余裕を確保）
  const MAX_TOKENS_BY_MODEL = {
    'gemini-2.5-pro':   32768,
    'gemini-2.5-flash': 32768,
    'gemini-2.0-flash': 8192,
  };

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  // F-8: リトライ待機中もキャンセルに即応答する sleep（quota待ち最大121秒中の無反応を解消）
  function sleepAbortable(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(abortedError()); return; }
      const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      function onAbort() { clearTimeout(t); reject(abortedError()); }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ─── モデル別接続テスト ────────────────────────────────
  async function verifyModel(apiKey, modelId) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelId}?key=${apiKey}`, // v1beta: 2.5系モデルの照会に対応
        { method: 'GET' }
      );
      if (!response.ok) {
        if (response.status === 503 || response.status === 500) return { available: true, reason: '' };
        const data = await response.json().catch(() => ({}));
        return { available: false, reason: data?.error?.message || `HTTP ${response.status}` };
      }
      return { available: true, reason: '' };
    } catch (e) {
      return { available: false, reason: '接続エラー' };
    }
  }

  // ─── 有料キー判定（Proに軽量リクエストを送りクォータを確認）───────
  async function checkPaidTier(apiKey) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Say "ok"' }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 1 },
          }),
        }
      );
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const msg = data?.error?.message || '';
        if (response.status === 429 && msg.includes('free_tier')) return false;
        if (response.status === 403 && (msg.includes('free_tier') || msg.includes('billing'))) return false;
        if (response.status >= 500) return true;
        if (response.status === 429) return true;
        if (msg.includes('free') || msg.includes('quota') || msg.includes('billing')) return false;
      }
      return true;
    } catch (e) {
      return true;
    }
  }

  async function verifyAllModels(apiKey) {
    const results = {};
    await Promise.all(MODELS.map(async (model) => {
      results[model.id] = await verifyModel(apiKey, model.id);
    }));
    const isPaid = await checkPaidTier(apiKey);
    if (!isPaid) {
      MODELS.forEach(model => {
        if (model.tier === 'paid' && results[model.id]?.available) {
          results[model.id] = {
            available: false,
            reason: '有料プランが必要です。Google AI Studio で課金を有効にしてください。',
          };
        }
      });
    }
    return results;
  }

  async function verifyApiKey(apiKey) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        { method: 'GET' }
      );
      return response.ok;
    } catch (e) {
      return false;
    }
  }

  // 波④-3: 実行キャンセル（AbortController）用のエラー生成。
  // 旧・電気系統図ツールのキャンセル機能の復元。type='aborted' はリトライ対象にしない。
  function abortedError() {
    const err = new Error('キャンセルしました（実行済み・送信済みの呼び出し分は課金されます。未送信分の課金はありません）');
    err.type = 'aborted';
    return err;
  }

  // ─── Gemini API 呼び出し（決定論設定 temperature=0/topK=1）──────
  //   opts.signal: AbortSignal（実行キャンセル用。fetch に渡す）
  async function callGemini(apiKey, images, prompt, modelId, opts) {
    opts = opts || {};
    if (opts.signal && opts.signal.aborted) throw abortedError();
    const imageParts = images.map(img => ({
      inline_data: { mime_type: img.mimeType, data: img.base64 }
    }));
    const useModel = modelId || 'gemini-2.5-flash';
    // FZ-3: モデル上限を超える要求はクランプ（rulesの32768が2.0Flash(上限8192)へ素通りして400になるのを防ぐ）
    const modelCap = MAX_TOKENS_BY_MODEL[useModel] || 32768;
    const maxOutputTokens = (typeof opts.maxOutputTokens === 'number')
      ? Math.min(opts.maxOutputTokens, modelCap)
      : modelCap;

    const requestBody = {
      contents: [{ parts: [{ text: prompt }, ...imageParts] }],
      // 既定は決定論設定（temperature 0/topK 1）。高精度多数決では呼び出し側が意図的に
      // temperature を上げて独立な複数意見を得る（旧・平面図ツールの精密モード=0.4/40 準拠）。
      generationConfig: {
        temperature: (typeof opts.temperature === 'number') ? opts.temperature : 0,
        topK: (typeof opts.topK === 'number') ? opts.topK : 1,
        maxOutputTokens,
      },
    };

    let bodyStr = JSON.stringify(requestBody);
    let response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store',
            'Pragma': 'no-cache',
          },
          cache: 'no-store',
          body: bodyStr,
          signal: opts.signal, // 波④-3: 実行キャンセル（undefined なら従来どおり）
        }
      );
    } catch (networkErr) {
      bodyStr = null;
      // 波④-3: ユーザーによる中断はネットワークエラーと区別する（リトライさせない）
      if ((networkErr && networkErr.name === 'AbortError') || (opts.signal && opts.signal.aborted)) throw abortedError();
      throw new Error('ネットワーク接続エラー: インターネット接続を確認してください。');
    }
    bodyStr = null;

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const errMsg = errData?.error?.message || '';
      const status = response.status;

      // FZ-4: quota検出をメッセージ表現ゆれに強く（"Resource has been exhausted" / "rate limit" 等）
      if (status === 429 || /quota|exhaust|rate limit/i.test(errMsg)) {
        const isFreeTier = errMsg.includes('free_tier');
        const retryMatch = errMsg.match(/retry in ([\d.]+)s/i);
        const retrySec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : null;
        const err = new Error(
          isFreeTier
            ? `【無料枠クォータ超過】モデル「${useModel}」の無料枠が上限に達しました。`
            : `【レート制限】モデル「${useModel}」のリクエスト制限に達しました。`
        );
        err.type = 'quota_exceeded';
        err.isFreeTier = isFreeTier;
        err.model = useModel;
        err.retryAfterSec = retrySec;
        err.suggestions = [];
        if (isFreeTier) {
          err.suggestions.push('Google AI Studio の課金設定で「有料枠（Pay-as-you-go）」を有効にしてください');
          err.suggestions.push('https://aistudio.google.com/apikey でAPIキーの課金設定を確認');
        }
        if (useModel.includes('pro')) {
          err.suggestions.push('Gemini 2.5 Flash や 2.0 Flash に切り替えると制限が緩和されます');
        }
        if (typeof retrySec === 'number' && retrySec >= 0) {
          err.suggestions.push(
            retrySec === 0 ? 'すぐに再試行可能です（レート制限は解除されています）' : `約${retrySec}秒後に再試行可能です`
          );
        }
        throw err;
      }

      if (status === 503 || status === 500 || errMsg.includes('high demand') || errMsg.includes('overloaded') || errMsg.includes('temporarily unavailable')) {
        const err = new Error(
          status === 503 || errMsg.includes('high demand')
            ? `モデル「${useModel}」は現在アクセスが集中しており、一時的に応答できません。`
            : `Gemini API でサーバーエラーが発生しました（HTTP ${status}）。`
        );
        err.type = 'server_overload';
        err.model = useModel;
        err.statusCode = status;
        throw err;
      }

      throw new Error(errMsg || `API エラー (${status})`);
    }

    const data = await response.json();
    if (!data.candidates || data.candidates.length === 0) {
      const blockReason = data.promptFeedback?.blockReason;
      if (blockReason) throw new Error(`Gemini がリクエストをブロックしました（理由: ${blockReason}）。別の図面で再試行してください。`);
      throw new Error('Gemini から応答が返りませんでした。しばらく待ってから再試行してください。');
    }

    const candidate = data.candidates[0];
    // FZ-5: 失敗経路（MAX_TOKENS/パース失敗）でも課金は発生している。呼び出し元がコスト計上
    // できるよう、usageMetadata を throw する Error にも添付する（上限警告の遅発防止）。
    const usageMetadata = data.usageMetadata || {};
    const finishReason = candidate.finishReason || '';
    if (finishReason === 'SAFETY') throw new Error('Gemini の安全フィルタにより応答がブロックされました。');

    const parts = candidate?.content?.parts || [];
    let text = null;
    for (let pi = parts.length - 1; pi >= 0; pi--) {
      if (parts[pi].text != null) { text = parts[pi].text; break; }
    }

    if (!text && finishReason === 'MAX_TOKENS') {
      const err = new Error(
        `Gemini の応答がトークン上限 (${maxOutputTokens}) に達し、本文が空で返されました。` +
        `内部推論 (thinking) がバジェットを使い切った可能性があります。モデルを変更するか、しばらく待ってから再試行してください。`
      );
      err.type = 'parse_error';
      err.finishReason = finishReason;
      err.model = useModel;
      err.usageMetadata = usageMetadata;
      throw err;
    }
    if (!text) {
      const err = new Error('Gemini から有効なテキスト応答が得られませんでした。再試行してください。');
      err.usageMetadata = usageMetadata;
      throw err;
    }

    let jsonStr = text;
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1];

    try {
      const parsed = JSON.parse(jsonStr.trim());
      // FA-D: モデル出力を既知フィールドのみに射影する。モデルが _deterministic 等の内部フラグを
      // echo すると「根拠必須」「確信度low降格」の両ゲートをバイパスできてしまうため遮断する。
      ['results', 'nev_results', 'manual_results'].forEach(k => {
        if (Array.isArray(parsed[k])) {
          parsed[k] = parsed[k].map(r => (r && typeof r === 'object') ? {
            id: r.id, status: r.status, confidence: r.confidence,
            found_text: r.found_text, detail: r.detail,
          } : r);
        }
      });
      if (parsed.detected_info && typeof parsed.detected_info === 'object') {
        Object.keys(parsed.detected_info).forEach(k => { if (k.charAt(0) === '_') delete parsed.detected_info[k]; });
      }
      parsed._usageMetadata = usageMetadata;
      parsed._model = useModel;
      return parsed;
    } catch (parseErr) {
      console.error('Gemini応答のJSONパースに失敗:', text.substring(0, 500));
      let reason = '';
      if (finishReason === 'MAX_TOKENS') reason = '原因: 応答がトークン上限に達し、JSONが途中で切れました。';
      else if (finishReason === 'RECITATION') reason = '原因: Gemini が応答を途中で停止しました（RECITATION）。';
      else if (text.length < 100) reason = '原因: Gemini の応答が極端に短く、有効なJSONが含まれていません。';
      else if (!text.includes('{')) reason = '原因: Gemini がJSON形式ではなくテキスト形式で応答しました。';
      else reason = '原因: Gemini の応答に不正なJSON構文が含まれていました。';
      const suggestion = finishReason === 'MAX_TOKENS'
        ? 'ページ数の少ないPDFで再試行するか、別のモデルをお試しください。'
        : 'もう一度チェックを実行してください。繰り返す場合はモデルを変更してください。';
      const err = new Error(`Gemini の応答を解析できませんでした。\n${reason}\n${suggestion}`);
      err.type = 'parse_error';
      err.finishReason = finishReason;
      err.model = useModel;
      err.usageMetadata = usageMetadata; // A-2: 最頻の失敗形態（JSON途中切れ）でもコスト計上できるように
      err.responsePreview = text.substring(0, 200).replace(/\n/g, ' ');
      throw err;
    }
  }

  // ─── リトライラッパ（server_overload:指数バックオフ / quota:指定秒 / network:短backoff）──
  async function callGeminiWithRetry(apiKey, images, prompt, modelId, onProgress, passContext, opts) {
    const MAX_TRANSIENT = 3, MAX_QUOTA = 1, MAX_NETWORK = 2;
    let transientCount = 0, quotaCount = 0, networkCount = 0;

    while (true) {
      try {
        return await callGemini(apiKey, images, prompt, modelId, opts);
      } catch (err) {
        // 波④-3: ユーザーによる中断は即時伝播（リトライ・待機をしない）
        if (err.type === 'aborted') throw err;
        if (err.type === 'server_overload' && transientCount < MAX_TRANSIENT) {
          transientCount++;
          const waitMs = 2000 * Math.pow(2, transientCount - 1);
          const waitSec = Math.round(waitMs / 1000);
          if (onProgress && passContext) onProgress({ ...passContext, message: `サーバー応答待機中... ${waitSec}秒後に再試行 (${transientCount}/${MAX_TRANSIENT})`, retry: true, retryReason: 'server_overload' });
          await sleepAbortable(waitMs, opts && opts.signal);
          continue;
        }
        // FZ-4: 待機は120秒まで（日次クォータの数時間待ちで無言ハングしない。超える場合は即エラー返却）
        if (err.type === 'quota_exceeded' && typeof err.retryAfterSec === 'number' && err.retryAfterSec >= 0 && err.retryAfterSec <= 120 && quotaCount < MAX_QUOTA) {
          quotaCount++;
          const waitMs = (err.retryAfterSec + 1) * 1000;
          const waitSec = Math.ceil(waitMs / 1000);
          if (onProgress && passContext) onProgress({ ...passContext, message: `レート制限のため ${waitSec}秒後に再試行中... (${quotaCount}/${MAX_QUOTA})`, retry: true, retryReason: 'quota_exceeded' });
          await sleepAbortable(waitMs, opts && opts.signal);
          continue;
        }
        if (err.message && err.message.indexOf('ネットワーク接続エラー') === 0 && networkCount < MAX_NETWORK) {
          networkCount++;
          const waitMs = 2000 * networkCount;
          const waitSec = Math.round(waitMs / 1000);
          if (onProgress && passContext) onProgress({ ...passContext, message: `ネットワークエラー、${waitSec}秒後に再試行 (${networkCount}/${MAX_NETWORK})`, retry: true, retryReason: 'network' });
          await sleepAbortable(waitMs, opts && opts.signal);
          continue;
        }
        throw err;
      }
    }
  }

  const api = {
    MODELS, MAX_TOKENS_BY_MODEL,
    verifyModel, checkPaidTier, verifyAllModels, verifyApiKey,
    callGemini, callGeminiWithRetry, sleep,
  };
  root.NevGemini = api;
  // Node（回帰harness）から require するためのエクスポート。fetch は Node18+ 内蔵。
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
