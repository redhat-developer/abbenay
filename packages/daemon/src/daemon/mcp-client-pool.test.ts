/**
 * McpClientPool unit tests
 *
 * Tests the pool lifecycle (connect, disconnect, reconnect, sync),
 * dynamic server registration, scope cleanup, health checks,
 * and transport/config validation — all with mocked MCP transports.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolRegistry } from '../core/tool-registry.js';

// ── Mock @ai-sdk/mcp ──────────────────────────────────────────────────────

interface MockMCPClient {
  tools: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let latestMockClient: MockMCPClient;
const mockCreateMCPClient = vi.fn().mockImplementation(async () => {
  latestMockClient = {
    tools: vi.fn().mockResolvedValue({}),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        { name: 'tool_a', description: 'Tool A', inputSchema: {} },
        { name: 'tool_b', description: 'Tool B', inputSchema: {} },
      ],
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return latestMockClient;
});

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: (...args: unknown[]) => mockCreateMCPClient(...args),
}));

const stdioTransportConstructs: unknown[] = [];

vi.mock('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: class {
    constructor(public opts: unknown) {
      stdioTransportConstructs.push(opts);
    }
  },
}));

// ── Import (after mocks) ──────────────────────────────────────────────────

import { McpClientPool, StdioSpawnApprovalDeniedError } from './mcp-client-pool.js';
import { StdioCommandDeniedError } from './stdio-command-policy.js';

// ── Test setup ────────────────────────────────────────────────────────────

let registry: ToolRegistry;
let pool: McpClientPool;

/** Allow dynamic stdio in tests that are not specifically testing the gate. */
function enableTrustedDynamicStdio(p: McpClientPool = pool): void {
  p.applySecurityConfig({
    stdio_command_allowlist: ['a', 'b', 'x', 'y', 'dyn', 'good', 'bad', 'new', 'old'],
    stdio_require_approval: true,
  });
  p.setStdioSpawnApprovalHandler(async () => 'allow');
}

beforeEach(() => {
  registry = new ToolRegistry();
  pool = new McpClientPool(registry);
  stdioTransportConstructs.length = 0;
  mockCreateMCPClient.mockReset().mockImplementation(async () => {
    latestMockClient = {
      tools: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          { name: 'tool_a', description: 'Tool A', inputSchema: {} },
          { name: 'tool_b', description: 'Tool B', inputSchema: {} },
        ],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    return latestMockClient;
  });
});

afterEach(async () => {
  pool.stopHealthCheck();
  await pool.disconnectAll();
});

// ── connect / disconnect ──────────────────────────────────────────────────

describe('connect and disconnect', () => {
  it('should connect to a stdio server and register tools', async () => {
    await pool.connect('test-server', {
      transport: 'stdio',
      command: 'echo',
      args: ['hello'],
      enabled: true,
    });

    expect(pool.connectedCount).toBe(1);
    const status = pool.getStatus('test-server');
    expect(status?.connected).toBe(true);
    expect(status?.toolCount).toBe(2);
    expect(status?.source).toBe('config');

    const tools = registry.getBySource('mcp:test-server');
    expect(tools.length).toBe(2);
  });

  it('should skip disabled servers', async () => {
    await pool.connect('disabled', {
      transport: 'stdio',
      command: 'echo',
      enabled: false,
    });
    expect(pool.connectedCount).toBe(0);
  });

  it('should disconnect and unregister tools', async () => {
    await pool.connect('srv', {
      transport: 'stdio',
      command: 'echo',
      enabled: true,
    });
    expect(pool.connectedCount).toBe(1);

    await pool.disconnect('srv');
    expect(pool.connectedCount).toBe(0);
    expect(registry.getBySource('mcp:srv').length).toBe(0);
    expect(latestMockClient.close).toHaveBeenCalled();
  });

  it('should replace existing connection on re-connect', async () => {
    await pool.connect('dup', { transport: 'stdio', command: 'a', enabled: true });
    const firstClient = latestMockClient;

    await pool.connect('dup', { transport: 'stdio', command: 'b', enabled: true });
    expect(firstClient.close).toHaveBeenCalled();
    expect(pool.connectedCount).toBe(1);
  });

  it('should throw on stdio without command', async () => {
    await expect(pool.connect('bad', {
      transport: 'stdio',
      enabled: true,
    })).rejects.toThrow('command');
  });

  it('should throw on http without url', async () => {
    await expect(pool.connect('bad', {
      transport: 'http',
      enabled: true,
    })).rejects.toThrow('url');
  });
});

