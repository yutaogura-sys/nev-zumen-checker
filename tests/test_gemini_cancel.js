/* 波④-3: 実行キャンセル（AbortSignal）の gemini.js ハンドリング回帰テスト（Node実行）
   node tests/test_gemini_cancel.js
   検証点:
     - fetch の AbortError → type='aborted'・指定文言（課金注記付き）
     - callGeminiWithRetry は aborted をリトライしない（fetch 1回のみ）
     - 事前に signal.aborted なら fetch を呼ばずに中断
     - 通常のネットワークエラーは従来どおり（aborted 扱いにしない） */
'use strict';
const gemini = require('../core/gemini.js');

let fail = 0;
function ok(cond, msg) { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) fail++; }
function eq(msg, got, want) { ok(got === want, `${msg}（got: ${JSON.stringify(got)} / want: ${JSON.stringify(want)}）`); }

let calls = 0;
const origFetch = global.fetch;

(async () => {
  // 1) fetch が AbortError で失敗 → type='aborted'・課金注記付きメッセージ
  calls = 0;
  global.fetch = async () => { calls++; const e = new Error('The operation was aborted.'); e.name = 'AbortError'; throw e; };
  try {
    await gemini.callGemini('key', [], 'prompt', 'gemini-2.5-flash', { signal: { aborted: false } });
    ok(false, 'AbortError で throw する');
  } catch (e) {
    eq('AbortError: type', e.type, 'aborted');
    ok(e.message.includes('キャンセルしました') && e.message.includes('実行済み分は課金されています'), 'AbortError: キャンセル文言（課金注記付き）');
  }
  eq('AbortError: fetch は1回だけ', calls, 1);

  // 2) callGeminiWithRetry は aborted を即時伝播（リトライ・待機しない）
  calls = 0;
  try {
    await gemini.callGeminiWithRetry('key', [], 'prompt', 'gemini-2.5-flash', null, null, { signal: { aborted: false } });
    ok(false, 'retry: throw する');
  } catch (e) {
    eq('retry: type=aborted のまま伝播', e.type, 'aborted');
  }
  eq('retry: リトライされず fetch 1回のみ', calls, 1);

  // 3) 呼び出し前に signal.aborted=true → fetch を呼ばずに中断
  calls = 0;
  try {
    await gemini.callGemini('key', [], 'prompt', 'gemini-2.5-flash', { signal: { aborted: true } });
    ok(false, '事前中断: throw する');
  } catch (e) {
    eq('事前中断: type', e.type, 'aborted');
  }
  eq('事前中断: fetch は呼ばれない', calls, 0);

  // 4) 通常のネットワークエラーは aborted 扱いにしない（従来のメッセージ・リトライ分類を維持）
  calls = 0;
  global.fetch = async () => { calls++; throw new Error('fetch failed'); };
  try {
    await gemini.callGemini('key', [], 'prompt', 'gemini-2.5-flash', {});
    ok(false, 'network: throw する');
  } catch (e) {
    ok(e.type !== 'aborted', 'network: aborted 扱いにならない');
    ok(e.message.indexOf('ネットワーク接続エラー') === 0, 'network: 従来のネットワークエラー文言');
  }

  // 5) signal 未指定（従来呼び出し）でも例外にならない（後方互換）
  calls = 0;
  global.fetch = async () => { calls++; throw new Error('fetch failed'); };
  try { await gemini.callGemini('key', [], 'prompt', 'gemini-2.5-flash'); ok(false, 'throw する'); }
  catch (e) { ok(e.type !== 'aborted', 'signal未指定: 従来どおり動作（後方互換）'); }

  global.fetch = origFetch;
  console.log(fail === 0 ? '\n✅ gemini_cancel 全テスト合格' : `\n❌ gemini_cancel ${fail}件 失敗`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
