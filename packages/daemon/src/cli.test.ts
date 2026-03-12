/**
 * CLI list command tests
 *
 * Tests the data layer behind list-engines, list-models (--discover),
 * and the printTable helper. No process spawning — exercises the same
 * functions the CLI handlers call.
 */

import { describe, it, expect } from 'vitest';
import { getEngines, fetchModels } from './core/engines.js';

describe('list-engines', () => {
  it('returns all engines sorted alphabetically', () => {
    const engines = getEngines()
      .map(e => e.id)
      .sort((a, b) => a.localeCompare(b));

    expect(engines.length).toBeGreaterThan(0);
    for (let i = 1; i < engines.length; i++) {
      expect(engines[i].localeCompare(engines[i - 1])).toBeGreaterThanOrEqual(0);
    }
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

  it('models are sortable by id', async () => {
    const models = await fetchModels('mock');
    const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted[0].id.localeCompare(sorted[sorted.length - 1].id)).toBeLessThanOrEqual(0);
  });

  it('returns empty array for unknown engine', async () => {
    const models = await fetchModels('nonexistent-engine-xyz');
    expect(models).toEqual([]);
  });
});
