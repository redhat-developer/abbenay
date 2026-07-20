/**
 * Unit tests for provider endpoint policy (DR-038 / A1,A3).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  auditProviderEndpointChange,
  auditProviderEndpointConfigDiff,
  endpointPolicyFromServer,
  isLoopbackHostname,
  validateConfigProviderEndpoints,
  validateProviderEndpoint,
  validateProviderEndpointFormat,
} from './provider-endpoint.js';

describe('isLoopbackHostname', () => {
  it('accepts common loopback names', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('app.localhost')).toBe(true);
  });

  it('rejects non-loopback hosts', () => {
    expect(isLoopbackHostname('evil.example')).toBe(false);
    expect(isLoopbackHostname('10.0.0.5')).toBe(false);
  });
});

describe('validateProviderEndpointFormat', () => {
  it('accepts https and http absolute URLs', () => {
    expect(validateProviderEndpointFormat('https://api.openai.com/v1').ok).toBe(true);
    expect(validateProviderEndpointFormat('http://10.0.0.5:8000/v1').ok).toBe(true);
  });

  it('rejects malformed, non-http schemes, and userinfo', () => {
    expect(validateProviderEndpointFormat('not a url').ok).toBe(false);
    expect(validateProviderEndpointFormat('ftp://files.example/v1').ok).toBe(false);
    expect(validateProviderEndpointFormat('https://user:pass@api.example/v1').ok).toBe(false);
    expect(validateProviderEndpointFormat('').ok).toBe(false);
  });
});

describe('validateProviderEndpoint', () => {
  it('allows https to any host by default', () => {
    const r = validateProviderEndpoint('https://api.openai.com/v1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hostname).toBe('api.openai.com');
  });

  it('allows http to loopback by default', () => {
    expect(validateProviderEndpoint('http://127.0.0.1:11434/v1').ok).toBe(true);
    expect(validateProviderEndpoint('http://localhost:1234/v1').ok).toBe(true);
  });

  it('rejects http to non-loopback by default', () => {
    const r = validateProviderEndpoint('http://evil.example/steal');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/loopback/i);
  });

  it('allows http to allowlisted host', () => {
    const r = validateProviderEndpoint('http://10.0.0.5:8000/v1', {
      allowedHosts: ['10.0.0.5'],
    });
    expect(r.ok).toBe(true);
  });

  it('allows http to non-loopback when allowInsecureHttp is set', () => {
    const r = validateProviderEndpoint('http://airgap.internal/v1', {
      allowInsecureHttp: true,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects hosts outside allowlist even for https', () => {
    const r = validateProviderEndpoint('https://evil.example/v1', {
      allowedHosts: ['api.openai.com'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/allowed_provider_hosts/);
  });

  it('still allows loopback when allowlist is set', () => {
    expect(
      validateProviderEndpoint('http://127.0.0.1:11434/v1', {
        allowedHosts: ['api.openai.com'],
      }).ok,
    ).toBe(true);
  });
});

describe('validateConfigProviderEndpoints', () => {
  it('passes when no base_url set', () => {
    expect(validateConfigProviderEndpoints({ providers: { o: {} } }).ok).toBe(true);
  });

  it('uses server allowlist from the same config', () => {
    const ok = validateConfigProviderEndpoints({
      server: { allowed_provider_hosts: ['maas.internal'] },
      providers: {
        rh: { base_url: 'http://maas.internal/v1' },
      },
    });
    expect(ok.ok).toBe(true);

    const bad = validateConfigProviderEndpoints({
      server: { allowed_provider_hosts: ['maas.internal'] },
      providers: {
        rh: { base_url: 'http://other.internal/v1' },
      },
    });
    expect(bad.ok).toBe(false);
  });
});

describe('endpointPolicyFromServer', () => {
  it('maps server block fields', () => {
    expect(endpointPolicyFromServer({
      allowed_provider_hosts: ['a.example'],
      allow_insecure_provider_http: true,
    })).toEqual({
      allowedHosts: ['a.example'],
      allowInsecureHttp: true,
    });
  });
});

describe('audit logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs endpoint changes without secrets', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    auditProviderEndpointChange({
      providerId: 'openai',
      previousBaseUrl: 'https://api.openai.com/v1',
      newBaseUrl: 'https://proxy.example/v1',
      source: 'http-configure',
    });
    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain('[Audit] provider endpoint changed');
    expect(line).toContain('provider=openai');
    expect(line).toContain('to=https://proxy.example/v1');
    expect(line).not.toMatch(/api[_-]?key|sk-/i);
  });

  it('diffs config provider base_url changes', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    auditProviderEndpointConfigDiff(
      { providers: { a: { base_url: 'https://old.example/v1' } } },
      { providers: { a: { base_url: 'https://new.example/v1' } } },
      'http-config',
    );
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain('to=https://new.example/v1');
  });
});
