#!/usr/bin/env node

/**
 * Regression check: API keys must not be passed via URL query strings (DR-035).
 *
 * Scans production source for patterns that historically leaked secrets:
 *   - ?key= / `?key=${...}`  (Gemini-style query API keys)
 *   - query.apiKey / query['apiKey']  (Express discover-models query param)
 *   - params.set/append('apiKey'    (dashboard URLSearchParams)
 *   - searchParams.set('key'        (URLSearchParams Gemini-style)
 *
 * Usage:  node scripts/check-no-query-secrets.js
 *         npm run check:no-query-secrets
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const SCAN_ROOTS = [
  'packages/daemon/src',
  'packages/daemon/static',
  'packages/vscode/src',
];

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.html']);

/** Paths (relative to repo root) that may mention these patterns for documentation/tests of the ban. */
const ALLOWLIST = new Set([
  'scripts/check-no-query-secrets.js',
  'packages/daemon/src/core/engines.test.ts',
  'packages/daemon/tests/integration/discover-models-auth.test.ts',
]);

const PATTERNS = [
  { name: '?key= query API key', re: /\?key=/ },
  { name: 'req.query.apiKey', re: /query\.apiKey\b/ },
  { name: "query['apiKey']", re: /query\[\s*['"]apiKey['"]\s*\]/ },
  { name: "URLSearchParams set apiKey", re: /params\.set\(\s*['"]apiKey['"]/ },
  { name: "URLSearchParams append apiKey", re: /params\.append\(\s*['"]apiKey['"]/ },
  { name: "searchParams.set('key'", re: /searchParams\.set\(\s*['"]key['"]/ },
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === 'out') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip test trees under vscode (they may assert against the ban)
      if (name === 'test' || name === 'tests' || name === '__tests__') continue;
      yield* walk(full);
    } else if (EXTENSIONS.has(extname(name))) {
      yield full;
    }
  }
}

const violations = [];

for (const scanRoot of SCAN_ROOTS) {
  const absRoot = join(root, scanRoot);
  for (const file of walk(absRoot)) {
    const rel = relative(root, file).split('\\').join('/');
    if (ALLOWLIST.has(rel)) continue;
    // Unit/integration tests under daemon are outside SCAN_ROOTS except src/;
    // still skip any *.test.* under src if present.
    if (/\.test\.(ts|tsx|js)$/.test(rel)) continue;

    const content = readFileSync(file, 'utf8');
    for (const { name, re } of PATTERNS) {
      if (re.test(content)) {
        // Allow explanatory comments that document the ban (must include "must not" / "Never")
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!re.test(line)) continue;
          const trimmed = line.trim();
          if (
            trimmed.startsWith('//') ||
            trimmed.startsWith('*') ||
            trimmed.startsWith('/*')
          ) {
            // Comment-only mention of the anti-pattern is OK
            continue;
          }
          violations.push(`${rel}:${i + 1}: ${name}: ${trimmed.slice(0, 120)}`);
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Query-string secret patterns found (use header/body instead):\n');
  for (const v of violations) console.error(`  ${v}`);
  console.error(`\n${violations.length} violation(s). See docs/decisions.md DR-035.`);
  process.exit(1);
}

console.log('check-no-query-secrets: OK (no query-secret patterns in scanned sources)');
