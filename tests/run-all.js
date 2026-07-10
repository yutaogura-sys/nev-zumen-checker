#!/usr/bin/env node
/* tests/run-all.js — 全テストスイートを一括実行（npm test）。1つでも失敗すれば exit 1 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const suites = fs.readdirSync(dir).filter(f => /^test_.*\.js$/.test(f)).sort();
let failed = [];
for (const f of suites) {
  try {
    execFileSync('node', [path.join(dir, f)], { stdio: 'pipe' });
    console.log(`✅ ${f}`);
  } catch (e) {
    failed.push(f);
    console.log(`❌ ${f}`);
    const out = String(e.stdout || '') + String(e.stderr || '');
    console.log(out.split('\n').filter(l => l.includes('✗') || l.includes('got:') || l.includes('want:')).slice(0, 12).join('\n'));
  }
}
console.log(`\n${suites.length}スイート中 合格 ${suites.length - failed.length} / 失敗 ${failed.length}${failed.length ? ' → ' + failed.join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);
