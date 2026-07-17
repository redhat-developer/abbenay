/**
 * HTTP API security helpers — Bearer auth, CORS allowlist, bind host, CSRF.
 *
 * Secure defaults:
 * - Every /api/*, /v1/*, and /mcp request requires a valid Bearer token (or
 *   SameSite=Strict session cookie with CSRF checks for cookie-only auth).
 * - CORS allows only an explicit origin allowlist (never *).
 * - HTTP bind defaults to 127.0.0.1.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { loadConfig, type ConfigFile, type ServerConfig } from '../../core/config.js';
import { getConfigDir } from '../../core/paths.js';
import { DEFAULT_HTTP_HOST } from '../../core/constants.js';
import {
  LOCAL_SESSION_OWNER,
  resolveHttpSessionOwner,
  SESSION_OWNER_HEADER,
} from '../../core/session-store.js';

export const API_TOKEN_COOKIE = 'abbenay_api_token';
export const CSRF_COOKIE = 'abbenay_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const TOKEN_FILE_NAME = 'http-api-token';

/** Express request extension for the authenticated session owner principal. */
export type RequestWithOwner = Request & { abbenayOwner?: string };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ResolvedHttpSecurity {
  apiToken: string;
  host: string;
  corsOrigins: string[];
  /** False when ABBENAY_HTTP_AUTH disables auth (local-dev escape hatch). */
  authEnabled: boolean;
  /** True when the token was freshly generated and persisted */
  generated: boolean;
  /** Source of the token for logging */
  tokenSource: 'env' | 'config' | 'config_env' | 'file' | 'generated' | 'options' | 'disabled';
}

export interface WebSecurityOptions {
  /** Explicit API token (tests / callers). When set, skips file/env resolution. */
  apiToken?: string;
  /** Explicit CORS allowlist. Merged with localhost defaults for the listen port. */
  corsOrigins?: string[];
  /** Listen port — used to build default localhost CORS origins. */
  port?: number;
  /** Explicit bind host override (also used for cookie auto-establish policy). */
  host?: string;
  /**
   * Force auth on/off (tests). When unset, follows ABBENAY_HTTP_AUTH
   * (default: enabled).
   */
  authEnabled?: boolean;
  /** Skip loading user config (tests). */
  skipConfig?: boolean;
  /**
   * TTL for pending MCP connection-consent and tool-approval promises (ms).
   * Abandoned initialize/approvals are auto-denied and removed from the pending
   * maps when the timer fires. Default: 5 minutes. Tests may pass a short value.
   */
  mcpPendingTtlMs?: number;
}

/** Env values that disable HTTP auth (local-dev escape hatch). */
const AUTH_DISABLE_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);

/**
 * Return true when HTTP auth is enabled (the secure default).
 *
 * Set `ABBENAY_HTTP_AUTH=0` (or false/off/no/disabled) to turn auth off for
 * local development only. Never disable auth when binding beyond loopback.
 */
export function isHttpAuthEnabled(options?: WebSecurityOptions): boolean {
  if (options?.authEnabled !== undefined) {
    return options.authEnabled;
  }
  const raw = process.env.ABBENAY_HTTP_AUTH?.trim().toLowerCase();
  if (raw && AUTH_DISABLE_VALUES.has(raw)) {
    return false;
  }
  return true;
}

/**
 * Return true when the bind address is loopback-only.
 */
export function isLocalhostBind(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/**
 * Thrown when HTTP auth is disabled on a non-loopback bind (fail-closed).
 */
export class HttpAuthBindSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpAuthBindSecurityError';
  }
}

/**
 * Refuse auth-disabled HTTP binds beyond loopback.
 *
 * `ABBENAY_HTTP_AUTH=0` is a local-dev escape hatch only. Combining it with
 * `--host 0.0.0.0` (or any non-loopback bind) would expose an unauthenticated
 * API on the network — refuse to start instead of warning.
 */
export function assertHttpAuthBindAllowed(host: string, authEnabled: boolean): void {
  if (authEnabled || isLocalhostBind(host)) {
    return;
  }
  throw new HttpAuthBindSecurityError(
    `Refusing to bind HTTP on non-loopback address "${host}" with authentication disabled ` +
      '(ABBENAY_HTTP_AUTH=0). Re-enable auth, or bind to 127.0.0.1 / ::1 / localhost.',
  );
}

/**
 * Path to the persisted auto-generated HTTP API token.
 */
export function getHttpApiTokenPath(): string {
  return path.join(getConfigDir(), TOKEN_FILE_NAME);
}

