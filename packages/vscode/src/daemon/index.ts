/**
 * Abbenay Daemon Client
 * 
 * The daemon uses Unix Domain Sockets for local IPC:
 * - Socket: <runtimeDir>/daemon.sock   (Linux: /run/user/<uid>/abbenay/)
 * - PID file: <runtimeDir>/abbenay.pid
 * - Config: <configDir>/config.yaml    (Linux: ~/.config/abbenay/)
 * 
 * Architecture:
 * - VS Code → Daemon: gRPC client for chat, sessions, config, etc.
 * - Daemon → VS Code: Bidirectional stream for tool invocation, Copilot access
 * 
 * Usage:
 * 
 * ```typescript
 * import { initializeDaemon, getDaemonClient, BackchannelHandler } from './daemon';
 * 
 * // Initialize (auto-starts daemon, connects, registers)
 * const client = await initializeDaemon();
 * 
 * // Start backchannel for daemon callbacks
 * const backchannel = new BackchannelHandler(client, context);
 * await backchannel.start();
 * 
 * // Chat with streaming
 * for await (const chunk of client.chat({ messages: [...], modelId: 'gpt-4' })) {
 *     console.log(chunk.content);
 * }
 * ```
 */

export * from './client';
export { BackchannelHandler } from './backchannel';
