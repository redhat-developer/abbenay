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
  resolveHttpApiToken,
  resolveHttpHost,
  resolveCorsOrigins,
  resolveHttpSecurity,
  getHttpApiTokenPath,
  extractBearerToken,
  getCookie,
  timingSafeEqualString,
  cookieSecureFromRequest,
  setAuthCookies,
  clearAuthCookies,
  createCorsMiddleware,
  createAuthMiddleware,
  API_TOKEN_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
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

describe('resolveHttpSecurity', () => {
  it('combines token, host, cors, and auth settings', () => {
    const security = resolveHttpSecurity(8787, '127.0.0.1', {
      apiToken: 'combined-token',
      skipConfig: true,
      corsOrigins: ['https://app.example.com'],
    });
    expect(security.apiToken).toBe('combined-token');
    expect(security.host).toBe('127.0.0.1');
    expect(security.authEnabled).toBe(true);
    expect(security.tokenSource).toBe('options');
    expect(security.corsOrigins).toContain('http://127.0.0.1:8787');
    expect(security.corsOrigins).toContain('https://app.example.com');
  });
});

describe('getHttpApiTokenPath', () => {
  it('points under the config directory', () => {
    expect(getHttpApiTokenPath()).toMatch(/http-api-token$/);
  });
});

type MockResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  nextCalled: boolean;
  setHeader(name: string, value: string): void;
  status(code: number): MockResponse;
  json(body: unknown): void;
  sendStatus(code: number): void;
};

function createMockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    headers: {},
    nextCalled: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
    },
    sendStatus(code) {
      this.statusCode = code;
    },
  };
  return res;
}

function runMiddleware(
  middleware: (req: Request, res: Response, next: () => void) => void,
  req: Partial<Request>,
): MockResponse {
  const res = createMockResponse();
  middleware(req as Request, res as unknown as Response, () => {
    res.nextCalled = true;
  });
  return res;
}

describe('createCorsMiddleware', () => {
  const allowlist = ['http://127.0.0.1:8787', 'https://app.example.com'];

  it('allows listed origins and sets CORS headers', () => {
    const res = runMiddleware(createCorsMiddleware(allowlist), {
      method: 'GET',
      headers: { origin: 'https://app.example.com', host: '127.0.0.1:8787' },
      path: '/api/health',
    } as Partial<Request>);
    expect(res.nextCalled).toBe(true);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects foreign origins on actual requests', () => {
    const res = runMiddleware(createCorsMiddleware(allowlist), {
      method: 'GET',
      headers: { origin: 'https://evil.example.com', host: '127.0.0.1:8787' },
      path: '/api/health',
    } as Partial<Request>);
    expect(res.nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Origin not allowed' });
  });

  it('rejects foreign origins on OPTIONS preflight', () => {
    const res = runMiddleware(createCorsMiddleware(allowlist), {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com' },
      path: '/api/health',
    } as Partial<Request>);
    expect(res.nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('responds 204 to OPTIONS for allowed origins', () => {
    const res = runMiddleware(createCorsMiddleware(allowlist), {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:8787' },
      path: '/api/health',
    } as Partial<Request>);
    expect(res.nextCalled).toBe(false);
    expect(res.statusCode).toBe(204);
  });

  it('allows requests without Origin header (non-browser clients)', () => {
    const res = runMiddleware(createCorsMiddleware(allowlist), {
      method: 'GET',
      headers: { host: '127.0.0.1:8787' },
      path: '/api/health',
    } as Partial<Request>);
    expect(res.nextCalled).toBe(true);
  });
});

describe('createAuthMiddleware', () => {
  const token = 'test-api-token';
  const corsOrigins = ['http://127.0.0.1:8787'];

  it('passes through when auth is disabled', () => {
    const res = runMiddleware(createAuthMiddleware(token, corsOrigins, false), {
      method: 'GET',
      headers: {},
    } as Partial<Request>);
    expect(res.nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('accepts valid Bearer token', () => {
    const res = runMiddleware(createAuthMiddleware(token, corsOrigins), {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    } as Partial<Request>);
    expect(res.nextCalled).toBe(true);
  });

  it('rejects missing credentials with 401', () => {
    const res = runMiddleware(createAuthMiddleware(token, corsOrigins), {
      method: 'GET',
      headers: {},
    } as Partial<Request>);
    expect(res.nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('accepts cookie auth on GET without CSRF', () => {
    const res = runMiddleware(createAuthMiddleware(token, corsOrigins), {
      method: 'GET',
      headers: {
        cookie: `${API_TOKEN_COOKIE}=${encodeURIComponent(token)}`,
      },
    } as Partial<Request>);
    expect(res.nextCalled).toBe(true);
  });

  it('requires CSRF or allowlisted origin for cookie auth on POST', () => {
    const csrf = 'csrf-token-value';
    const withoutCsrf = runMiddleware(createAuthMiddleware(token, corsOrigins), {
      method: 'POST',
      headers: {
        cookie: `${API_TOKEN_COOKIE}=${encodeURIComponent(token)}`,
        host: '127.0.0.1:8787',
      },
    } as Partial<Request>);
    expect(withoutCsrf.nextCalled).toBe(false);
    expect(withoutCsrf.statusCode).toBe(403);

    const withCsrf = runMiddleware(createAuthMiddleware(token, corsOrigins), {
      method: 'POST',
      headers: {
        cookie: `${API_TOKEN_COOKIE}=${encodeURIComponent(token)}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`,
        [CSRF_HEADER]: csrf,
      },
    } as Partial<Request>);
    expect(withCsrf.nextCalled).toBe(true);
  });

  it('accepts cookie auth on POST when Referer matches same-origin Host', () => {
    const res = runMiddleware(createAuthMiddleware(token, corsOrigins), {
      method: 'POST',
      headers: {
        cookie: `${API_TOKEN_COOKIE}=${encodeURIComponent(token)}`,
        host: '127.0.0.1:8787',
        referer: 'http://127.0.0.1:8787/dashboard',
      },
    } as Partial<Request>);
    expect(res.nextCalled).toBe(true);
  });

  it('accepts cookie auth on POST when Origin matches Host via x-forwarded-proto', () => {
    const res = runMiddleware(createAuthMiddleware(token, ['https://app.example.com']), {
      method: 'POST',
      headers: {
        cookie: `${API_TOKEN_COOKIE}=${encodeURIComponent(token)}`,
        host: 'abbenay.example.com',
        origin: 'https://abbenay.example.com',
        'x-forwarded-proto': 'https',
      },
    } as Partial<Request>);
    expect(res.nextCalled).toBe(true);
  });

  it('still requires CSRF when Referer is not a valid URL', () => {
    const res = runMiddleware(createAuthMiddleware(token, corsOrigins), {
      method: 'POST',
      headers: {
        cookie: `${API_TOKEN_COOKIE}=${encodeURIComponent(token)}`,
        referer: 'not-a-valid-url',
      },
    } as Partial<Request>);
    expect(res.nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'CSRF validation failed' });
  });
});
