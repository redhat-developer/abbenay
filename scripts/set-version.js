#!/usr/bin/env node

/**
 * Inject a version string into all package manifests.
 *
 * Usage:  node scripts/set-version.js <version>
 *
 * Updates:
 *   - package.json (root)
 *   - packages/daemon/package.json
 *   - packages/daemon/src/version.ts
 *   - packages/vscode/package.json
 *   - packages/proto-ts/package.json
 *   - packages/python/pyproject.toml
 *   - packages/python/src/abbenay_grpc/__init__.py
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

// VS Code extensions require pure MAJOR.MINOR.PATCH (no pre-release suffix).
// Pre-release is indicated by the --pre-release flag to vsce, not the version.
const vsceVersion = version.replace(/-.*$/, '');

function updateJson(filePath, ver = version) {
  const pkg = JSON.parse(readFileSync(filePath, 'utf8'));
  const old = pkg.version;
  pkg.version = ver;
  writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ${filePath}: ${old} -> ${ver}`);
}

function updateToml(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const regex = /^version\s*=\s*"[^"]*"/m;
  if (!regex.test(content)) {
    console.error(`  ERROR: no version field found in ${filePath}`);
    process.exit(1);
  }
  const updated = content.replace(regex, `version = "${version}"`);
  writeFileSync(filePath, updated);
  console.log(`  ${filePath}: -> ${version}`);
}

function updateSourceConst(filePath, pattern, replacement) {
  const content = readFileSync(filePath, 'utf8');
  if (!pattern.test(content)) {
    console.error(`  ERROR: version pattern not found in ${filePath}`);
    process.exit(1);
  }
  writeFileSync(filePath, content.replace(pattern, replacement));
  console.log(`  ${filePath}: -> ${version}`);
}

console.log(`Setting version to ${version}\n`);

updateJson(join(root, 'package.json'));
updateJson(join(root, 'packages', 'daemon', 'package.json'));
updateJson(join(root, 'packages', 'vscode', 'package.json'), vsceVersion);
updateJson(join(root, 'packages', 'proto-ts', 'package.json'));
updateToml(join(root, 'packages', 'python', 'pyproject.toml'));
updateSourceConst(
  join(root, 'packages', 'daemon', 'src', 'version.ts'),
  /VERSION = '[^']*'/,
  `VERSION = '${version}'`,
);
updateSourceConst(
  join(root, 'packages', 'python', 'src', 'abbenay_grpc', '__init__.py'),
  /__version__ = "[^"]*"/,
  `__version__ = "${version}"`,
);

console.log('\nDone. These changes are build-time only -- do not commit them.');
