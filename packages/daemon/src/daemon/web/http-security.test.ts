/**
 * Unit tests for HTTP API security helpers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  isLocalhostBind,
  isLoopbackRemoteAddress,
  isLocalDashboardHost,
  requestDashboardHost,
  shouldRedirectDashboardToLogin,
  mayAutoEstablishDashboardSession,
  isHttpAuthEnabled,
  assertHttpAuthBindAllowed,
  HttpAuthBindSecurityError,
  resolveHttpApiToken,
  resolveHttpHost,
  resolveCorsOrigins,
  extractBearerToken,
  getCookie,
  timingSafeEqualString,
  cookieSecureFromRequest,
  setAuthCookies,
  clearAuthCookies,
} from './http-security.js';
import {
  ownerIdFromHttpToken,
  resolveHttpSessionOwner,
  resolveSessionOwner,
  assertSessionOwner,
} from '../../core/session-store.js';
import type { Request, Response } from 'express';

describe('isLocalhostBind', () => {
  it('accepts loopback addresses', () => {
    expect(isLocalhostBind('127.0.0.1')).toBe(true);
    expect(isLocalhostBind('::1')).toBe(true);
    expect(isLocalhostBind('localhost')).toBe(true);
    expect(isLocalhostBind(' 127.0.0.1 ')).toBe(true);
  });

  it('rejects non-loopback', () => {
    expect(isLocalhostBind('0.0.0.0')).toBe(false);
    expect(isLocalhostBind('192.168.1.1')).toBe(false);
  });
});

describe('isLoopbackRemoteAddress', () => {
  it('accepts loopback peers', () => {
    expect(isLoopbackRemoteAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackRemoteAddress('::1')).toBe(true);
    expect(isLoopbackRemoteAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects non-loopback peers', () => {
    expect(isLoopbackRemoteAddress('192.168.0.24')).toBe(false);
    expect(isLoopbackRemoteAddress('10.88.0.1')).toBe(false);
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);
  });
});

describe('isLocalDashboardHost', () => {
  it('accepts localhost Host values', () => {
    expect(isLocalDashboardHost('localhost:8787')).toBe(true);
    expect(isLocalDashboardHost('127.0.0.1:8787')).toBe(true);
    expect(isLocalDashboardHost('[::1]:8787')).toBe(true);
    expect(isLocalDashboardHost('::1')).toBe(true);
  });

  it('rejects public hostnames', () => {
    expect(isLocalDashboardHost('abbenay.20665.net')).toBe(false);
    expect(isLocalDashboardHost('abbenay.example:443')).toBe(false);
  });

  it('rejects when any comma-separated or multi-header value is public', () => {
    expect(isLocalDashboardHost('localhost, abbenay.example')).toBe(false);
    expect(isLocalDashboardHost('abbenay.example, localhost')).toBe(false);
    expect(isLocalDashboardHost(['localhost', 'abbenay.example'])).toBe(false);
    expect(isLocalDashboardHost('localhost, 127.0.0.1')).toBe(true);
  });
});

describe('requestDashboardHost', () => {
  it('prefers the full X-Forwarded-Host value over Host', () => {
    expect(
      requestDashboardHost({
        headers: {
          host: '127.0.0.1:8787',
          'x-forwarded-host': 'localhost, abbenay.example',
        },
      }),
    ).toBe('localhost, abbenay.example');
  });

  it('falls back to Host when X-Forwarded-Host is absent', () => {
    expect(
      requestDashboardHost({
        headers: { host: 'localhost:8787' },
      }),
    ).toBe('localhost:8787');
  });
});

describe('shouldRedirectDashboardToLogin', () => {
  it('does not redirect when auth is disabled', () => {
    expect(
      shouldRedirectDashboardToLogin({
        authEnabled: false,
        hasValidAuthCookie: false,
        bindHost: '0.0.0.0',
        remoteAddress: '192.168.0.24',
        hostHeader: 'abbenay.example',
      }),
    ).toBe(false);
  });

  it('does not redirect when a valid auth cookie is present', () => {
    expect(
      shouldRedirectDashboardToLogin({
        authEnabled: true,
        hasValidAuthCookie: true,
        bindHost: '0.0.0.0',
        remoteAddress: '192.168.0.24',
        hostHeader: 'abbenay.example',
      }),
    ).toBe(false);
  });

  it('does not redirect for direct local access (loopback peer + local Host)', () => {
    expect(
      shouldRedirectDashboardToLogin({
        authEnabled: true,
        hasValidAuthCookie: false,
        bindHost: '0.0.0.0',
        remoteAddress: '127.0.0.1',
        hostHeader: '127.0.0.1:8787',
      }),
    ).toBe(false);
    expect(
      mayAutoEstablishDashboardSession({
        authEnabled: true,
        hasValidAuthCookie: false,
        bindHost: '127.0.0.1',
        remoteAddress: '127.0.0.1',
        hostHeader: 'localhost:8787',
      }),
    ).toBe(true);
  });

  it('redirects when reverse-proxy peer is loopback but Host is public', () => {
    // TLS-terminated proxies often present as loopback remoteAddress
    expect(
      shouldRedirectDashboardToLogin({
        authEnabled: true,
        hasValidAuthCookie: false,
        bindHost: '0.0.0.0',
        remoteAddress: '127.0.0.1',
        hostHeader: 'abbenay.20665.net',
      }),
    ).toBe(true);
    expect(
      mayAutoEstablishDashboardSession({
        authEnabled: true,
        hasValidAuthCookie: false,
        bindHost: '0.0.0.0',
        remoteAddress: '127.0.0.1',
        hostHeader: 'abbenay.20665.net',
      }),
    ).toBe(false);
  });

  it('redirects remote clients without a cookie', () => {
    expect(
      shouldRedirectDashboardToLogin({
        authEnabled: true,
        hasValidAuthCookie: false,
        bindHost: '0.0.0.0',
        remoteAddress: '192.168.0.24',
        hostHeader: '192.168.0.3:8787',
      }),
    ).toBe(true);
  });
});

describe('isHttpAuthEnabled', () => {
  const prev = process.env.ABBENAY_HTTP_AUTH;

  afterEach(() => {
    if (prev === undefined) delete process.env.ABBENAY_HTTP_AUTH;
    else process.env.ABBENAY_HTTP_AUTH = prev;
  });

  it('defaults to enabled', () => {
    delete process.env.ABBENAY_HTTP_AUTH;
    expect(isHttpAuthEnabled({ skipConfig: true })).toBe(true);
  });

  it('treats 1/true/on as enabled', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'yes']) {
      process.env.ABBENAY_HTTP_AUTH = v;
      expect(isHttpAuthEnabled()).toBe(true);
    }
  });

  it('disables for 0/false/off/no/disabled', () => {
    for (const v of ['0', 'false', 'FALSE', 'off', 'no', 'disabled']) {
      process.env.ABBENAY_HTTP_AUTH = v;
      expect(isHttpAuthEnabled()).toBe(false);
    }
  });

  it('options.authEnabled overrides env', () => {
    process.env.ABBENAY_HTTP_AUTH = '0';
    expect(isHttpAuthEnabled({ authEnabled: true })).toBe(true);
    process.env.ABBENAY_HTTP_AUTH = '1';
    expect(isHttpAuthEnabled({ authEnabled: false })).toBe(false);
  });
});

describe('assertHttpAuthBindAllowed', () => {
  it('allows auth-disabled binds on loopback', () => {
    expect(() => assertHttpAuthBindAllowed('127.0.0.1', false)).not.toThrow();
    expect(() => assertHttpAuthBindAllowed('::1', false)).not.toThrow();
    expect(() => assertHttpAuthBindAllowed('localhost', false)).not.toThrow();
  });

  it('allows auth-enabled binds on any host', () => {
    expect(() => assertHttpAuthBindAllowed('0.0.0.0', true)).not.toThrow();
    expect(() => assertHttpAuthBindAllowed('192.168.1.10', true)).not.toThrow();
  });

  it('refuses auth-disabled binds beyond loopback', () => {
    expect(() => assertHttpAuthBindAllowed('0.0.0.0', false)).toThrow(HttpAuthBindSecurityError);
    expect(() => assertHttpAuthBindAllowed('192.168.1.10', false)).toThrow(HttpAuthBindSecurityError);
    expect(() => assertHttpAuthBindAllowed('::', false)).toThrow(HttpAuthBindSecurityError);
  });
});

describe('resolveHttpHost', () => {
  const prev = process.env.ABBENAY_HTTP_HOST;

  afterEach(() => {
    if (prev === undefined) delete process.env.ABBENAY_HTTP_HOST;
    else process.env.ABBENAY_HTTP_HOST = prev;
  });

  it('defaults to 127.0.0.1', () => {
    delete process.env.ABBENAY_HTTP_HOST;
    expect(resolveHttpHost(undefined, null, { skipConfig: true })).toBe('127.0.0.1');
  });

  it('prefers explicit host over env', () => {
    process.env.ABBENAY_HTTP_HOST = '0.0.0.0';
    expect(resolveHttpHost('127.0.0.1', null, { skipConfig: true })).toBe('127.0.0.1');
  });

  it('uses env when no explicit host', () => {
    process.env.ABBENAY_HTTP_HOST = '0.0.0.0';
    expect(resolveHttpHost(undefined, null, { skipConfig: true })).toBe('0.0.0.0');
  });

  it('uses config server.host', () => {
    delete process.env.ABBENAY_HTTP_HOST;
    expect(resolveHttpHost(undefined, { server: { host: '0.0.0.0' } }, { skipConfig: true }))
      .toBe('0.0.0.0');
  });
});

describe('resolveCorsOrigins', () => {
  const prev = process.env.ABBENAY_CORS_ORIGINS;

  afterEach(() => {
    if (prev === undefined) delete process.env.ABBENAY_CORS_ORIGINS;
    else process.env.ABBENAY_CORS_ORIGINS = prev;
  });

  it('includes localhost defaults for the port', () => {
    delete process.env.ABBENAY_CORS_ORIGINS;
    const origins = resolveCorsOrigins(8787, { skipConfig: true }, null);
    expect(origins).toContain('http://127.0.0.1:8787');
    expect(origins).toContain('http://localhost:8787');
  });

  it('merges env and options', () => {
    process.env.ABBENAY_CORS_ORIGINS = 'https://app.example.com,https://other.example';
    const origins = resolveCorsOrigins(9000, {
      skipConfig: true,
      corsOrigins: ['https://extra.example'],
    }, null);
    expect(origins).toContain('https://app.example.com');
    expect(origins).toContain('https://other.example');
    expect(origins).toContain('https://extra.example');
    expect(origins).toContain('http://127.0.0.1:9000');
  });
});

describe('resolveHttpApiToken', () => {
  const prevToken = process.env.ABBENAY_API_TOKEN;

  afterEach(() => {
    if (prevToken === undefined) delete process.env.ABBENAY_API_TOKEN;
    else process.env.ABBENAY_API_TOKEN = prevToken;
    delete process.env.MY_HTTP_TOKEN;
  });

  it('uses explicit options token', () => {
    const r = resolveHttpApiToken({ apiToken: 'opt-token', skipConfig: true });
    expect(r.token).toBe('opt-token');
    expect(r.source).toBe('options');
  });

  it('uses ABBENAY_API_TOKEN env', () => {
    process.env.ABBENAY_API_TOKEN = 'env-token';
    const r = resolveHttpApiToken({ skipConfig: true });
    expect(r.token).toBe('env-token');
    expect(r.source).toBe('env');
  });

  it('uses config api_token', () => {
    delete process.env.ABBENAY_API_TOKEN;
    const r = resolveHttpApiToken(
      { skipConfig: true },
      { server: { api_token: 'cfg-token' } },
    );
    expect(r.token).toBe('cfg-token');
    expect(r.source).toBe('config');
  });

  it('uses config api_token_env', () => {
    delete process.env.ABBENAY_API_TOKEN;
    process.env.MY_HTTP_TOKEN = 'named-env';
    const r = resolveHttpApiToken(
      { skipConfig: true },
      { server: { api_token_env: 'MY_HTTP_TOKEN' } },
    );
    expect(r.token).toBe('named-env');
    expect(r.source).toBe('config_env');
  });

  it('returns empty token when auth is disabled', () => {
    const r = resolveHttpApiToken({ authEnabled: false, skipConfig: true });
    expect(r.token).toBe('');
    expect(r.source).toBe('disabled');
    expect(r.generated).toBe(false);
  });
});

describe('extractBearerToken / getCookie', () => {
  it('parses Bearer header', () => {
    const req = { headers: { authorization: 'Bearer secret123' } } as Request;
    expect(extractBearerToken(req)).toBe('secret123');
  });

  it('returns null without Bearer', () => {
    const req = { headers: { authorization: 'Basic x' } } as Request;
    expect(extractBearerToken(req)).toBeNull();
  });

  it('parses cookies', () => {
    const req = {
      headers: { cookie: 'foo=bar; abbenay_api_token=tok%2B1; other=1' },
    } as Request;
    expect(getCookie(req, 'abbenay_api_token')).toBe('tok+1');
    expect(getCookie(req, 'missing')).toBeNull();
  });
});

describe('timingSafeEqualString', () => {
  it('matches equal strings', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
  });

  it('rejects unequal strings and unequal lengths', () => {
    expect(timingSafeEqualString('abc', 'abd')).toBe(false);
    expect(timingSafeEqualString('abc', 'ab')).toBe(false);
    expect(timingSafeEqualString('', 'x')).toBe(false);
  });
});

describe('cookieSecureFromRequest / setAuthCookies', () => {
  it('detects HTTPS via req.secure and X-Forwarded-Proto', () => {
    expect(cookieSecureFromRequest({ secure: true, headers: {} } as Request)).toBe(true);
    expect(cookieSecureFromRequest({
      secure: false,
      headers: { 'x-forwarded-proto': 'https' },
    } as Request)).toBe(true);
    expect(cookieSecureFromRequest({
      secure: false,
      headers: { 'x-forwarded-proto': 'https, http' },
    } as Request)).toBe(true);
    expect(cookieSecureFromRequest({ secure: false, headers: {} } as Request)).toBe(false);
  });

  it('sets Secure flag on cookies when requested', () => {
    const cookies: string[] = [];
    const res = {
      append: (_name: string, value: string) => { cookies.push(value); },
    } as unknown as Response;
    setAuthCookies(res, 'tok', { secure: true });
    expect(cookies.length).toBe(2);
    expect(cookies[0]).toContain('Secure');
    expect(cookies[1]).toContain('Secure');
    cookies.length = 0;
    clearAuthCookies(res, { secure: true });
    expect(cookies.every((c) => c.includes('Secure'))).toBe(true);
  });

  it('omits Secure flag by default', () => {
    const cookies: string[] = [];
    const res = {
      append: (_name: string, value: string) => { cookies.push(value); },
    } as unknown as Response;
    setAuthCookies(res, 'tok');
    expect(cookies.every((c) => !c.includes('Secure'))).toBe(true);
  });
});

describe('session owner helpers', () => {
  it('fingerprints HTTP tokens stably', () => {
    const a = ownerIdFromHttpToken('same-token');
    const b = ownerIdFromHttpToken('same-token');
    const c = ownerIdFromHttpToken('other-token');
    expect(a).toBe(b);
    expect(a).toMatch(/^http:[0-9a-f]{16}$/);
    expect(a).not.toBe(c);
  });

  it('appends validated owner claims', () => {
    const base = ownerIdFromHttpToken('tok');
    expect(resolveHttpSessionOwner('tok', 'my-app')).toBe(`${base}:my-app`);
    expect(resolveHttpSessionOwner('tok', 'BAD CLAIM')).toBe(base);
    expect(resolveHttpSessionOwner('tok', null)).toBe(base);
  });

  it('treats missing owner as local', () => {
    expect(resolveSessionOwner({})).toBe('local');
    expect(resolveSessionOwner({ owner: 'http:x' })).toBe('http:x');
  });

  it('assertSessionOwner throws not-found for wrong owner', () => {
    expect(() => assertSessionOwner({ id: 'abc', owner: 'a' }, 'b')).toThrow('Session not found: abc');
  });
});