// ── connectAll / disconnectAll ────────────────────────────────────────────

describe('connectAll and disconnectAll', () => {
  it('should connect to multiple servers', async () => {
    await pool.connectAll({
      a: { transport: 'stdio', command: 'a', enabled: true },
      b: { transport: 'stdio', command: 'b', enabled: true },
    });
    expect(pool.connectedCount).toBe(2);
  });

  it('should disconnect all servers', async () => {
    await pool.connectAll({
      a: { transport: 'stdio', command: 'a', enabled: true },
      b: { transport: 'stdio', command: 'b', enabled: true },
    });
    await pool.disconnectAll();
    expect(pool.connectedCount).toBe(0);
  });

  it('should continue connecting other servers if one fails', async () => {
    let callCount = 0;
    mockCreateMCPClient.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('connection refused');
      return {
        tools: vi.fn().mockResolvedValue({}),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        close: vi.fn(),
      };
    });

    await pool.connectAll({
      failing: { transport: 'stdio', command: 'bad', enabled: true },
      working: { transport: 'stdio', command: 'good', enabled: true },
    });

    expect(pool.connectedCount).toBe(1);
  });
});

// ── dynamic registration ──────────────────────────────────────────────────

describe('connectDynamic', () => {
  beforeEach(() => {
    enableTrustedDynamicStdio();
  });

  it('should register a dynamic server with scope', async () => {
    const tools = await pool.connectDynamic(
      'dyn-1',
      { transport: 'stdio', command: 'dyn', enabled: true },
      { sessionId: 'sess-1', clientId: 'cli-1' },
    );

    expect(tools.length).toBeGreaterThanOrEqual(1);
    const status = pool.getStatus('dyn-1');
    expect(status?.source).toBe('dynamic');
    expect(status?.scope?.sessionId).toBe('sess-1');
  });

  it('should reject if server_id already exists in config', async () => {
    await pool.connect('existing', { transport: 'stdio', command: 'x', enabled: true });
    await expect(
      pool.connectDynamic('existing', { transport: 'stdio', command: 'y', enabled: true }),
    ).rejects.toThrow('already defined in config');
  });

  it('should enforce max dynamic server limit', async () => {
    pool.setMaxDynamicServers(2);
    await pool.connectDynamic('d1', { transport: 'stdio', command: 'x', enabled: true });
    await pool.connectDynamic('d2', { transport: 'stdio', command: 'x', enabled: true });
    await expect(
      pool.connectDynamic('d3', { transport: 'stdio', command: 'x', enabled: true }),
    ).rejects.toThrow('limit reached');
  });

  it('should apply tool filter', async () => {
    mockCreateMCPClient.mockImplementation(async () => ({
      tools: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          { name: 'keep_me', description: 'kept' },
          { name: 'skip_me', description: 'skipped' },
        ],
      }),
      close: vi.fn(),
    }));

    const tools = await pool.connectDynamic(
      'filtered',
      { transport: 'stdio', command: 'x', enabled: true },
      undefined,
      ['keep_me'],
    );

    expect(tools.length).toBe(1);
    expect(tools[0]).toContain('keep_me');
  });
});

// ── H6: stdio allowlist + approval ────────────────────────────────────────

