/**
 * CLI list command tests
 *
 * Tests the data layer behind list-engines and list-models (--discover).
 * No process spawning — exercises the same functions the CLI handlers call.
 */

import { describe, it, expect } from 'vitest';
import { getEngines, fetchModels } from './core/engines.js';

describe('list-engines', () => {
  it('returns engines with ids that can be sorted alphabetically', () => {
    const ids = getEngines().map(e => e.id);
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));

    expect(ids.length).toBeGreaterThan(0);
    expect(sorted).toEqual(expect.arrayContaining(ids));
    expect(sorted.length).toBe(ids.length);
  });

  it('every engine has required fields', () => {
    for (const e of getEngines()) {
      expect(e.id).toBeTruthy();
      expect(typeof e.requiresKey).toBe('boolean');
      expect(typeof e.supportsTools).toBe('boolean');
    }
  });

  it('includes known engines', () => {
    const ids = new Set(getEngines().map(e => e.id));
    for (const expected of ['openai', 'anthropic', 'ollama', 'mock']) {
      expect(ids.has(expected)).toBe(true);
    }
  });
});

describe('list-models --discover mock', () => {
  it('returns mock models without network access', async () => {
    const models = await fetchModels('mock');
    expect(models.length).toBeGreaterThan(0);

    const ids = models.map(m => m.id);
    expect(ids).toContain('echo');
    expect(ids).toContain('fixed');
  });

  it('returned models have valid structure', async () => {
    const models = await fetchModels('mock');
    for (const m of models) {
      expect(m.id).toBeTruthy();
      expect(m.engine).toBe('mock');
      expect(typeof m.contextWindow).toBe('number');
    }
  });

  it('returns empty array for unknown engine', async () => {
    const models = await fetchModels('nonexistent-engine-xyz');
    expect(models).toEqual([]);
  });
});
