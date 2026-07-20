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

vi.mock('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: class {
    constructor(public opts: unknown) {}
  },
}));

// ── Import (after mocks) ──────────────────────────────────────────────────

import { McpClientPool, isSelfConnectionUrl, normalizeHost } from './mcp-client-pool.js';
import * as os from 'node:os';

// ── Test setup ────────────────────────────────────────────────────────────

let registry: ToolRegistry;
let pool: McpClientPool;

beforeEach(() => {
  registry = new ToolRegistry();
  pool = new McpClientPool(registry);
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

// ── scope-based cleanup ───────────────────────────────────────────────────

describe('scope-based cleanup', () => {
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

// ── self-connection guard ─────────────────────────────────────────────────

describe('isSelfConnectionUrl', () => {
  const endpoints = { httpPorts: [8787], grpcPorts: [50051] };

  it('detects localhost / 127.0.0.1 / IPv6 loopback on HTTP port', () => {
    expect(isSelfConnectionUrl('http://localhost:8787/mcp', endpoints)).toBe(true);
    expect(isSelfConnectionUrl('http://127.0.0.1:8787/mcp', endpoints)).toBe(true);
    expect(isSelfConnectionUrl('http://[::1]:8787/mcp', endpoints)).toBe(true);
    expect(isSelfConnectionUrl('HTTP://LocalHost:8787/MCP', endpoints)).toBe(true);
  });

  it('detects self on gRPC listen port', () => {
    expect(isSelfConnectionUrl('http://127.0.0.1:50051/', endpoints)).toBe(true);
  });

  it('detects machine hostname when port matches', () => {
    const host = normalizeHost(os.hostname());
    expect(isSelfConnectionUrl(`http://${host}:8787/mcp`, endpoints)).toBe(true);
  });

  it('allows remote hosts even when port number matches', () => {
    expect(isSelfConnectionUrl('http://mcp.example.com:8787/mcp', endpoints)).toBe(false);
    expect(isSelfConnectionUrl('https://remote.example.org/mcp', endpoints)).toBe(false);
  });

  it('allows localhost on a different port', () => {
    expect(isSelfConnectionUrl('http://127.0.0.1:3001/sse', endpoints)).toBe(false);
    expect(isSelfConnectionUrl('http://localhost:9999/mcp', endpoints)).toBe(false);
  });

  it('returns false when no listen ports are configured', () => {
    expect(isSelfConnectionUrl('http://127.0.0.1:8787/mcp', {
      httpPorts: [],
      grpcPorts: [],
    })).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isSelfConnectionUrl('not-a-url', endpoints)).toBe(false);
  });
});

describe('self-connection rejection', () => {
  beforeEach(() => {
    pool.setListenEndpoints({ httpPorts: [8787], grpcPorts: [] });
  });

  it('rejects config connect to own /mcp (cannot remain a no-op)', async () => {
    await expect(pool.connect('self', {
      transport: 'http',
      url: 'http://127.0.0.1:8787/mcp',
      enabled: true,
    })).rejects.toThrow(/self-connection/i);

    expect(pool.connectedCount).toBe(0);
    expect(mockCreateMCPClient).not.toHaveBeenCalled();
  });

  it('rejects all localhost URL variants for dynamic registration', async () => {
    const variants = [
      'http://localhost:8787/mcp',
      'http://127.0.0.1:8787/mcp',
      'http://[::1]:8787/mcp',
      `http://${normalizeHost(os.hostname())}:8787/mcp`,
    ];

    for (const [i, url] of variants.entries()) {
      await expect(pool.connectDynamic(`self-${i}`, {
        transport: 'http',
        url,
        enabled: true,
      })).rejects.toThrow(/self-connection/i);
    }

    expect(mockCreateMCPClient).not.toHaveBeenCalled();
  });

  it('rejects SSE transport self-connections', async () => {
    await expect(pool.connectDynamic('self-sse', {
      transport: 'sse',
      url: 'http://localhost:8787/sse',
      enabled: true,
    })).rejects.toThrow(/self-connection/i);
  });

  it('allows non-self remote HTTP MCP URLs', async () => {
    await pool.connectDynamic('remote', {
      transport: 'http',
      url: 'http://mcp.example.com:443/mcp',
      enabled: true,
    });

    expect(pool.getStatus('remote')?.connected).toBe(true);
    expect(mockCreateMCPClient).toHaveBeenCalled();
  });

  it('allows localhost MCP on a different port', async () => {
    await pool.connect('other-local', {
      transport: 'http',
      url: 'http://127.0.0.1:3001/sse',
      enabled: true,
    });

    expect(pool.getStatus('other-local')?.connected).toBe(true);
  });

  it('skips self URLs during connectAll without aborting other servers', async () => {
    await pool.connectAll({
      self: { transport: 'http', url: 'http://localhost:8787/mcp', enabled: true },
      ok: { transport: 'stdio', command: 'ok', enabled: true },
    });

    expect(pool.getStatus('self')?.connected).not.toBe(true);
    expect(pool.getStatus('ok')?.connected).toBe(true);
  });
});
