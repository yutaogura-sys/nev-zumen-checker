#!/usr/bin/env node
/* ============================================================
   tests/gen-labeling-assets.js — recall測定のラベリング補助を生成
   rules定義から「チェックID一覧(check-ids.md)」を、正解事例フォルダから
   「スターターmanifest(manifest.starter.json)」を生成する。
   使い方: node tests/gen-labeling-assets.js
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const reg = require('../core/rules-registry.js');
['mitori', 'heimen', 'haisen', 'keitou'].forEach(t => require('../rules/' + t + '.js'));

const TOOL_DIR = {
  mitori: '【設置場所見取図】_要件判定チェックツール',
  heimen: '【平面図】_要件判定チェックツール',
  haisen: '【配線ルート図】_要件判定チェックツール',
  keitou: '【電気系統図】_要件判定チェックツール',
};
const INTEG_ROOT = path.resolve(__dirname, '..', '..');
const TYPES = ['mitori', 'heimen', 'haisen', 'keitou'];
const BIZ = ['kiso', 'mokutekichi'];

// ── check-ids.md ──
function genCheckIds() {
  const lines = ['# チェックID一覧（recall測定のラベリング用）', '',
    'expect.items にはこの id をキーに、期待する状態（pass/fail/warn/na）を書く。', ''];
  for (const type of TYPES) {
    const rule = reg.getRule(type);
    lines.push(`## ${type}（${rule.meta.drawingName}）`, '');
    for (const bz of BIZ) {
      const checks = reg.filterChecks(rule, bz);
      lines.push(`### ${bz === 'kiso' ? '基礎充電' : '目的地充電'}（${checks.length}項目）`, '');
      lines.push('| id | 項目 | group | 必須 |', '|---|---|---|---|');
      checks.forEach(c => lines.push(`| ${c.id} | ${c.label} | ${c.group || 'nev'} | ${c.required ? '必須' : '任意/条件'} |`));
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ── manifest.starter.json（正解事例を列挙。expect は空でユーザーが埋める）──
function discover(type, biz) {
  const toolPath = path.join(INTEG_ROOT, TOOL_DIR[type]);
  const out = [];
  if (!fs.existsSync(toolPath)) return out;
  (function walk(dir) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) {
        const norm = p.replace(/\\/g, '/');
        const b = /基礎_正解事例/.test(norm) ? 'kiso' : /目的地_正解事例/.test(norm) ? 'mokutekichi' : null;
        if (b === biz) out.push(p);
      }
    }
  })(toolPath);
  return out;
}
function genStarterManifest() {
  const entries = [];
  entries.push({ _guide: 'これは雛形。各entryのexpect.itemsに、その図面の既知の状態を id:状態 で記入する（check-ids.md参照）。不備事例を追加するとrecall(見逃し率)が測れる。' });
  for (const type of TYPES) {
    for (const biz of BIZ) {
      const files = discover(type, biz).slice(0, 2); // 各2件まで雛形に
      files.forEach(f => {
        const rel = path.relative(path.join(__dirname), f).replace(/\\/g, '/');
        entries.push({ file: rel, type, biz, expect: { items: {} } });
      });
    }
  }
  return JSON.stringify(entries, null, 2);
}

fs.writeFileSync(path.join(__dirname, 'check-ids.md'), genCheckIds(), 'utf8');
fs.writeFileSync(path.join(__dirname, 'manifest.starter.json'), genStarterManifest(), 'utf8');
console.log('生成: tests/check-ids.md, tests/manifest.starter.json');
