/**
 * AbbenayMcpServer unit tests
 *
 * - tool_policy enforcement on MCP execution
 * - HTTP /mcp route lifecycle
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Express, Request, Response } from 'express';
import { ToolRegistry } from '../core/tool-registry.js';
import { ToolRouter } from './tool-router.js';
import { AbbenayMcpServer } from './mcp-server.js';

vi.mock('../core/config.js', () => ({
  loadConfig: vi.fn(() => ({ tool_policy: {} })),
}));

describe('AbbenayMcpServer authorizeAndExecute', () => {
  let registry: ToolRegistry;
  let router: ToolRouter;
  let server: AbbenayMcpServer;
  let executor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    executor = vi.fn().mockResolvedValue({ ok: true });
    registry.register('agent', 'local', [
      {
        name: 'echo',
        description: 'Echo tool',
        inputSchema: JSON.stringify({ type: 'object', properties: {} }),
        executor,
      },
      {
        name: 'danger',
        description: 'Dangerous tool',
        inputSchema: JSON.stringify({ type: 'object', properties: {} }),
        executor,
      },
    ]);
    router = new ToolRouter();
    server = new AbbenayMcpServer(registry, router);
  });

  function tool(name: string) {
    const t = registry.resolve(name);
    if (!t) throw new Error(`missing tool ${name}`);
    return t;
  }

  it('rejects disabled_tools without executing', async () => {
    server.configure({
      getPolicy: () => ({ disabled_tools: ['local:agent/danger'] }),
      onApprovalNeeded: vi.fn().mockResolvedValue('allow'),
    });

    const result = await server.authorizeAndExecute(tool('danger'), { x: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disabled/);
    expect(executor).not.toHaveBeenCalled();
  });

  it('runs auto_approve tools without asking', async () => {
    const onApproval = vi.fn().mockResolvedValue('allow');
    server.configure({
      getPolicy: () => ({ auto_approve: ['local:agent/echo'] }),
      onApprovalNeeded: onApproval,
    });

    const result = await server.authorizeAndExecute(tool('echo'), { msg: 'hi' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('ok');
    expect(onApproval).not.toHaveBeenCalled();
    expect(executor).toHaveBeenCalledWith({ msg: 'hi' });
  });

  it('blocks require_approval until callback allows', async () => {
    let resolveApproval!: (d: 'allow' | 'deny' | 'abort') => void;
    const approvalPromise = new Promise<'allow' | 'deny' | 'abort'>((r) => {
      resolveApproval = r;
    });
    const onApproval = vi.fn().mockReturnValue(approvalPromise);

    server.configure({
      getPolicy: () => ({
        auto_approve: ['local:agent/*'],
        require_approval: ['local:agent/danger'],
      }),
      onApprovalNeeded: onApproval,
    });

    const execPromise = server.authorizeAndExecute(tool('danger'), {});
    // Not executed yet
    await Promise.resolve();
    expect(executor).not.toHaveBeenCalled();
    expect(onApproval).toHaveBeenCalled();

    resolveApproval('allow');
    const result = await execPromise;
    expect(result.isError).toBeUndefined();
    expect(executor).toHaveBeenCalled();
  });

  it('does not run when require_approval is denied', async () => {
    server.configure({
      getPolicy: () => ({ require_approval: ['local:agent/echo'] }),
      onApprovalNeeded: vi.fn().mockResolvedValue('deny'),
    });

    const result = await server.authorizeAndExecute(tool('echo'), {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/denied/);
    expect(executor).not.toHaveBeenCalled();
  });

  it('default-ask denies when no approval handler (fail-closed)', async () => {
    server.configure({
      getPolicy: () => ({}),
    });

    const result = await server.authorizeAndExecute(tool('echo'), {});
    expect(result.isError).toBe(true);
    expect(executor).not.toHaveBeenCalled();
  });

  it('auto_approve only when policy allows — unmatched tools still ask', async () => {
    const onApproval = vi.fn().mockResolvedValue('deny');
    server.configure({
      getPolicy: () => ({ auto_approve: ['local:agent/echo'] }),
      onApprovalNeeded: onApproval,
    });

    const denied = await server.authorizeAndExecute(tool('danger'), {});
    expect(denied.isError).toBe(true);
    expect(onApproval).toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  describe('connection consent helpers', () => {
    it('rememberClient / forgetClient manage the allowlist', () => {
      server.rememberClient('claude-desktop');
      expect(server.listRememberedClients()).toContain('claude-desktop');
      server.forgetClient('claude-desktop');
      expect(server.listRememberedClients()).not.toContain('claude-desktop');
    });

    it('refuses to remember unknown-client or empty names', () => {
      server.rememberClient('unknown-client');
      server.rememberClient('');
      server.rememberClient('   ');
      expect(server.listRememberedClients()).toEqual([]);
    });
  });
});

describe('AbbenayMcpServer lifecycle', () => {
  let registry: ToolRegistry;
  let server: AbbenayMcpServer;
  let app: Express;
  const routes: Record<string, Record<string, (req: Request, res: Response) => void>> = {};

  beforeEach(() => {
    routes.post = {};
    routes.get = {};
    routes.delete = {};
    app = {
      post: vi.fn((path: string, handler: (req: Request, res: Response) => void) => {
        routes.post[path] = handler;
      }),
      get: vi.fn((path: string, handler: (req: Request, res: Response) => void) => {
        routes.get[path] = handler;
      }),
      delete: vi.fn((path: string, handler: (req: Request, res: Response) => void) => {
        routes.delete[path] = handler;
      }),
    } as unknown as Express;

    registry = new ToolRegistry();
    registry.register('agent', 'local', [{
      name: 'echo',
      description: 'echo',
      inputSchema: JSON.stringify({
        type: 'object',
        properties: { msg: { type: 'string' }, count: { type: 'integer' }, ok: { type: 'boolean' } },
        required: ['msg'],
      }),
      executor: vi.fn().mockResolvedValue('ok'),
    }]);
    server = new AbbenayMcpServer(registry, new ToolRouter());
  });

  function mockRes(): Response {
    const res = {
      headersSent: false,
      statusCode: 200,
      status: vi.fn(function (this: Response, code: number) {
        this.statusCode = code;
        return this;
      }),
      json: vi.fn(),
    };
    return res as unknown as Response;
  }

  it('start mounts /mcp routes once', async () => {
    await server.start(app);
    expect(app.post).toHaveBeenCalledWith('/mcp', expect.any(Function));
    expect(server.isRunning).toBe(true);
    await server.start(app);
    expect(app.post).toHaveBeenCalledTimes(1);
  });

  it('refreshTools is no-op when not running', () => {
    server.refreshTools();
    expect(server.listSessions()).toEqual([]);
  });

  it('stop is no-op when not running', async () => {
    await server.stop();
    expect(server.isRunning).toBe(false);
  });

  it('revokeSession returns false for unknown session', async () => {
    expect(await server.revokeSession('missing')).toBe(false);
  });

  it('rejects non-initialize requests without session', async () => {
    await server.start(app);
    const req = { method: 'POST', headers: {}, body: { method: 'tools/list' } } as Request;
    const res = mockRes();
    await routes.post['/mcp'](req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('denies initialize when consent handler rejects', async () => {
    server.configure({
      onConnectionConsentNeeded: vi.fn().mockResolvedValue('deny'),
    });
    await server.start(app);
    const req = {
      method: 'POST',
      headers: {},
      body: {
        method: 'initialize',
        params: { clientInfo: { name: 'test-client', version: '1.0.0' } },
      },
    } as Request;
    const res = mockRes();
    await routes.post['/mcp'](req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('authorizeAndExecute uses fallback executor when tool has no executor', async () => {
    registry.register('remote', 'mcp', [{
      name: 'remoteTool',
      description: 'remote',
      inputSchema: JSON.stringify({ type: 'object', properties: {} }),
    }]);
    const router = new ToolRouter();
    router.setMcpCaller(async () => ({ done: true }));
    const srv = new AbbenayMcpServer(registry, router);
    const tool = registry.resolve('remoteTool');
    srv.configure({
      getPolicy: () => ({ auto_approve: ['mcp:remote/*'] }),
    });
    const result = await srv.authorizeAndExecute(tool!, {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('done');
  });

  it('authorizeAndExecute returns error content on executor failure', async () => {
    registry.register('agent', 'local', [{
      name: 'boom',
      description: 'boom',
      inputSchema: JSON.stringify({ type: 'object', properties: {} }),
      executor: vi.fn().mockRejectedValue(new Error('boom')),
    }]);
    const tool = registry.resolve('boom');
    server.configure({ getPolicy: () => ({ auto_approve: ['local:agent/*'] }) });
    const result = await server.authorizeAndExecute(tool!, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('boom');
  });
});
