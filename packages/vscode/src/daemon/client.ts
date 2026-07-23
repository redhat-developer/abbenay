/**
 * Abbenay Daemon Client for VS Code Extension
 *
 * This module provides the gRPC client for communicating with the Abbenay daemon.
 * The client is generated from proto/abbenay/v1/service.proto
 *
 * Local IPC:
 *   Linux/macOS: Unix domain socket at <runtimeDir>/daemon.sock
 *   Windows:     loopback TCP; host:port from <runtimeDir>/daemon.addr
 */

import { createChannel, createClient, Channel } from 'nice-grpc';
import * as proto from '../proto/abbenay/v1/service';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import { getLogger } from '../utils/logger';
import {
  getRuntimeDir,
  getPidFilePath,
  getSocketFilePath,
  getAddressFilePath,
  parseDaemonAddress,
  getBundledSeaBinaryName,
  getUnixDaemonAddress,
} from './runtime-paths';

// Re-export the generated types for convenience
export * from '../proto/abbenay/v1/service';
export {
  getBundledSeaBinaryName,
  parseDaemonAddress,
  getAddressFilePath,
} from './runtime-paths';

// Daemon paths — PID + socket/address in runtime dir (matches daemon's paths.ts)
const RUNTIME_DIR = getRuntimeDir();
const PID_FILE = getPidFilePath(RUNTIME_DIR);
const SOCKET_FILE = getSocketFilePath(RUNTIME_DIR);
const ADDRESS_FILE = getAddressFilePath(RUNTIME_DIR);
const IS_WIN32 = process.platform === 'win32';

// gRPC address for Unix Domain Socket (Windows resolves from daemon.addr at connect time)
const DEFAULT_DAEMON_ADDRESS = IS_WIN32 ? '' : getUnixDaemonAddress(SOCKET_FILE);

// Extension path for finding bundled binaries (set during activation)
let extensionPath: string | undefined;

/**
 * Set the extension path for finding bundled binaries.
 * Must be called during extension activation before connecting to daemon.
 */
export function setExtensionPath(extPath: string): void {
  extensionPath = extPath;
}

/**
 * Read Windows loopback TCP address from daemon.addr.
 */
