/**
 * Resolve VS Code settings for local vs remote Abbenay gRPC connections.
 */

import * as vscode from 'vscode';

/** Default CN for daemon auto-generated TLS certs (matches packages/daemon grpc-tls). */
export const GRPC_TLS_DEFAULT_CN = 'abbenay-grpc';

/** SecretStorage key for the consumer token (never stored in settings.json). */
export const DAEMON_TOKEN_SECRET_KEY = 'abbenay.daemonToken';

export interface DaemonConnectionConfig {
  /** When set, connect to this gRPC host:port and skip local auto-start. */
  address: string | undefined;
  /** Whether this is a remote (configured) address. */
  isRemote: boolean;
  /** Use TLS channel credentials (remote only; unix stays plaintext). */
  tls: boolean;
  /** Path to CA PEM for self-signed / container certs. */
  caPath: string | undefined;
  /** SSL target name override for auto-generated certs. */
  sslTargetName: string;
  /** Env var name that may hold x-abbenay-token. */
  tokenEnv: string | undefined;
}

/**
 * Normalize a user-entered gRPC address to host:port (strip http(s)://).
 * Rejects userinfo (user:pass@host), unix sockets, and values without a port.
 */
export function normalizeDaemonAddress(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  let value = raw.trim();
  if (!value) {
    return undefined;
  }

  // Accept accidental URL forms; gRPC wants host:port.
  value = value.replace(/^https?:\/\//i, '');
  // Drop path/query if pasted as a URL.
  const slash = value.indexOf('/');
  if (slash >= 0) {
    value = value.slice(0, slash);
  }
  const q = value.indexOf('?');
  if (q >= 0) {
    value = value.slice(0, q);
  }

  value = value.trim();
  if (!value) {
    return undefined;
  }

  // Reject unix sockets as "remote" — those use the local path.
  if (value.startsWith('unix:')) {
    return undefined;
  }

  // Never keep URL userinfo (would land in logs / status toasts).
  if (value.includes('@')) {
    return undefined;
  }

  // Require host:port (IPv6 bracket form: [2001:db8::1]:50051).
  if (value.startsWith('[')) {
    const end = value.indexOf(']:');
    if (end < 0) {
      return undefined;
    }
    const port = Number(value.slice(end + 2));
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return undefined;
    }
    return value;
  }

  const lastColon = value.lastIndexOf(':');
  if (lastColon <= 0) {
    return undefined;
  }
  const host = value.slice(0, lastColon).trim();
  const port = Number(value.slice(lastColon + 1).trim());
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
    return undefined;
  }

  // Common footgun: HTTP dashboard port is not gRPC.
  if (port === 8787) {
    return undefined;
  }

  return `${host}:${port}`;
}

/**
 * Derive a likely dashboard HTTP URL from a remote gRPC host:port.
 * Assumes the HTTP server is on the same host at port 8787.
 */
export function dashboardUrlFromDaemonAddress(address: string | undefined): string | undefined {
  if (!address) {
    return undefined;
  }
  let host: string;
  if (address.startsWith('[')) {
    const end = address.indexOf(']:');
    if (end < 0) {
      return undefined;
    }
    host = address.slice(1, end);
  } else {
    const lastColon = address.lastIndexOf(':');
    if (lastColon <= 0) {
      return undefined;
    }
    host = address.slice(0, lastColon);
  }
  if (!host) {
    return undefined;
  }
  return `http://${host.includes(':') ? `[${host}]` : host}:8787`;
}

/**
 * Read daemon connection settings from VS Code configuration.
 */
export function readDaemonConnectionConfig(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('abbenay'),
): DaemonConnectionConfig {
  const address = normalizeDaemonAddress(config.get<string>('daemonAddress'));
  const isRemote = !!address;

  const tlsSetting = config.get<boolean>('daemonTls');
  // Default true for remote (container --grpc-tls); false when unset/local.
  const tls = isRemote ? (tlsSetting !== false) : false;

  const caPathRaw = config.get<string>('daemonCaPath')?.trim();
  const caPath = caPathRaw || undefined;

  const sslTargetRaw = config.get<string>('daemonSslTargetName')?.trim();
  const sslTargetName = sslTargetRaw || GRPC_TLS_DEFAULT_CN;

  const tokenEnvRaw = config.get<string>('daemonTokenEnv')?.trim();
  const tokenEnv = tokenEnvRaw || undefined;

  return {
    address,
    isRemote,
    tls,
    caPath,
    sslTargetName,
    tokenEnv,
  };
}

/**
 * Resolve consumer token: SecretStorage wins, then env var named by daemonTokenEnv.
 */
export async function resolveDaemonToken(
  config: DaemonConnectionConfig,
  secrets?: vscode.SecretStorage,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (secrets) {
    const stored = await secrets.get(DAEMON_TOKEN_SECRET_KEY);
    if (stored?.trim()) {
      return stored.trim();
    }
  }

  if (config.tokenEnv) {
    const fromEnv = env[config.tokenEnv];
    if (fromEnv?.trim()) {
      return fromEnv.trim();
    }
  }

  return undefined;
}

/**
 * Human-readable connection mode for status/logs (never includes token).
 */
export function describeConnectionMode(config: DaemonConnectionConfig): string {
  if (!config.isRemote || !config.address) {
    return 'local';
  }
  const tlsLabel = config.tls ? 'tls' : 'plaintext';
  return `remote:${config.address} (${tlsLabel})`;
}

/** Setting keys that require a daemon reconnect when changed. */
export const DAEMON_CONNECTION_SETTING_KEYS = [
  'abbenay.daemonAddress',
  'abbenay.daemonTls',
  'abbenay.daemonCaPath',
  'abbenay.daemonSslTargetName',
  'abbenay.daemonTokenEnv',
] as const;

export function affectsDaemonConnection(e: vscode.ConfigurationChangeEvent): boolean {
  return DAEMON_CONNECTION_SETTING_KEYS.some((key) => e.affectsConfiguration(key));
}