function readPersistedToken(): string | null {
  const tokenPath = getHttpApiTokenPath();
  try {
    if (!fs.existsSync(tokenPath)) return null;
    const raw = fs.readFileSync(tokenPath, 'utf-8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function persistToken(token: string): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const tokenPath = getHttpApiTokenPath();
  fs.writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    // Windows may not support chmod the same way
  }
}

function serverConfig(config: ConfigFile | null): ServerConfig {
  return config?.server ?? {};
}

/**
 * Resolve the HTTP API token from options → env → config → persisted file → generate.
 * When auth is disabled, returns an empty token without generating a file.
 */
export function resolveHttpApiToken(
  options?: WebSecurityOptions,
  config?: ConfigFile | null,
): { token: string; source: ResolvedHttpSecurity['tokenSource']; generated: boolean } {
  if (!isHttpAuthEnabled(options)) {
    return { token: '', source: 'disabled', generated: false };
  }

  if (options?.apiToken) {
    return { token: options.apiToken, source: 'options', generated: false };
  }

  const envToken = process.env.ABBENAY_API_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: 'env', generated: false };
  }

  const cfg = config === undefined
    ? (options?.skipConfig ? null : loadConfig())
    : config;
  const server = serverConfig(cfg);

  if (server.api_token?.trim()) {
    return { token: server.api_token.trim(), source: 'config', generated: false };
  }

  if (server.api_token_env?.trim()) {
    const fromNamedEnv = process.env[server.api_token_env.trim()]?.trim();
    if (fromNamedEnv) {
      return { token: fromNamedEnv, source: 'config_env', generated: false };
    }
  }

  const persisted = readPersistedToken();
  if (persisted) {
    return { token: persisted, source: 'file', generated: false };
  }

  const generated = crypto.randomBytes(32).toString('base64url');
  persistToken(generated);
  return { token: generated, source: 'generated', generated: true };
}

/**
 * Resolve HTTP bind host: options/CLI → env → config → default 127.0.0.1.
 */
export function resolveHttpHost(
  explicitHost?: string,
  config?: ConfigFile | null,
  options?: WebSecurityOptions,
): string {
  if (explicitHost?.trim()) return explicitHost.trim();
  if (options?.host?.trim()) return options.host.trim();

  const envHost = process.env.ABBENAY_HTTP_HOST?.trim();
  if (envHost) return envHost;

  const cfg = config === undefined
    ? (options?.skipConfig ? null : loadConfig())
    : config;
  const fromConfig = serverConfig(cfg).host?.trim();
  if (fromConfig) return fromConfig;

  return DEFAULT_HTTP_HOST;
}

/**
 * Build the CORS origin allowlist.
 */
export function resolveCorsOrigins(
  port: number,
  options?: WebSecurityOptions,
  config?: ConfigFile | null,
): string[] {
  const origins = new Set<string>();

  // Always allow same-machine dashboard origins for the listen port
  origins.add(`http://127.0.0.1:${port}`);
  origins.add(`http://localhost:${port}`);

  for (const o of options?.corsOrigins ?? []) {
    if (o.trim()) origins.add(o.trim());
  }

  const envList = process.env.ABBENAY_CORS_ORIGINS;
  if (envList) {
    for (const o of envList.split(',')) {
      if (o.trim()) origins.add(o.trim());
    }
  }

  const cfg = config === undefined
    ? (options?.skipConfig ? null : loadConfig())
    : config;
  for (const o of serverConfig(cfg).cors_origins ?? []) {
    if (o.trim()) origins.add(o.trim());
  }

  return [...origins];
}

/**
 * Resolve full HTTP security settings for the web server.
 */
export function resolveHttpSecurity(
  port: number,
  explicitHost?: string,
  options?: WebSecurityOptions,
): ResolvedHttpSecurity {
  const config = options?.skipConfig ? null : loadConfig();
  const authEnabled = isHttpAuthEnabled(options);
  const { token, source, generated } = resolveHttpApiToken(options, config);
  return {
    apiToken: token,
    host: resolveHttpHost(explicitHost, config, options),
    corsOrigins: resolveCorsOrigins(port, options, config),
    authEnabled,
    generated,
    tokenSource: source,
  };
}

/**
 * Timing-safe string equality (Bearer, cookie, query, and CSRF compares).
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to keep timing roughly constant
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * True when cookies should include the Secure flag (HTTPS or TLS-terminated proxy).
 */
export function cookieSecureFromRequest(req: Request): boolean {
  if (req.secure) return true;
  const xf = req.headers['x-forwarded-proto'];
  if (typeof xf === 'string') {
    const proto = xf.split(',')[0]?.trim().toLowerCase();
    if (proto === 'https') return true;
  }
  return false;
}

/**
 * Extract Bearer token from Authorization header.
 */
export function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Parse a cookie value by name from the Cookie header.
 */
