/**
 * E2E: self-connection guard against the daemon's own MCP HTTP endpoint.
 *
 * Starts an in-process DaemonState + embedded web server with MCP enabled,
 * then verifies registration of a self-targeting URL is rejected while a
 * non-self mock HTTP MCP URL is allowed (mocked transport connect).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-mcp-self-'));
const tmpSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-mcp-self-sess-'));

vi.mock('../../src/core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/paths.js')>();
  return {
    ...actual,
    getUserConfigPath: () => path.join(tmpConfigDir, 'config.yaml'),
    getWorkspaceConfigPath: (wsPath: string) => path.join(wsPath, '.config', 'abbenay', 'config.yaml'),
    getSessionsDir: () => tmpSessionsDir,
  };
});

vi.mock('../../src/daemon/secrets/keychain.js', () => ({
  KeychainSecretStore: class {
    async get(): Promise<string | null> { return null; }
    async set(): Promise<void> {}
    async delete(): Promise<boolean> { return false; }
    async has(): Promise<boolean> { return false; }
  },
}));

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(async () => ({
    tools: vi.fn().mockResolvedValue({}),
    listTools: vi.fn().mockResolvedValue({ tools: [{ name: 'ping', description: 'ping' }] }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: class {
    constructor(public opts: unknown) {}
  },
}));

import { DaemonState } from '../../src/daemon/state.js';
import { startEmbeddedWebServer, stopEmbeddedWebServer } from '../../src/daemon/web/server.js';
import { createMCPClient } from '@ai-sdk/mcp';

describe('MCP self-connection E2E', () => {
  let state: DaemonState;
  let webPort: number;
  let mockMcp: http.Server;
  let mockMcpPort: number;

  beforeAll(async () => {
    state = new DaemonState();

    // Ephemeral web port
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    webPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));

    const { port, app } = await startEmbeddedWebServer(state, webPort);
    expect(port).toBe(webPort);
    await state.mcpServer.start(app);

    // Separate mock "remote" MCP HTTP listener on another port
    mockMcp = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => mockMcp.listen(0, '127.0.0.1', () => resolve()));
    mockMcpPort = (mockMcp.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await state.mcpServer.stop().catch(() => {});
    await state.mcpClientPool.disconnectAll().catch(() => {});
    await stopEmbeddedWebServer();
    await new Promise<void>((resolve) => mockMcp.close(() => resolve()));
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpSessionsDir, { recursive: true, force: true });
  });

  it('rejects registration when URL points at this daemon /mcp', async () => {
    const selfUrls = [
      `http://127.0.0.1:${webPort}/mcp`,
      `http://localhost:${webPort}/mcp`,
      `http://[::1]:${webPort}/mcp`,
    ];

    for (const [i, url] of selfUrls.entries()) {
      await expect(
        state.mcpClientPool.connectDynamic(`self-${i}`, {
          transport: 'http',
          url,
          enabled: true,
        }),
      ).rejects.toThrow(/self-connection/i);
    }

    expect(createMCPClient).not.toHaveBeenCalled();
  });

  it('allows registration of a non-self remote/mock MCP URL', async () => {
    vi.mocked(createMCPClient).mockClear();

    const tools = await state.mcpClientPool.connectDynamic('mock-remote', {
      transport: 'http',
      url: `http://127.0.0.1:${mockMcpPort}/mcp`,
      enabled: true,
    });

    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(state.mcpClientPool.getStatus('mock-remote')?.connected).toBe(true);
    expect(createMCPClient).toHaveBeenCalled();
  });
});
