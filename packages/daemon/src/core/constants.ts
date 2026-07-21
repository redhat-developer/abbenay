/**
 * Shared constants for the Abbenay daemon.
 *
 * Network, protocol, and operational defaults that don't belong
 * in a specific module.  Import from here or via the @abbenay/core barrel.
 */

/** Default HTTP port for the web dashboard and API server. */
export const DEFAULT_WEB_PORT = 8787;

/** Default HTTP bind host (loopback only — opt in to 0.0.0.0 explicitly). */
export const DEFAULT_HTTP_HOST = '127.0.0.1';
