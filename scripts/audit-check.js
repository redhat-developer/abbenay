#!/usr/bin/env node

/**
 * Audit check with allowlist.
 *
 * Runs `npm audit --json`, extracts unique advisory URLs, and compares
 * them against .audit-allowlist. Exits non-zero if any advisory is found
 * that is NOT in the allowlist.
 *
 * Usage:  node scripts/audit-check.js
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const allowlistPath = join(root, '.audit-allowlist');

const allowed = new Set();
if (existsSync(allowlistPath)) {
  for (const line of readFileSync(allowlistPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) allowed.add(trimmed);
  }
}

let audit;
try {
  const json = execSync('npm audit --json', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  audit = JSON.parse(json);
} catch (e) {
  // npm audit exits non-zero when vulnerabilities exist but still outputs JSON
  try {
    audit = JSON.parse(e.stdout);
  } catch {
    console.error('Failed to parse npm audit output');
    process.exit(1);
  }
}

const found = new Set();
for (const vuln of Object.values(audit.vulnerabilities || {})) {
  for (const via of vuln.via || []) {
    if (typeof via === 'object' && via.url) {
      found.add(via.url);
    }
  }
}

const newVulns = [...found].filter((url) => !allowed.has(url));

if (newVulns.length > 0) {
  console.error(`\n  ${newVulns.length} new vulnerabilit${newVulns.length === 1 ? 'y' : 'ies'} (not in .audit-allowlist):\n`);
  for (const v of newVulns) console.error(`    ${v}`);
  console.error('\n  If these are acceptable, add them to .audit-allowlist with a comment.\n');
  process.exit(1);
}

console.log(`Audit OK (${allowed.size} accepted, 0 new)`);