function readDaemonTcpAddress(): { host: string; port: number } | null {
  try {
    if (!fs.existsSync(ADDRESS_FILE)) {
      return null;
    }
    return parseDaemonAddress(fs.readFileSync(ADDRESS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Resolve the gRPC channel address for the current platform.
 */
export function resolveDaemonChannelAddress(): string | null {
  if (!IS_WIN32) {
    return DEFAULT_DAEMON_ADDRESS;
  }
  const addr = readDaemonTcpAddress();
  return addr ? `${addr.host}:${addr.port}` : null;
}

/**
 * Probe TCP connectivity to host:port.
 */
function probeTcp(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Check if the daemon is running by verifying PID file and IPC endpoint.
 * On Windows this is async-friendly via waitForDaemon (TCP probe); the sync
 * check requires PID + address file.
 */
export function isDaemonRunning(): boolean {
  try {
    if (!fs.existsSync(PID_FILE)) {
      return false;
    }

    const pidStr = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(pidStr, 10);

    if (isNaN(pid)) {
      return false;
    }

    // Check if process is running (signal 0 just checks existence)
    process.kill(pid, 0);

    if (IS_WIN32) {
      return fs.existsSync(ADDRESS_FILE) && readDaemonTcpAddress() !== null;
    }

    // Also verify socket exists
    return fs.existsSync(SOCKET_FILE);
  } catch (_e) {
    // process.kill throws if process doesn't exist
    return false;
  }
}

/**
 * Async liveness: PID + TCP connect on Windows, PID + socket on Unix.
 */
export async function isDaemonReady(): Promise<boolean> {
  if (!isDaemonRunning()) {
    return false;
  }
  if (!IS_WIN32) {
    return true;
  }
  const addr = readDaemonTcpAddress();
  if (!addr) {
    return false;
  }
  return probeTcp(addr.host, addr.port);
}

/**
 * Wrapper around the generated Abbenay gRPC client
 */
export class DaemonClient {
  private channel: Channel | null = null;
  private client: proto.AbbenayClient | null = null;
  private clientId: string | null = null;
  private address: string;

  constructor(address: string = DEFAULT_DAEMON_ADDRESS) {
    this.address = address;
  }

  /**
   * Connect to the daemon.
   * By default, will auto-start the daemon if it's not running.
   *
   * @param options.autoStart - Start daemon if not running (default: true)
   * @param options.timeout - Timeout waiting for daemon to start (default: 15000ms)
   */
  async connect(options: { autoStart?: boolean; timeout?: number } = {}): Promise<void> {
    if (this.channel) {
      return; // Already connected
    }

    const logger = getLogger();
    const { autoStart = true, timeout = 15000 } = options;

    // Check if daemon is running
    const running = await isDaemonReady();
    logger.info(
      `[Daemon] isDaemonReady=${running}, PID_FILE=${PID_FILE}, ` +
      `SOCKET=${SOCKET_FILE}, ADDRESS_FILE=${ADDRESS_FILE}`,
    );

    if (!running) {
      if (autoStart) {
        logger.info('[Daemon] Daemon not running, attempting to start...');
        await this.startDaemon();
        // Wait for daemon to be ready
        await this.waitForDaemon(timeout);
        logger.info('[Daemon] Daemon started and ready');
      } else {
        const endpoint = IS_WIN32 ? ADDRESS_FILE : SOCKET_FILE;
        throw new Error(
          `Abbenay daemon is not running. ` +
          `Expected endpoint via ${endpoint}. ` +
          `Start the daemon with: abbenay daemon`,
        );
      }
    }

    const address = this.address || resolveDaemonChannelAddress();
    if (!address) {
      throw new Error(
        `Abbenay daemon address not found. Expected ${ADDRESS_FILE} with host:port.`,
      );
    }
    this.address = address;

    logger.info(`[Daemon] Creating gRPC channel to ${this.address}`);
    this.channel = createChannel(this.address);
    this.client = createClient(proto.AbbenayDefinition, this.channel);
  }

  /**
   * Start the daemon process.
   *
   * The daemon is a TypeScript/Node.js application.
   * Priority: 1) `abbenay` in PATH (global install or SEA binary)
   *           2) Workspace monorepo packages/daemon/dist/index.js
   *           3) Bundled daemon JS in extension's bin/ directory
   *
   * Note: For browser-based VS Code (vscode.dev, Codespaces), the daemon must
   * already be running as a remote service. Process spawning only works on desktop.
   */
  private async startDaemon(): Promise<void> {
    const { spawn } = await import('child_process');
    const logger = getLogger();

    // Ensure runtime directory exists (PID + socket/address live here)
    if (!fs.existsSync(RUNTIME_DIR)) {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
    }

    const { cmd, args } = await this.findDaemonCommand();

    logger.info(`[Daemon] Spawning: ${cmd} ${[...args, 'daemon'].join(' ')}`);

    // Log daemon stdout/stderr to a file so we can debug
    const logPath = path.join(os.tmpdir(), 'abbenay-daemon.log');
    const logFd = fs.openSync(logPath, 'a');
    logger.info(`[Daemon] Logging to: ${logPath}`);

    const daemon = spawn(cmd, [...args, 'daemon'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        ABBENAY_SOCKET: SOCKET_FILE,
        ABBENAY_PID_FILE: PID_FILE,
      },
      // On Windows, hide console window for the detached daemon process
      windowsHide: true,
    });

    logger.info(`[Daemon] Spawned PID: ${daemon.pid}`);
    daemon.unref();
  }

  /**
   * Find the daemon command and arguments.
   * Returns { cmd, args } where the daemon subcommand should be appended.
   *
   * The daemon is always a self-contained SEA (Single Executable Application)
   * binary — no Node.js dependency needed at runtime.
   *
   * Priority:
   *   1) `abbenay` in PATH (global install or SEA binary)
   *   2) Bundled SEA binary in extension's bin/
   */
  private async findDaemonCommand(): Promise<{ cmd: string; args: string[] }> {
    const { execSync } = await import('child_process');
    const logger = getLogger();

    // 1) Try to find abbenay in PATH (global npm install, npm link, or SEA binary)
    try {
      const cmd = process.platform === 'win32' ? 'where abbenay' : 'which abbenay';
      const result = execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
      if (result && fs.existsSync(result)) {
        logger.info(`[Daemon] Found abbenay in PATH: ${result}`);
        return { cmd: result, args: [] };
      }
    } catch {
      logger.info('[Daemon] abbenay not found in PATH');
    }

    // 2) Bundled SEA binary — self-contained, no node dependency
    if (extensionPath) {
      const seaBinary = path.join(
        extensionPath,
        'bin',
        getBundledSeaBinaryName(process.platform, process.arch),
      );
      if (fs.existsSync(seaBinary)) {
        logger.info(`[Daemon] Found SEA binary: ${seaBinary}`);
        return { cmd: seaBinary, args: [] };
      }
      logger.error(`[Daemon] SEA binary not found at ${seaBinary}`);
    }

    throw new Error(
      `Abbenay daemon binary not found. ` +
      `The extension package may be corrupt — try reinstalling.`,
    );
  }

  /**
   * Wait for daemon to be ready
   */
  private async waitForDaemon(timeout: number): Promise<void> {
    const start = Date.now();
    const pollInterval = 100;

    while (Date.now() - start < timeout) {
      if (await isDaemonReady()) {
        // Give it a moment to accept connections
        await new Promise(r => setTimeout(r, 100));
        return;
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }

    throw new Error(`Daemon did not start within ${timeout}ms`);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.channel !== null && this.client !== null;
  }

  /**
   * Get the raw client for advanced usage
   */
  getClient(): proto.AbbenayClient {
    if (!this.client) {
      throw new Error('Not connected to daemon. Call connect() first.');
    }
    return this.client;
  }

  /**
   * Register this VS Code extension as a client
   */
  async register(): Promise<string> {
    const client = this.getClient();

    // Get workspace path from VS Code
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspacePath = workspaceFolders && workspaceFolders.length > 0
      ? workspaceFolders[0].uri.fsPath
      : '';

    const logger = getLogger();
    logger.info('[Daemon] Registering with daemon...');
    logger.info(`[Daemon] Workspace folders: ${JSON.stringify(workspaceFolders?.map(f => f.uri.fsPath))}`);
    logger.info(`[Daemon] Workspace path to send: "${workspacePath}"`);

    const response = await client.register({
      client: {
        clientType: proto.ClientType.CLIENT_TYPE_VSCODE,
        user: process.env.USER || process.env.USERNAME || 'unknown',
      },
      isSpawner: false,
      workspacePath: workspacePath,
    });
    logger.info(`[Daemon] Registered with client ID: ${response.clientId}`);
    this.clientId = response.clientId;
    return this.clientId;
  }

  /**
   * Unregister this client
   */
  async unregister(): Promise<void> {
    if (this.clientId && this.client) {
      try {
        await this.client.unregister({ clientId: this.clientId });
      } catch (_e) {
        // Ignore errors during unregister
      }
      this.clientId = null;
    }
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    await this.unregister();
    if (this.channel) {
      this.channel.close();
      this.channel = null;
      this.client = null;
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const client = this.getClient();
      const response = await client.healthCheck({});
      return response.healthy;
    } catch (_e) {
      return false;
    }
  }

  /**
   * Get daemon status
   */
  async getStatus(): Promise<proto.DaemonStatus> {
    const client = this.getClient();
    return client.getStatus({});
  }

  /**
   * List available models (workspace-aware)
   */
  async listModels(): Promise<proto.Model[]> {
    const client = this.getClient();
    const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
    const response = await client.listModels({ workspacePaths: folders });
    return response.models;
  }

  /**
   * List available engines (fixed set of API implementations)
   */
  async listEngines(): Promise<proto.Engine[]> {
    const client = this.getClient();
    const response = await client.listEngines({});
    return response.engines;
  }

  /**
   * List available providers
   */
  async listProviders(): Promise<proto.Provider[]> {
    const client = this.getClient();
    const response = await client.listProviders({});
    return response.providers;
  }

  /**
   * Stateless chat - returns an async iterator of chunks
   */
  chat(request: proto.DeepPartial<proto.ChatRequest>): AsyncIterable<proto.ChatChunk> {
    const client = this.getClient();
    return client.chat(request);
  }

  /**
   * Session-based chat
   */
  sessionChat(request: proto.DeepPartial<proto.SessionChatRequest>): AsyncIterable<proto.ChatChunk> {
    const client = this.getClient();
    return client.sessionChat(request);
  }

  /**
   * Create a new session
   */
  async createSession(model: string, topic?: string, metadata?: Record<string, string>): Promise<proto.Session> {
    const client = this.getClient();
    return client.createSession({ model, topic, metadata: metadata || {} });
  }

  /**
   * Get a session by ID
   */
  async getSession(sessionId: string, includeMessages: boolean = true): Promise<proto.Session> {
    const client = this.getClient();
    return client.getSession({ sessionId, includeMessages });
  }

  /**
   * List all sessions
   */
  async listSessions(): Promise<proto.SessionSummary[]> {
    const client = this.getClient();
    const response = await client.listSessions({});
    return response.sessions;
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    const client = this.getClient();
    await client.deleteSession({ sessionId });
  }

  /**
   * List available tools
   */
  async listTools(): Promise<proto.Tool[]> {
    const client = this.getClient();
    const response = await client.listTools({});
    return response.tools;
  }

  /**
   * Execute a tool
   */
  async executeTool(toolName: string, args: Record<string, unknown>): Promise<proto.ExecuteToolResponse> {
    const client = this.getClient();
    return client.executeTool({
      name: toolName,
      arguments: JSON.stringify(args),
    });
  }

  /**
   * Set a secret in the daemon's keychain store
   */
  async setSecret(key: string, value: string): Promise<void> {
    const client = this.getClient();
    await client.setSecret({ key, value });
  }

  /**
   * Delete a secret
   */
  async deleteSecret(key: string): Promise<void> {
    const client = this.getClient();
    await client.deleteSecret({ key });
  }

  /**
   * List secrets (returns SecretInfo with key, store, hasValue)
   */
  async listSecrets(): Promise<proto.SecretInfo[]> {
    const client = this.getClient();
    const response = await client.listSecrets({});
    return response.secrets;
  }

  /**
   * Get configuration (user or workspace level)
   */
  async getConfig(location?: string): Promise<proto.GetConfigResponse> {
    const client = this.getClient();
    return client.getConfig({ location });
  }

  /**
   * Update configuration (user or workspace level)
   */
  async updateConfig(config: proto.Config, location?: string): Promise<proto.GetConfigResponse> {
    const client = this.getClient();
    return client.updateConfig({ config, location });
  }

  /**
   * Configure a provider (add or update, with optional API key storage)
   */
  async configureProvider(params: {
    providerId: string;
    engine?: string;
    apiKey?: string;
    envVarName?: string;
    baseUrl?: string;
    target?: string;
    workspacePath?: string;
  }): Promise<proto.ConfigureProviderResponse> {
    const client = this.getClient();
    return client.configureProvider({
      providerId: params.providerId,
      engine: params.engine,
      apiKey: params.apiKey,
      envVarName: params.envVarName,
      baseUrl: params.baseUrl,
      target: params.target,
      workspacePath: params.workspacePath,
    });
  }

  /**
   * Remove a provider configuration
   */
  async removeProvider(providerId: string, target?: string, workspacePath?: string): Promise<void> {
    const client = this.getClient();
    await client.removeProvider({ providerId, target, workspacePath });
  }

  /**
   * Get predefined provider templates for the add-provider wizard
   */
  async getProviderTemplates(): Promise<proto.ProviderTemplate[]> {
    const client = this.getClient();
    const response = await client.getProviderTemplates({});
    return response.templates;
  }

  /**
   * Discover models with optional credential resolution from provider config
   */
  async discoverModels(engineId: string, options?: { apiKey?: string; baseUrl?: string; providerId?: string }): Promise<proto.Model[]> {
    const client = this.getClient();
    const response = await client.discoverModels({
      engineId,
      apiKey: options?.apiKey,
      baseUrl: options?.baseUrl,
      providerId: options?.providerId,
    });
    return response.models;
  }

  /**
   * Check if a specific key is available (keychain or env)
   */
  async getKeyStatus(source: string, name: string): Promise<boolean> {
    const client = this.getClient();
    const response = await client.getKeyStatus({ source, name });
    return response.exists;
  }

  /**
   * List configured MCP servers with connection status
   */
  async listMcpServerConfigs(): Promise<proto.McpServerStatusEntry[]> {
    const client = this.getClient();
    const response = await client.listMcpServerConfigs({});
    return response.mcpServers;
  }

  /**
   * Reconnect a failed MCP server
   */
  async reconnectMcpServer(serverId: string): Promise<void> {
    const client = this.getClient();
    await client.reconnectMcpServer({ serverId });
  }

  /**
   * Create or update a custom policy
   */
  async createPolicy(name: string, config: proto.PolicyConfig): Promise<void> {
    const client = this.getClient();
    await client.createPolicy({ name, config });
  }

  /**
   * Delete a custom policy
   */
  async deletePolicy(name: string): Promise<void> {
    const client = this.getClient();
    await client.deletePolicy({ name });
  }

  /**
   * Start the embedded web server (dashboard) via gRPC.
   * Returns the URL to open in the browser.
   */
  async startWebServer(port: number = 8787): Promise<proto.StartWebServerResponse> {
    const client = this.getClient();
    return client.startWebServer({ port });
  }

  /**
   * Stop the embedded web server via gRPC.
   */
  async stopWebServer(): Promise<void> {
    const client = this.getClient();
    await client.stopWebServer({});
  }

  /**
   * Register MCP server (VS Code extension registers itself)
   */
  async registerMcpServer(serverId: string, transport: proto.McpTransport, toolFilter?: string[]): Promise<proto.RegisterMcpServerResponse> {
    const client = this.getClient();
    return client.registerMcpServer({
      serverId,
      transport,
      toolFilter,
    });
  }
}

// Singleton instance
let _instance: DaemonClient | null = null;

/**
 * Get the shared daemon client instance
 */
export function getDaemonClient(): DaemonClient {
  if (!_instance) {
    _instance = new DaemonClient();
  }
  return _instance;
}

/**
 * Reset the daemon client (used internally by shutdownDaemon)
 */
function resetDaemonClient(): void {
  if (_instance) {
    _instance.close().catch(() => {});
    _instance = null;
  }
}

/**
 * Initialize the daemon client for the VS Code extension.
 * This will:
 * 1. Start the daemon if not running
 * 2. Connect to the daemon
 * 3. Register as a VS Code client
 *
 * Call this during extension activation.
 *
 * @param options.timeoutMs Overall deadline for connect+register (default 20s)
 */
export async function initializeDaemon(
  options: { timeoutMs?: number } = {},
): Promise<DaemonClient> {
  const { timeoutMs = 20000 } = options;
  const client = getDaemonClient();

  const work = (async () => {
    // Leave headroom for register() after waitForDaemon.
    const connectTimeout = Math.max(5_000, timeoutMs - 5_000);
    await client.connect({ autoStart: true, timeout: connectTimeout });
    await client.register();
    return client;
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Daemon initialization timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Shutdown the daemon client.
 * Call this during extension deactivation.
 */
export async function shutdownDaemon(): Promise<void> {
  const client = getDaemonClient();
  await client.close();
  resetDaemonClient();
}
