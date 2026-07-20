/**
 * Provider base URL / endpoint policy (findings A1/A3).
 *
 * A writable config that points `base_url` at a malicious host can exfiltrate
 * prompts, responses, and API keys. All runtime provider endpoint changes go
 * through {@link validateProviderEndpoint} (or the config-wide helper) before
 * being persisted or used for outbound discovery calls.
 *
 * Policy (DR-039):
 * - Absolute URL, `http:` or `https:` only, hostname required, no userinfo
 * - `http:` only to loopback unless the host is on `allowed_provider_hosts`
 *   or `allow_insecure_provider_http` is set
 * - When `allowed_provider_hosts` is non-empty, non-loopback hosts must match
 */

export interface ProviderEndpointPolicy {
  /**
   * Optional host allowlist (exact hostname match, case-insensitive).
   * When non-empty, every non-loopback provider endpoint host must appear here.
   */
  allowedHosts?: string[];
  /**
   * When true, allow `http:` to non-loopback hosts (air-gapped / explicit trust).
   * Still subject to `allowedHosts` when that list is non-empty.
   */
  allowInsecureHttp?: boolean;
}

export type ProviderEndpointValidation =
  | { ok: true; normalized: string; hostname: string; protocol: 'http:' | 'https:' }
  | { ok: false; error: string };

/** True for localhost / loopback names used by Ollama, LM Studio, local RHAI, etc. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0:0:0:0:0:0:0:1') {
    return true;
  }
  // RFC 6761: *.localhost resolves to loopback
  if (h.endsWith('.localhost')) {
    return true;
  }
  return false;
}

function normalizeAllowedHosts(hosts: string[] | undefined): string[] {
  if (!hosts || hosts.length === 0) return [];
  return hosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function hostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return allowedHosts.includes(h);
}

/**
 * Format-only checks: absolute URL, http/https, hostname, no userinfo.
 * Used by Zod so allowlist hosts in the same config payload are not rejected
 * before {@link validateConfigProviderEndpoints} applies host policy.
 */
export function validateProviderEndpointFormat(raw: string): ProviderEndpointValidation {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return { ok: false, error: 'provider endpoint must be a non-empty URL' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'provider endpoint is not a valid absolute URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: `provider endpoint scheme must be http or https (got ${parsed.protocol.replace(':', '')})`,
    };
  }

  if (!parsed.hostname) {
    return { ok: false, error: 'provider endpoint must include a hostname' };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: 'provider endpoint must not include credentials in the URL',
    };
  }

  // Keep the caller's trimmed string (URL.href would force a trailing "/" on
  // bare origins like https://api.example.com).
  return {
    ok: true,
    normalized: trimmed,
    hostname: parsed.hostname,
    protocol: parsed.protocol,
  };
}

/**
 * Validate a provider `base_url` / discovery endpoint against the scheme/host policy.
 */
export function validateProviderEndpoint(
  raw: string,
  policy: ProviderEndpointPolicy = {},
): ProviderEndpointValidation {
  const format = validateProviderEndpointFormat(raw);
  if (!format.ok) return format;

  const { hostname, protocol, normalized } = format;
  const loopback = isLoopbackHostname(hostname);
  const allowedHosts = normalizeAllowedHosts(policy.allowedHosts);

  if (allowedHosts.length > 0 && !loopback && !hostAllowed(hostname, allowedHosts)) {
    return {
      ok: false,
      error:
        `provider endpoint host "${hostname}" is not in server.allowed_provider_hosts`,
    };
  }

  if (protocol === 'http:' && !loopback) {
    const onAllowlist = allowedHosts.length > 0 && hostAllowed(hostname, allowedHosts);
    if (!policy.allowInsecureHttp && !onAllowlist) {
      return {
        ok: false,
        error:
          'http provider endpoints are only allowed for loopback hosts ' +
          '(localhost / 127.0.0.1 / ::1); use https, add the host to ' +
          'server.allowed_provider_hosts, or set server.allow_insecure_provider_http',
      };
    }
  }

  return {
    ok: true,
    normalized,
    hostname,
    protocol,
  };
}

/**
 * Resolve endpoint policy from a ConfigFile `server` block (and optional overrides).
 */
export function endpointPolicyFromServer(server?: {
  allowed_provider_hosts?: string[];
  allow_insecure_provider_http?: boolean;
} | null): ProviderEndpointPolicy {
  return {
    allowedHosts: server?.allowed_provider_hosts,
    allowInsecureHttp: server?.allow_insecure_provider_http === true,
  };
}

/**
 * Validate every `providers.*.base_url` in a config object.
 * Returns the first error, or ok when all endpoints pass (or are absent).
 */
export function validateConfigProviderEndpoints(
  config: {
    providers?: Record<string, { base_url?: string } | undefined>;
    server?: {
      allowed_provider_hosts?: string[];
      allow_insecure_provider_http?: boolean;
    };
  },
  policyOverride?: ProviderEndpointPolicy,
): ProviderEndpointValidation | { ok: true } {
  const policy = policyOverride ?? endpointPolicyFromServer(config.server);
  const providers = config.providers || {};
  for (const [id, cfg] of Object.entries(providers)) {
    const baseUrl = cfg?.base_url;
    if (baseUrl === undefined || baseUrl === null || baseUrl === '') continue;
    const result = validateProviderEndpoint(String(baseUrl), policy);
    if (!result.ok) {
      return {
        ok: false,
        error: `provider "${id}": ${result.error}`,
      };
    }
  }
  return { ok: true };
}

export interface ProviderEndpointAuditEvent {
  providerId: string;
  previousBaseUrl?: string | null;
  newBaseUrl: string;
  /** http-configure | http-config | grpc-configure | grpc-config | core-add | discover */
  source: string;
  /** Optional consumer / principal id when known */
  actor?: string;
}

/**
 * Emit an audit log line for a successful provider endpoint change.
 * Never logs API keys or other secrets.
 */
export function auditProviderEndpointChange(event: ProviderEndpointAuditEvent): void {
  const prev = event.previousBaseUrl ?? '(none)';
  const actor = event.actor ? ` actor=${event.actor}` : '';
  console.info(
    `[Audit] provider endpoint changed: provider=${event.providerId} ` +
      `from=${prev} to=${event.newBaseUrl} source=${event.source}${actor}`,
  );
}

/**
 * Diff provider base_url values between previous and next config and audit changes.
 */
export function auditProviderEndpointConfigDiff(
  previous: { providers?: Record<string, { base_url?: string } | undefined> } | null | undefined,
  next: { providers?: Record<string, { base_url?: string } | undefined> },
  source: string,
  actor?: string,
): void {
  const prevProviders = previous?.providers || {};
  const nextProviders = next.providers || {};
  const ids = new Set([...Object.keys(prevProviders), ...Object.keys(nextProviders)]);
  for (const id of ids) {
    const prevUrl = prevProviders[id]?.base_url;
    const nextUrl = nextProviders[id]?.base_url;
    if (nextUrl && nextUrl !== prevUrl) {
      auditProviderEndpointChange({
        providerId: id,
        previousBaseUrl: prevUrl,
        newBaseUrl: nextUrl,
        source,
        actor,
      });
    }
  }
}
