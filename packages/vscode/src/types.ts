/**
 * Shared type definitions for the VS Code extension.
 *
 * Provider/model/chat types live in the gRPC proto definitions
 * (see proto/abbenay/v1/service.ts). Only extension-internal
 * interfaces belong here.
 */

/**
 * Logger interface used by the OutputChannelLogger
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
