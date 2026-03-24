/**
 * Engine registry invariant tests.
 *
 * Ensures PROVIDER_LOADERS stays in sync with every @ai-sdk/* package
 * referenced in the ENGINES registry, catching drift at dev time before
 * it becomes a runtime failure in the SEA binary.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ENGINES_SRC = fs.readFileSync(
  path.join(__dirname, 'engines.ts'),
  'utf-8',
);

function extractPatterns(pattern: RegExp): string[] {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(ENGINES_SRC)) !== null) {
    matches.push(m[1]);
  }
  return [...new Set(matches)];
}

describe('PROVIDER_LOADERS coverage', () => {
  it('should have a loader for every @ai-sdk/* package used in ENGINES', () => {
    const referencedPkgs = extractPatterns(
      /(?:dedicatedProvider|loadProviderFactory)\(\s*'(@ai-sdk\/[^']+)'/g,
    );
    expect(referencedPkgs.length).toBeGreaterThan(0);

    const loaderPkgs = extractPatterns(
      /^\s*'(@ai-sdk\/[^']+)':\s*\(\)\s*=>\s*import\(/gm,
    );
    expect(loaderPkgs.length).toBeGreaterThan(0);

    const loaderSet = new Set(loaderPkgs);
    const missing = referencedPkgs.filter((pkg) => !loaderSet.has(pkg));
    expect(missing, `Missing PROVIDER_LOADERS entries: ${missing.join(', ')}`).toEqual([]);
  });

  it('should not have orphaned loader entries', () => {
    const referencedPkgs = new Set(extractPatterns(
      /(?:dedicatedProvider|loadProviderFactory)\(\s*'(@ai-sdk\/[^']+)'/g,
    ));

    const loaderPkgs = extractPatterns(
      /^\s*'(@ai-sdk\/[^']+)':\s*\(\)\s*=>\s*import\(/gm,
    );

    const orphaned = loaderPkgs.filter((pkg) => !referencedPkgs.has(pkg));
    expect(orphaned, `Orphaned PROVIDER_LOADERS entries: ${orphaned.join(', ')}`).toEqual([]);
  });
});