describe('stdio spawn policy (H6)', () => {
  it('rejects non-allowlisted command and does not spawn', async () => {
    pool.applySecurityConfig({ stdio_command_allowlist: ['npx'] });
    pool.setStdioSpawnApprovalHandler(async () => 'allow');

    await expect(
      pool.connectDynamic('evil', {
        transport: 'stdio',
        command: '/bin/sh',
        args: ['-c', 'id'],
        enabled: true,
      }),
    ).rejects.toThrow(StdioCommandDeniedError);

    expect(stdioTransportConstructs).toHaveLength(0);
    expect(mockCreateMCPClient).not.toHaveBeenCalled();
    expect(pool.getRecentDenials().some((d) => d.reason.includes('/bin/sh'))).toBe(true);
  });

  it('rejects when allowlist is empty (fail-closed)', async () => {
    pool.applySecurityConfig({ stdio_command_allowlist: [] });
    pool.setStdioSpawnApprovalHandler(async () => 'allow');

    await expect(
      pool.connectDynamic('x', { transport: 'stdio', command: 'npx', enabled: true }),
    ).rejects.toThrow(/allowlist is empty/);
    expect(stdioTransportConstructs).toHaveLength(0);
  });

  it('spawns after allowlist match + operator approval', async () => {
    pool.applySecurityConfig({ stdio_command_allowlist: ['npx'] });
    const approvals: string[] = [];
    pool.setStdioSpawnApprovalHandler(async (req) => {
      approvals.push(req.command);
      return 'allow';
    });

    await pool.connectDynamic('ok', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
      enabled: true,
    });

    expect(approvals).toEqual(['npx']);
    expect(stdioTransportConstructs).toHaveLength(1);
    expect(pool.getStatus('ok')?.connected).toBe(true);
  });

  it('does not spawn when operator denies approval', async () => {
    pool.applySecurityConfig({ stdio_command_allowlist: ['npx'] });
    pool.setStdioSpawnApprovalHandler(async () => 'deny');

    await expect(
      pool.connectDynamic('denied', { transport: 'stdio', command: 'npx', enabled: true }),
    ).rejects.toThrow(StdioSpawnApprovalDeniedError);

    expect(stdioTransportConstructs).toHaveLength(0);
    expect(pool.getRecentDenials().some((d) => d.reason.includes('denied by operator'))).toBe(true);
  });

  it('does not spawn when approval handler is missing', async () => {
    pool.applySecurityConfig({ stdio_command_allowlist: ['npx'] });
    // no setStdioSpawnApprovalHandler

    await expect(
      pool.connectDynamic('no-handler', { transport: 'stdio', command: 'npx', enabled: true }),
    ).rejects.toThrow(/no approval handler/);
    expect(stdioTransportConstructs).toHaveLength(0);
  });

  it('skips approval when stdio_require_approval is false', async () => {
    pool.applySecurityConfig({
      stdio_command_allowlist: ['npx'],
      stdio_require_approval: false,
    });

    await pool.connectDynamic('auto', { transport: 'stdio', command: 'npx', enabled: true });
    expect(stdioTransportConstructs).toHaveLength(1);
  });

  it('does not apply allowlist to config-based connect', async () => {
    pool.applySecurityConfig({ stdio_command_allowlist: [] });
    await pool.connect('cfg', { transport: 'stdio', command: '/bin/sh', enabled: true });
    expect(stdioTransportConstructs).toHaveLength(1);
  });
});

// ── scope-based cleanup ───────────────────────────────────────────────────

describe('scope-based cleanup', () => {
  beforeEach(() => {
    enableTrustedDynamicStdio();
  });

  it('should disconnect servers scoped to a session', async () => {
    await pool.connectDynamic('s1', { transport: 'stdio', command: 'x', enabled: true }, { sessionId: 'sess-A' });
    await pool.connectDynamic('s2', { transport: 'stdio', command: 'x', enabled: true }, { sessionId: 'sess-B' });
    expect(pool.connectedCount).toBe(2);

    await pool.disconnectByScope('sess-A');
    expect(pool.connectedCount).toBe(1);
    expect(pool.getStatus('s1')).toBeUndefined();
    expect(pool.getStatus('s2')?.connected).toBe(true);
  });

  it('should disconnect servers scoped to a client', async () => {
    await pool.connectDynamic('c1', { transport: 'stdio', command: 'x', enabled: true }, { clientId: 'cli-X' });
    await pool.connectDynamic('c2', { transport: 'stdio', command: 'x', enabled: true }, { clientId: 'cli-Y' });

    await pool.disconnectByClient('cli-X');
    expect(pool.connectedCount).toBe(1);
    expect(pool.getStatus('c1')).toBeUndefined();
  });
});

// ── reconnect ─────────────────────────────────────────────────────────────