export function getCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function requestOrigin(req: Request): string | null {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) return origin;

  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer.length > 0) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

function isOriginAllowed(origin: string | null, allowlist: string[], req: Request): boolean {
  // No Origin/Referer: non-browser clients (curl, SDKs) — allowed when Bearer is used.
  if (!origin) return true;
  if (allowlist.includes(origin)) return true;

  // Same-origin relative to the Host header (dashboard)
  const host = req.headers.host;
  if (host) {
    const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
    const selfOrigin = `${proto}://${host}`;
    if (origin === selfOrigin) return true;
  }
  return false;
}

/**
 * CORS middleware with an explicit origin allowlist (never *).
 */
export function createCorsMiddleware(allowlist: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;

    if (origin) {
      if (!allowlist.includes(origin)) {
        // Reject foreign origins for both preflight and actual requests
        if (req.method === 'OPTIONS') {
          res.sendStatus(403);
          return;
        }
        res.status(403).json({ error: 'Origin not allowed' });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      `Content-Type, Authorization, ${CSRF_HEADER}, ${SESSION_OWNER_HEADER}, Mcp-Session-Id, MCP-Protocol-Version`,
    );

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

/**
 * Auth + CSRF middleware for protected HTTP routes.
 *
 * When `authEnabled` is false (ABBENAY_HTTP_AUTH disable escape hatch), all
 * requests pass through without checking credentials.
 *
 * Accepts:
 * 1. Authorization: Bearer <token>
 * 2. SameSite cookie abbenay_api_token (browser dashboard) — mutating
 *    methods also require a matching CSRF header/cookie or allowlisted Origin.
 */
export function createAuthMiddleware(
  apiToken: string,
  corsOrigins: string[],
  authEnabled: boolean = true,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const reqWithOwner = req as RequestWithOwner;

    if (!authEnabled) {
      reqWithOwner.abbenayOwner = LOCAL_SESSION_OWNER;
      next();
      return;
    }

    const bearer = extractBearerToken(req);
    const cookieToken = getCookie(req, API_TOKEN_COOKIE);

    const bearerOk = bearer !== null && timingSafeEqualString(bearer, apiToken);
    const cookieOk = cookieToken !== null && timingSafeEqualString(cookieToken, apiToken);

    if (!bearerOk && !cookieOk) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Cookie-only auth on state-changing methods needs CSRF protection.
    // Bearer auth is CSRF-safe (custom header cannot be set cross-origin
    // without a CORS preflight that we reject for foreign origins).
    if (cookieOk && !bearerOk && !SAFE_METHODS.has(req.method)) {
      const csrfHeader = req.headers[CSRF_HEADER];
      const csrfCookie = getCookie(req, CSRF_COOKIE);
      const csrfOk =
        typeof csrfHeader === 'string' &&
        csrfCookie !== null &&
        timingSafeEqualString(csrfHeader, csrfCookie);

      const origin = requestOrigin(req);
      const originOk = isOriginAllowed(origin, corsOrigins, req) && origin !== null;

      if (!csrfOk && !originOk) {
        res.status(403).json({ error: 'CSRF validation failed' });
        return;
      }
    }

    const claimRaw = req.headers[SESSION_OWNER_HEADER];
    const claim = typeof claimRaw === 'string' ? claimRaw : undefined;
    reqWithOwner.abbenayOwner = resolveHttpSessionOwner(apiToken, claim);
    next();
  };
}

export interface AuthCookieOptions {
  /** Set the Secure flag (HTTPS / TLS-terminated reverse proxy). */
  secure?: boolean;
}

/**
 * Set SameSite=Strict auth + CSRF cookies for the dashboard.
 */
export function setAuthCookies(
  res: Response,
  apiToken: string,
  opts?: AuthCookieOptions,
): string {
  const csrf = crypto.randomBytes(24).toString('base64url');
  const secure = opts?.secure ? '; Secure' : '';
  const tokenCookie =
    `${API_TOKEN_COOKIE}=${encodeURIComponent(apiToken)}; Path=/; HttpOnly; SameSite=Strict${secure}`;
  // Not HttpOnly so dashboard JS can send X-CSRF-Token
  const csrfCookie =
    `${CSRF_COOKIE}=${encodeURIComponent(csrf)}; Path=/; SameSite=Strict${secure}`;
  res.append('Set-Cookie', tokenCookie);
  res.append('Set-Cookie', csrfCookie);
  return csrf;
}

/**
 * Clear auth cookies.
 */
export function clearAuthCookies(res: Response, opts?: AuthCookieOptions): void {
  const secure = opts?.secure ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${API_TOKEN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`,
  );
  res.append('Set-Cookie', `${CSRF_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict${secure}`);
}
