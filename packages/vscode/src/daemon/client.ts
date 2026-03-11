/**
 * Abbenay Daemon Client for VS Code Extension
 * 
 * This module provides the gRPC client for communicating with the Abbenay daemon.
 * The client is generated from proto/abbenay/v1/service.proto
 * 
 * The daemon uses Unix Domain Sockets for local IPC.
 * Runtime paths (PID file, socket) are computed using the same platform-aware
 * logic as the daemon (see packages/daemon/src/paths.ts):
 *   Linux:   $XDG_RUNTIME_DIR/abbenay  → /run/user/<uid>/abbenay
 *   macOS:   os.tmpdir()/abbenay
 *   Windows: named pipe
 */

import { createChannel, createClient, Channel } from 'nice-grpc';
import * as proto from '../proto/abbenay/v1/service';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLogger } from '../utils/logger';

// Re-export the generated types for convenience
export * from '../proto/abbenay/v1/service';

const APP_NAME = 'abbenay';

// ── Platform-aware path helpers (mirrors daemon's paths.ts) ─────────

/**
 * Get the platform runtime directory (for ephemeral files: PID, socket, lock).
 */
function getRuntimeDir(): string {
    // 1. Respect XDG_RUNTIME_DIR (standard on Linux)
    if (process.env.XDG_RUNTIME_DIR) {
        return path.join(process.env.XDG_RUNTIME_DIR, APP_NAME);
    }

    // 2. macOS — os.tmpdir() returns DARWIN_USER_TEMP_DIR automatically
    if (process.platform === 'darwin') {
        return path.join(os.tmpdir(), APP_NAME);
    }

    // 3. Linux without XDG_RUNTIME_DIR — try /run/user/<uid>
    if (process.platform !== 'win32') {
        try {
            const uid = os.userInfo().uid;
            return path.join(`/run/user/${uid}`, APP_NAME);
        } catch {
            // os.userInfo() can fail in some sandboxes
        }
    }

    // 4. Fallback
    return path.join('/tmp', APP_NAME);
}

// Daemon paths — PID + socket in runtime dir (matches daemon's paths.ts)
const RUNTIME_DIR = getRuntimeDir();
const PID_FILE = path.join(RUNTIME_DIR, `${APP_NAME}.pid`);
const SOCKET_FILE = process.platform === 'win32'
    ? '\\\\.\\pipe\\abbenay-daemon'
    : path.join(RUNTIME_DIR, 'daemon.sock');

// gRPC address for Unix Domain Socket
const DEFAULT_DAEMON_ADDRESS = `unix://${SOCKET_FILE}`;

// Extension path for finding bundled binaries (set during activation)
let extensionPath: string | undefined;

/**
 * Set the extension path for finding bundled binaries.
 * Must be called during extension activation before connecting to daemon.
 */
export function setExtensionPath(path: string): void {
    extensionPath = path;
}

/**
 * Check if the daemon is running by verifying PID file and process
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
        
        // Also verify socket exists
        return fs.existsSync(SOCKET_FILE);
    } catch (_e) {
        // process.kill throws if process doesn't exist
        return false;
    }
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
        const running = isDaemonRunning();
        logger.info(`[Daemon] isDaemonRunning=${running}, PID_FILE=${PID_FILE}, SOCKET=${SOCKET_FILE}`);
        logger.info(`[Daemon] PID file exists: ${fs.existsSync(PID_FILE)}, Socket exists: ${fs.existsSync(SOCKET_FILE)}`);
        
        if (!running) {
            if (autoStart) {
                logger.info('[Daemon] Daemon not running, attempting to start...');
                await this.startDaemon();
                // Wait for daemon to be ready
                await this.waitForDaemon(timeout);
                logger.info('[Daemon] Daemon started and ready');
            } else {
                throw new Error(
                    `Abbenay daemon is not running. ` +
                    `Expected socket at ${SOCKET_FILE}. ` +
                    `Start the daemon with: abbenay daemon`
                );
            }
        }

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
        
        // Ensure runtime directory exists (PID + socket live here)
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
            const result = execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0];
            if (result && fs.existsSync(result)) {
                logger.info(`[Daemon] Found abbenay in PATH: ${result}`);
                return { cmd: result, args: [] };
            }
        } catch {
            logger.info('[Daemon] abbenay not found in PATH');
        }

        // 2) Bundled SEA binary — self-contained, no node dependency
        if (extensionPath) {
            const platform = process.platform === 'win32' ? 'win32' 
                : process.platform === 'darwin' ? 'darwin' : 'linux';
            const arch = process.arch;
            const seaBinary = path.join(extensionPath, 'bin', `abbenay-daemon-${platform}-${arch}`);
            if (fs.existsSync(seaBinary)) {
                logger.info(`[Daemon] Found SEA binary: ${seaBinary}`);
                return { cmd: seaBinary, args: [] };
            }
            logger.error(`[Daemon] SEA binary not found at ${seaBinary}`);
        }

        throw new Error(
            `Abbenay daemon binary not found. ` +
            `The extension package may be corrupt — try reinstalling.`
        );
    }

    /**
     * Wait for daemon to be ready
     */
    private async waitForDaemon(timeout: number): Promise<void> {
        const start = Date.now();
        const pollInterval = 100;

        while (Date.now() - start < timeout) {
            if (isDaemonRunning()) {
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
    async register(_capabilities: string[] = ['chat', 'tools']): Promise<string> {
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
                user: process.env.USER || 'unknown',
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

    // Note: Secret management (getSecret/setSecret) removed - secrets are now managed 
    // by the daemon's keychain store or environment variables, configured via the web UI

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
     * Get configuration
     */
    async getConfig(): Promise<proto.Config> {
        const client = this.getClient();
        return client.getConfig({});
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
    async registerMcpServer(serverId: string, transport: string, capabilities: string[]): Promise<void> {
        const client = this.getClient();
        await client.registerMcpServer({
            serverId,
            transport,
            capabilities,
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
 */
export async function initializeDaemon(): Promise<DaemonClient> {
    const client = getDaemonClient();
    
    await client.connect({ autoStart: true });
    await client.register();
    
    return client;
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
