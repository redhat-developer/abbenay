/**
 * Consumer authorization for gRPC (DR-024 / DR-025 / DR-037).
 *
 * - Localhost / unix socket: empty `consumers` remains allow-all (local DX).
 * - Non-loopback bind: empty `consumers` fails closed unless explicit open mode
 *   (`--allow-open-auth` or `--insecure`).
 * - When `consumers` is configured: sensitive RPCs require a matching token
 *   (timing-safe) and the requested capability.
 */

import * as crypto from 'node:crypto';
import type * as grpc from '@grpc/grpc-js';
import type { ConfigFile, ConsumerCapabilities } from '../../core/config.js';
import { isLoopbackHost } from '../grpc-tls.js';

/** Capabilities a consumer may be granted. */
export type ConsumerCapability = keyof ConsumerCapabilities;

export interface AuthResult {
  allowed: boolean;
  consumer?: string;
  reason?: string;
}

/**
 * Runtime auth policy derived from bind address + CLI flags.
 * Passed into the gRPC service so RPC gates match startup policy.
 */
export interface ConsumerAuthContext {
  /**
   * True when gRPC is only reachable via unix socket and/or loopback TCP.
   * Empty consumers are allowed (default-open local DX).
   */
  loopbackOnly: boolean;
  /**
   * Explicit open mode: `--allow-open-auth` and/or `--insecure`.
   * Permits empty consumers on non-loopback binds (not recommended).
   */
  allowOpenAuth: boolean;
}

/** Default: local DX (unix / loopback). Used by unit tests and unix-only binds. */
export const DEFAULT_CONSUMER_AUTH_CONTEXT: ConsumerAuthContext = {
  loopbackOnly: true,
  allowOpenAuth: false,
};

const CAPABILITY_LABELS: Record<ConsumerCapability, string> = {
  inline_policy: 'Inline policy',
  mcp_register: 'MCP registration',
  secrets: 'Secrets',
  config: 'Configuration',
  providers: 'Provider management',
  shutdown: 'Shutdown',
  chat: 'Chat',
};

export class ConsumerAuthBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumerAuthBindError';
  }
}

/** True when config has at least one named consumer entry. */
export function hasConfiguredConsumers(config: ConfigFile | null | undefined): boolean {
  const consumers = config?.consumers;
  return !!consumers && Object.keys(consumers).length > 0;
}

/**
 * Resolve whether open auth is explicitly requested via CLI/env.
 * `--insecure` counts as open mode (E2E / container escape hatch).
 */
export function resolveAllowOpenAuth(opts: {
  allowOpenAuth?: boolean;
  insecure?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (opts.allowOpenAuth || opts.insecure) {
    return true;
  }
  const env = opts.env ?? process.env;
  const raw = (env.ABBENAY_ALLOW_OPEN_AUTH || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Build auth context from TCP bind host (if any) and open-mode flags.
 * No TCP port → loopback-only (unix socket).
 */
export function buildConsumerAuthContext(opts: {
  grpcHost?: string;
  grpcPort?: number;
  allowOpenAuth?: boolean;
  insecure?: boolean;
  env?: NodeJS.ProcessEnv;
}): ConsumerAuthContext {
  const allowOpenAuth = resolveAllowOpenAuth(opts);
  if (!opts.grpcPort) {
    return { loopbackOnly: true, allowOpenAuth };
  }
  const host = opts.grpcHost ?? '127.0.0.1';
  return {
    loopbackOnly: isLoopbackHost(host),
    allowOpenAuth,
  };
}

/**
 * Refuse non-loopback TCP binds when no consumers are configured and open
 * mode was not explicitly requested.
 */
export function assertConsumersConfiguredForBind(
  host: string,
  config: ConfigFile | null | undefined,
  opts: { allowOpenAuth: boolean },
): void {
  if (isLoopbackHost(host)) {
    return;
  }
  if (hasConfiguredConsumers(config)) {
    return;
  }
  if (opts.allowOpenAuth) {
    return;
  }
  throw new ConsumerAuthBindError(
    `Refusing to bind gRPC on non-loopback address "${host}" without configured consumers. ` +
      'Add a consumers section to config.yaml (recommended), or pass --allow-open-auth / --insecure ' +
      'to explicitly allow unauthenticated access (not recommended).',
  );
}

/**
 * Timing-safe string equality for consumer tokens.
 * Returns false when lengths differ (after a same-length dummy compare).
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Find the consumer name whose token matches (timing-safe).
 * Returns undefined when no consumers are configured or no match.
 */
export function matchConsumerByToken(
  config: ConfigFile | null | undefined,
  token: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const consumers = config?.consumers;
  if (!consumers || Object.keys(consumers).length === 0 || !token) {
    return undefined;
  }

  let matched: string | undefined;
  for (const [name, consumer] of Object.entries(consumers)) {
    const expectedToken = consumer.token_env ? env[consumer.token_env] : undefined;
    if (!expectedToken) continue;
    if (timingSafeEqualString(token, expectedToken)) {
      // Continue scanning so compare work is not short-circuited by early return
      // on the first candidate (minor hardening; first match still wins).
      if (matched === undefined) {
        matched = name;
      }
    }
  }
  return matched;
}

function extractToken(call: { metadata: grpc.Metadata }): string | undefined {
  const metadata = call.metadata.get('x-abbenay-token');
  return metadata.length > 0 ? String(metadata[0]) : undefined;
}

/**
 * Authorize a gRPC call for a specific consumer capability.
 *
 * @param authContext Bind/open-mode policy (defaults to local DX allow-all when empty).
 */
export function authorizeConsumer(
  call: { metadata: grpc.Metadata },
  config: ConfigFile,
  capability: ConsumerCapability,
  authContext: ConsumerAuthContext = DEFAULT_CONSUMER_AUTH_CONTEXT,
): AuthResult {
  if (!hasConfiguredConsumers(config)) {
    if (authContext.loopbackOnly || authContext.allowOpenAuth) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason:
        'Consumer authentication is required when gRPC is bound beyond localhost. ' +
        'Configure a consumers section in config.yaml, or restart with --allow-open-auth / --insecure.',
    };
  }

  const token = extractToken(call);
  if (!token) {
    return {
      allowed: false,
      reason: `${CAPABILITY_LABELS[capability]} requires consumer authentication. Set the x-abbenay-token gRPC metadata header.`,
    };
  }

  const name = matchConsumerByToken(config, token);
  if (!name) {
    return {
      allowed: false,
      reason: `Consumer token not recognized or lacks ${CAPABILITY_LABELS[capability]} capability.`,
    };
  }

  const consumer = config.consumers![name]!;
  if (consumer.capabilities?.[capability]) {
    return { allowed: true, consumer: name };
  }

  return {
    allowed: false,
    reason: `Consumer token not recognized or lacks ${CAPABILITY_LABELS[capability]} capability.`,
  };
}
