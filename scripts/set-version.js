#!/usr/bin/env node

/**
 * Inject a version string into all package manifests.
 *
 * Usage:  node scripts/set-version.js <version>
 *
 * Updates:
 *   - package.json (root)
 *   - packages/daemon/package.json
 *   - packages/vscode/package.json
 *   - packages/python/pyproject.toml
 *
 * Intended for CI release builds only -- mutations are never committed back.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/set-version.js <version>');
  process.exit(1);
}

function updateJson(filePath) {
  const pkg = JSON.parse(readFileSync(filePath, 'utf8'));
  const old = pkg.version;
  pkg.version = version;
  writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ${filePath}: ${old} -> ${version}`);
}

function updateToml(filePath) {
  let content = readFileSync(filePath, 'utf8');
  content = content.replace(
    /^version\s*=\s*"[^"]*"/m,
    `version = "${version}"`,
  );
  writeFileSync(filePath, content);
  console.log(`  ${filePath}: -> ${version}`);
}

console.log(`Setting version to ${version}\n`);

updateJson(join(root, 'package.json'));
updateJson(join(root, 'packages', 'daemon', 'package.json'));
updateJson(join(root, 'packages', 'vscode', 'package.json'));
updateToml(join(root, 'packages', 'python', 'pyproject.toml'));

console.log('\nDone. These changes are build-time only -- do not commit them.');
