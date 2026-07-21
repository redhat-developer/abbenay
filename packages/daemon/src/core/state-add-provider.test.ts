/**
 * Unit tests for CoreState.addProvider endpoint policy + audits (DR-040 / A3).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { CoreState } from './state.js';
import { MemorySecretStore } from './secrets.js';

describe('CoreState.addProvider endpoint policy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects non-allowlisted hosts when allowed_provider_hosts is set', async () => {
    const core = new CoreState({
      secretStore: new MemorySecretStore(),
      configLoader: () => ({
        providers: {},
        server: { allowed_provider_hosts: ['approved.example'] },
      }),
    });

    await expect(
      core.addProvider('evil', {
        engine: 'openai',
        baseUrl: 'https://evil.example/v1',
      }),
    ).rejects.toThrow(/not in server\.allowed_provider_hosts|not allowlisted|allowed_provider_hosts/i);
  });

  it('accepts allowlisted hosts and audits endpoint + secret changes', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const core = new CoreState({
      secretStore: new MemorySecretStore(),
      configLoader: () => ({
        providers: {},
        server: { allowed_provider_hosts: ['approved.example'] },
      }),
    });

    await core.addProvider('approved', {
      engine: 'openai',
      baseUrl: 'https://approved.example/v1',
      apiKey: 'sk-test-not-logged',
    });

    const providers = await core.listProviders();
    const added = providers.find((p) => p.id === 'approved');
    expect(added?.baseUrl).toBe('https://approved.example/v1');

    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('[Audit] provider endpoint changed') && l.includes('source=core-add'))).toBe(true);
    expect(lines.some((l) => l.includes('[Audit] secret changed') && l.includes('source=core-add'))).toBe(true);
    expect(lines.every((l) => !l.includes('sk-test-not-logged'))).toBe(true);
  });

  it('allows loopback http and default https when allowlist is unset', async () => {
    const core = new CoreState({
      secretStore: new MemorySecretStore(),
      configLoader: () => ({ providers: {} }),
    });

    await expect(
      core.addProvider('local', {
        engine: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
      }),
    ).resolves.toBeUndefined();

    await expect(
      core.addProvider('cloud', {
        engine: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      }),
    ).resolves.toBeUndefined();

    await expect(
      core.addProvider('evil-http', {
        engine: 'openai',
        baseUrl: 'http://evil.example/v1',
      }),
    ).rejects.toThrow();
  });
});
