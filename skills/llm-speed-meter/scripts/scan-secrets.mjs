#!/usr/bin/env node
/**
 * scan-secrets — fail if anything that looks like a live credential is sitting in the tree.
 *
 * Run this before committing, and after any speed measurement that used a real key.
 * Exit 1 when a candidate is found, so it works as a pre-commit hook or CI gate.
 *
 *   node scan-secrets.mjs .        # scan current directory
 *   node scan-secrets.mjs ../repo
 *
 * Matches are masked in the output on purpose: printing the secret here would put it
 * into another log, which is exactly the problem this script exists to catch.
 */

import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.tmp', 'dist', 'build', '.cache']);
const SKIP_FILES = new Set(['scan-secrets.mjs', 'package-lock.json', 'pnpm-lock.yaml']);
const MAX_BYTES = 512 * 1024;

const PATTERNS = [
  { name: 'sk- style API key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'GitHub PAT', re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'Slack token', re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  {
    name: 'assigned credential',
    re: /(?:api[_-]?key|secret|password|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["'][^"']{16,}["']/gi,
  },
];

const mask = (s) => (s.length <= 10 ? s[0] + '…' : `${s.slice(0, 6)}…(${s.length} 字符)`);

const findings = [];
const root = path.resolve(process.argv[2] || '.');

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full);
      continue;
    }
    if (!e.isFile() || SKIP_FILES.has(e.name)) continue;
    let buf;
    try {
      const st = fs.statSync(full);
      if (st.size > MAX_BYTES) continue;
      buf = fs.readFileSync(full);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // binary
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const p of PATTERNS) {
        p.re.lastIndex = 0;
        const m = p.re.exec(line);
        if (m) findings.push({ file: path.relative(root, full) || e.name, line: i + 1, kind: p.name, hit: m[0] });
      }
    });
  }
}

walk(root);

if (!findings.length) {
  console.log(`✓ 未发现明文凭据（扫描 ${root}）`);
  process.exit(0);
}

console.log(`✗ 发现 ${findings.length} 处疑似明文凭据：\n`);
for (const f of findings) {
  console.log(`  ${f.file}:${f.line}  [${f.kind}]  ${mask(f.hit)}`);
}
console.log('\n处理方式：');
console.log('  1. 从文件里删掉这些值，改用环境变量（不要写进仓库）');
console.log('  2. 到服务商后台吊销/轮换对应的 key —— 它已经泄露了，改文件并不能让它失效');
console.log('  3. 如果这些行已经提交过，历史里还在：用 git filter-repo 或直接换 key');
process.exit(1);
