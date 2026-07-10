/* ============================================================
   core/util.js — 図面種別に依存しない汎用ユーティリティ
   出典: 配線ルート図ツール checker.js / app.js から抽出・一般化
   ブラウザ / Node どちらでも動作（DOM非依存）
   ============================================================ */
(function (root) {
  'use strict';

  // ─── 種別名・キー正規化（ツール全体で唯一の正規化器）───────────
  // 【正規化ルール】
  //   1. 空白（半角/全角/タブ/改行等）を除去
  //   2. 乗算記号 ×/x/Ｘ を統一（"CV8sq×3C" ≡ "CV8sqx3C" ≡ "CV8sqＸ3C"）
  //   3. 各種ダッシュ（全角ハイフン・マイナス・emダッシュ等）を ASCII '-' に統一
  //   4. 大文字化（"3c" ≡ "3C"）
  // ※ 分裂させないこと。正規化を変えるならこの関数のみ修正する（delegation pattern）。
  function normalizeKey(str) {
    if (!str) return '';
    return str
      .replace(/\s+/g, '')
      .replace(/[×xＸ]/gi, 'x')
      .replace(/[ー−–—]/g, '-')
      .toUpperCase();
  }

  // ─── HTMLエスケープ（結果描画時のXSS/表示崩れ防止）─────────────
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── ファイルサイズの人間可読整形 ──────────────────────────
  function formatFileSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ─── 遅延（リトライ用）─────────────────────────────────
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── OS判定（キャッシュクリア手順のショートカット出し分け等）──────
  function detectOS() {
    const nav = (typeof navigator !== 'undefined') ? navigator : {};
    const ua = (nav.userAgent || '').toLowerCase();
    const platform = (nav.platform || '').toLowerCase();
    if (/mac|iphone|ipad|ipod/.test(platform) || /mac os x/.test(ua)) return 'mac';
    if (/win/.test(platform) || /windows/.test(ua)) return 'windows';
    return 'other';
  }

  // ─── 編集距離1判定（辞書ベースの誤読補正などで使用）──────────────
  // 距離0/1は正確に返し、2以上は打ち切って 2 を返す（高速化）。
  function editDistance1(a, b) {
    if (a === b) return 0;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return 2;
    if (la === lb) {
      let diff = 0;
      for (let i = 0; i < la; i++) if (a[i] !== b[i]) diff++;
      return diff === 1 ? 1 : (diff === 0 ? 0 : 2);
    }
    // 長さ差1: 短い側を1文字挿入で一致できるか
    const [short, long] = la < lb ? [a, b] : [b, a];
    let i = 0, j = 0, edits = 0;
    while (i < short.length && j < long.length) {
      if (short[i] === long[j]) { i++; j++; }
      else { edits++; j++; if (edits > 1) return 2; }
    }
    return 1;
  }

  const api = { normalizeKey, escapeHtml, formatFileSize, sleep, detectOS, editDistance1 };

  root.NevUtil = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
