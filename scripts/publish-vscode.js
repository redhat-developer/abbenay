#!/usr/bin/env node

/**
 * Publish platform-specific VSIXes to the VS Code Marketplace.
 *
 * Usage:  node scripts/publish-vscode.js <vsix-dir>
 *
 * Finds all .vsix files in <vsix-dir> (recursively) and publishes them using
 * vsce. Requires VSCE_PAT environment variable for authentication.
 *
 * Pre-release versions (tags containing beta/rc) are published with the
 * --pre-release flag.
 */

import { execSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/publish-vscode.js <vsix-dir>');
  process.exit(1);
}

if (!process.env.VSCE_PAT) {
  console.error('ERROR: VSCE_PAT environment variable is required');
  process.exit(1);
}

function findVsix(root) {
  const results = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findVsix(full));
    } else if (entry.endsWith('.vsix')) {
      results.push(full);
    }
  }
  return results;
}

const vsixFiles = findVsix(dir);
if (vsixFiles.length === 0) {
  console.error(`No .vsix files found in ${dir}`);
  process.exit(1);
}

const isPreRelease = (process.env.GITHUB_REF_NAME || '').match(/(beta|rc)/);
const preReleaseFlag = isPreRelease ? ' --pre-release' : '';

console.log(
  `Publishing ${vsixFiles.length} VSIX file(s)${isPreRelease ? ' (pre-release)' : ''}:\n`,
);

for (const vsix of vsixFiles) {
  console.log(`  -> ${vsix}`);
  execSync(`npx vsce publish --packagePath "${vsix}"${preReleaseFlag}`, {
    stdio: 'inherit',
    env: { ...process.env },
  });
  console.log('     published\n');
}

console.log('Done.');
