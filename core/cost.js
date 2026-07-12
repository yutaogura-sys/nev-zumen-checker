/* ============================================================
   core/cost.js — 料金概算 ＋ 料金上限の警告・超過表示
   出典: 配線ルート図ツール checker.js の PRICING / estimateCost を抽出し、
         組織方針「料金上限に近づいたら警告 / 超過者に○○円オーバーと表示」を
         満たす CapTracker を追加。
   ブラウザ / Node どちらでも動作（localStorageは注入 or 省略可）
   ============================================================ */
(function (root) {
  'use strict';

  // 単位: USD per 1M tokens（2026年7月に公式価格で更新。旧値は2.5-flashを入力2倍・出力4倍過小計上しており
  // 上限警告が遅れる原因だった）。※2.5-proは200Kトークン超の入力で $2.50/$15.00 に上がる段階制だが、
  // ここでは基本レートで概算（保守側に倒したい場合は将来段階制対応）。
  const PRICING = {
    'gemini-2.5-pro':   { input: 1.25, output: 10.00, label: 'Gemini 2.5 Pro' },
    'gemini-2.5-flash': { input: 0.30, output: 2.50,  label: 'Gemini 2.5 Flash' },
    'gemini-2.0-flash': { input: 0.10, output: 0.40,  label: 'Gemini 2.0 Flash' },
  };

  const DEFAULT_USD_TO_JPY = 150; // 概算レート（既存踏襲。設定で上書き可）

  // ─── 1回の API 呼び出しの料金概算 ─────────────────────────
  function estimateCost(usage, modelId, rate) {
    if (!usage) return null;
    // 1-D: 未知モデルは最高単価(Pro)で保守側に概算する。最安単価だと過小計上になり、
    // 組織方針の「上限に近づいたら警告/超過額表示」が遅発・不発になるため。
    const pricing = PRICING[modelId] || PRICING['gemini-2.5-pro'];
    const usdToJpy = (typeof rate === 'number' && rate > 0) ? rate : DEFAULT_USD_TO_JPY;

    // トークン数が非数値でも NaN を作らない（NaNが月次累計を汚染すると上限警告が消える/黙って0リセットされる）
    const num = v => { const n = Number(v); return (Number.isFinite(n) && n > 0) ? n : 0; };
    const inputTokens = num(usage.promptTokenCount);
    // Gemini 2.5系の思考(thinking)トークンは出力レートで課金される。candidates だけだと過小計上になり、
    // 料金上限の警告・超過判定が遅れる/発火しない（組織方針の信頼性に直結）。thoughts を出力に合算する。
    const thoughtTokens = num(usage.thoughtsTokenCount);
    const outputTokens = num(usage.candidatesTokenCount) + thoughtTokens;
    const totalTokens = num(usage.totalTokenCount) || (inputTokens + outputTokens);

    const inputCostUsd = (inputTokens / 1_000_000) * pricing.input;
    const outputCostUsd = (outputTokens / 1_000_000) * pricing.output;
    const totalCostUsd = inputCostUsd + outputCostUsd;
    const totalCostJpy = totalCostUsd * usdToJpy;

    return {
      model: pricing.label,
      inputTokens,
      outputTokens,
      totalTokens,
      inputCostUsd: Math.round(inputCostUsd * 10000) / 10000,
      outputCostUsd: Math.round(outputCostUsd * 10000) / 10000,
      totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
      totalCostJpy: Math.round(totalCostJpy * 100) / 100,
    };
  }

  // ─── 料金上限トラッカー（組織方針・必須）──────────────────────
  // ブラウザ（localStorage）単位で API 利用額を「月別」に累計し、
  //   ・上限の warnRatio 以上 → 警告
  //   ・上限を超過        → 「○○円 オーバー」を提示
  // を判定する。store を注入すれば Node からも単体テスト可能。
  //
  // 波④-4: 月次コスト管理（旧・電気系統図ツールの monthKey 方式の復元）。
  //   キーを nev_cost_total_YYYYMM の月別にし、月替わりで自動的に0から再計上（自動リセット）。
  //   旧キー nev_cost_total_jpy（無期限累計）が残っている場合は、初回アクセス時に
  //   当月分へ移行して旧キーを削除する（累計の消失防止）。過去月のキーは監査用に残す。
  const LEGACY_STORAGE_KEY = 'nev_cost_total_jpy'; // 旧・無期限累計（初回に当月へ移行）
  const MONTH_KEY_PREFIX = 'nev_cost_total_';

  // 現在の月別キー（nowFn 注入でテスト可能。未指定なら実時刻）
  function currentMonthKey(nowFn) {
    const d = (typeof nowFn === 'function') ? nowFn() : new Date();
    return MONTH_KEY_PREFIX + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
  }

  function defaultStore(nowFn) {
    if (typeof localStorage !== 'undefined') {
      // 旧キー（無期限累計）→ 当月キーへの一度きりの移行
      const migrate = () => {
        try {
          const old = localStorage.getItem(LEGACY_STORAGE_KEY);
          if (old == null) return;
          const key = currentMonthKey(nowFn);
          const cur = parseFloat(localStorage.getItem(key) || '0') || 0;
          const v = parseFloat(old) || 0;
          localStorage.setItem(key, String(Math.round((cur + v) * 100) / 100));
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch (e) { /* 移行失敗は致命的でない（当月0から計上） */ }
      };
      return {
        get() { migrate(); return parseFloat(localStorage.getItem(currentMonthKey(nowFn)) || '0') || 0; },
        set(v) { migrate(); localStorage.setItem(currentMonthKey(nowFn), String(v)); },
      };
    }
    // localStorage が無い環境（Node等）向けのメモリストア
    let mem = 0;
    return { get() { return mem; }, set(v) { mem = v; } };
  }

  function CapTracker(config) {
    config = config || {};
    // capJpy=0 または未設定なら「上限なし」（警告・超過判定を行わない）
    this.capJpy = (typeof config.capJpy === 'number') ? config.capJpy : 0;
    this.warnRatio = (typeof config.warnRatio === 'number') ? config.warnRatio : 0.8;
    // 後方互換: store 注入時は従来どおりそれを使用（既存テスト・呼び出しを壊さない）。
    // config.now（() => Date）はテスト用の時刻注入（月替わり自動リセットの検証用）。
    this.store = config.store || defaultStore(config.now);
  }

  CapTracker.prototype.getTotalJpy = function () {
    return this.store.get();
  };

  // API 1回分の料金を累計に加算し、加算後の状態を返す。
  CapTracker.prototype.addCost = function (costEstimate) {
    const jpy = costEstimate && Number.isFinite(costEstimate.totalCostJpy) ? costEstimate.totalCostJpy : 0; // NaN（typeofはnumber）を累計に混ぜない
    const next = Math.round((this.getTotalJpy() + jpy) * 100) / 100;
    this.store.set(next);
    return this.getState();
  };

  // 現在の累計・上限・状態を返す。
  //   status: 'disabled'（上限なし）/ 'ok' / 'warn'（警告閾値到達）/ 'over'（超過）
  //   overageJpy: 超過額（over のときのみ正の値、それ以外0）
  CapTracker.prototype.getState = function () {
    const totalJpy = Math.round(this.getTotalJpy() * 100) / 100;
    const capJpy = this.capJpy;
    if (!capJpy || capJpy <= 0) {
      return { status: 'disabled', totalJpy, capJpy: 0, warnRatio: this.warnRatio, remainingJpy: null, overageJpy: 0, ratio: null };
    }
    const ratio = totalJpy / capJpy;
    let status = 'ok';
    let overageJpy = 0;
    if (totalJpy > capJpy) {
      status = 'over';
      overageJpy = Math.round((totalJpy - capJpy) * 100) / 100;
    } else if (ratio >= this.warnRatio) {
      status = 'warn';
    }
    return {
      status,
      totalJpy,
      capJpy,
      warnRatio: this.warnRatio,
      remainingJpy: Math.round((capJpy - totalJpy) * 100) / 100,
      overageJpy,
      ratio: Math.round(ratio * 1000) / 1000,
    };
  };

  // 画面表示用メッセージ（そのまま出せる日本語）。null は「表示不要」。
  // 波④-4: 累計は月別（今月分）であることを文言に明示。
  CapTracker.prototype.getMessage = function () {
    const s = this.getState();
    if (s.status === 'over') {
      return { level: 'error', text: `料金上限を ${s.overageJpy.toLocaleString()} 円 オーバーしています（今月の累計 ${s.totalJpy.toLocaleString()} 円 / 上限 ${s.capJpy.toLocaleString()} 円）` };
    }
    if (s.status === 'warn') {
      return { level: 'warn', text: `料金上限に近づいています（今月の累計 ${s.totalJpy.toLocaleString()} 円 / 上限 ${s.capJpy.toLocaleString()} 円）` };
    }
    return null;
  };

  CapTracker.prototype.reset = function () { this.store.set(0); };
  CapTracker.prototype.setCap = function (jpy) { this.capJpy = jpy; };
  CapTracker.prototype.setWarnRatio = function (r) { this.warnRatio = r; };

  const api = { PRICING, DEFAULT_USD_TO_JPY, estimateCost, CapTracker, currentMonthKey, LEGACY_STORAGE_KEY, MONTH_KEY_PREFIX };
  root.NevCost = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