describe('reconnect', () => {
  it('should reconnect a known server', async () => {
    await pool.connect('rc', { transport: 'stdio', command: 'x', enabled: true });
    await pool.disconnect('rc');
    expect(pool.connectedCount).toBe(0);

    await pool.reconnect('rc');
    expect(pool.connectedCount).toBe(1);
  });

  it('should throw for unknown server', async () => {
    await expect(pool.reconnect('unknown')).rejects.toThrow('Unknown MCP server');
  });
});

// ── syncWithConfig ────────────────────────────────────────────────────────

describe('syncWithConfig', () => {
  it('should add new servers and remove old ones', async () => {
    await pool.connect('old', { transport: 'stdio', command: 'old', enabled: true });

    await pool.syncWithConfig({
      new_srv: { transport: 'stdio', command: 'new', enabled: true },
    });

    expect(pool.getStatus('old')).toBeUndefined();
    expect(pool.getStatus('new_srv')?.connected).toBe(true);
  });

  it('should not remove dynamic servers during sync', async () => {
    enableTrustedDynamicStdio();
    await pool.connectDynamic('dyn', { transport: 'stdio', command: 'x', enabled: true });
    await pool.syncWithConfig({});
    expect(pool.getStatus('dyn')?.connected).toBe(true);
  });
});

// ── getStatuses ───────────────────────────────────────────────────────────

describe('getStatuses', () => {
  it('should return all server statuses', async () => {
    await pool.connect('a', { transport: 'stdio', command: 'a', enabled: true });
    await pool.connect('b', { transport: 'stdio', command: 'b', enabled: true });

    const statuses = pool.getStatuses();
    expect(statuses.length).toBe(2);
    expect(statuses.every(s => s.connected)).toBe(true);
  });
});

// ── health check ──────────────────────────────────────────────────────────

describe('runHealthCheck', () => {
  beforeEach(() => {
    enableTrustedDynamicStdio();
  });

  it('should remove unreachable dynamic servers', async () => {
    const clients: MockMCPClient[] = [];
    mockCreateMCPClient.mockImplementation(async () => {
      const c: MockMCPClient = {
        tools: vi.fn().mockResolvedValue({}),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        close: vi.fn(),
      };
      clients.push(c);
      return c;
    });

    await pool.connectDynamic('healthy', { transport: 'stdio', command: 'x', enabled: true });
    await pool.connectDynamic('dead', { transport: 'stdio', command: 'x', enabled: true });

    // Make the second client's listTools fail (simulating dead connection)
    clients[1].listTools.mockRejectedValue(new Error('connection refused'));

    await pool.runHealthCheck();

    expect(pool.getStatus('dead')).toBeUndefined();
    expect(pool.getStatus('healthy')?.connected).toBe(true);
  });

  it('should stop health check timer when no dynamic servers remain', async () => {
    vi.useFakeTimers();
    try {
      await pool.connectDynamic('tmp', { transport: 'stdio', command: 'x', enabled: true });
      await pool.disconnect('tmp');

      await pool.runHealthCheck();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── callTool ──────────────────────────────────────────────────────────────

describe('callTool', () => {
  it('should call a tool on a connected server', async () => {
    const mockExecute = vi.fn().mockResolvedValue({ result: 'ok' });
    mockCreateMCPClient.mockImplementation(async () => ({
      tools: vi.fn().mockResolvedValue({
        my_tool: { execute: mockExecute },
      }),
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: 'my_tool' }] }),
      close: vi.fn(),
    }));

    await pool.connect('tool-srv', { transport: 'stdio', command: 'x', enabled: true });
    const result = await pool.callTool('mcp:tool-srv', 'my_tool', { arg: 1 });
    expect(result).toEqual({ result: 'ok' });
    expect(mockExecute).toHaveBeenCalledWith({ arg: 1 });
  });

  it('should throw for disconnected server', async () => {
    await expect(pool.callTool('mcp:missing', 'tool', {})).rejects.toThrow('not connected');
  });

  it('should throw for missing tool', async () => {
    mockCreateMCPClient.mockImplementation(async () => ({
      tools: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      close: vi.fn(),
    }));

    await pool.connect('empty', { transport: 'stdio', command: 'x', enabled: true });
    await expect(pool.callTool('mcp:empty', 'missing', {})).rejects.toThrow('not found');
  });
});
