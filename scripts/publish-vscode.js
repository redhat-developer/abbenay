#!/usr/bin/env node

/**
 * Publish platform-specific VSIXes to the VS Code Marketplace and OpenVSX.
 *
 * Usage:  node scripts/publish-vscode.js <vsix-dir>
 *
 * Finds all .vsix files in <vsix-dir> (recursively) and publishes them.
 *
 * Authentication is via OIDC trusted publishing (no PATs):
 *   - VS Code Marketplace: `vsce publish --oidc`
 *   - OpenVSX Registry:    `ovsx publish --trusted-publishing`
 *
 * Environment variables:
 *   GITHUB_REF_NAME           — used to detect pre-release tags (alpha/beta/rc)
 *
 * Pre-release versions (tags containing alpha/beta/rc) are published with --pre-release.
 * Follows the Red Hat convention from redhat-developer/vscode-yaml.
 */

import { execSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/publish-vscode.js <vsix-dir>');
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

const isPreRelease = (process.env.GITHUB_REF_NAME || '').match(/(alpha|beta|rc)/);
const preReleaseFlag = isPreRelease ? ' --pre-release' : '';

console.log(
  `Publishing ${vsixFiles.length} VSIX file(s)${isPreRelease ? ' (pre-release)' : ''}:\n`,
);

for (const vsix of vsixFiles) {
  console.log(`  -> ${vsix}`);

  console.log('     VS Code Marketplace...');
  execSync(
    `npx vsce publish --oidc --packagePath "${vsix}"${preReleaseFlag}`,
    { stdio: 'inherit' },
  );

  console.log('     OpenVSX Registry...');
  execSync(
    `npx ovsx publish --trusted-publishing --packagePath "${vsix}"${preReleaseFlag}`,
    { stdio: 'inherit' },
  );

  console.log('     done\n');
}

console.log('All published.');
