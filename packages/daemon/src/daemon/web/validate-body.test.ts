/**
 * Unit tests for HTTP body validation and workspace location allowlisting.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { z } from 'zod';
import type { Response } from 'express';
import type { DaemonState } from '../state.js';
import {
  containsPathTraversal,
  checkWorkspaceLocation,
  collectAllowlistedWorkspaces,
  formatZodError,
  parseRequestBody,
  resolveConfigLocation,
  sendBadRequest,
} from './validate-body.js';
import {
  PostChatBodySchema,
  PostConfigBodySchema,
  PostOpenAIChatCompletionsBodySchema,
} from './api-schemas.js';

describe('containsPathTraversal', () => {
  it('detects .. segments on Unix and Windows separators', () => {
    expect(containsPathTraversal('../../etc/passwd')).toBe(true);
    expect(containsPathTraversal('foo/../bar')).toBe(true);
    expect(containsPathTraversal('foo\\..\\bar')).toBe(true);
  });

  it('allows paths that merely contain dots in a segment name', () => {
    expect(containsPathTraversal('/home/user/my..project')).toBe(false);
    expect(containsPathTraversal('/home/user/project')).toBe(false);
  });
});

describe('checkWorkspaceLocation', () => {
  const allowed = [path.resolve('/tmp/allowed-ws')];

  it('accepts an allowlisted absolute path', () => {
    const result = checkWorkspaceLocation('/tmp/allowed-ws', allowed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe(path.resolve('/tmp/allowed-ws'));
    }
  });

  it('rejects path traversal with 400', () => {
    const result = checkWorkspaceLocation('../../etc/passwd', allowed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/traversal/i);
    }
  });

  it('rejects paths outside the allowlist with 403', () => {
    const result = checkWorkspaceLocation('/tmp/other-ws', allowed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/allowlisted/i);
    }
  });

  it('rejects null bytes with 400', () => {
    const result = checkWorkspaceLocation('/tmp/allowed-ws\0/../etc/passwd', allowed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/null/i);
    }
  });

  it('rejects empty location with 400', () => {
    const result = checkWorkspaceLocation('', allowed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/non-empty string/i);
    }
  });
});

describe('collectAllowlistedWorkspaces', () => {
  it('collects vscode workspaces and connected client paths', () => {
    const state = {
      getVSCodeWorkspaces: () => [path.resolve('/tmp/vs-workspace')],
      getClients: () => [{
        workspacePath: path.resolve('/tmp/client-primary'),
        workspacePaths: [path.resolve('/tmp/client-extra')],
      }],
    } as unknown as DaemonState;

    const workspaces = collectAllowlistedWorkspaces(state);
    expect(workspaces).toContain(path.resolve('/tmp/vs-workspace'));
    expect(workspaces).toContain(path.resolve('/tmp/client-primary'));
    expect(workspaces).toContain(path.resolve('/tmp/client-extra'));
  });

  it('skips empty, whitespace, and null-byte paths', () => {
    const state = {
      getVSCodeWorkspaces: () => ['', '  ', '/tmp/bad\0path'],
      getClients: () => [],
    } as unknown as DaemonState;

    expect(collectAllowlistedWorkspaces(state)).toEqual([]);
  });
});

describe('resolveConfigLocation', () => {
  const workspacePath = path.resolve('/tmp/allowed-config-ws');

  function createState(): DaemonState {
    return {
      getVSCodeWorkspaces: () => [workspacePath],
      getClients: () => [],
    } as unknown as DaemonState;
  }

  it('accepts user location', () => {
    const result = resolveConfigLocation('user', createState());
    expect(result).toEqual({ ok: true, kind: 'user' });
  });

  it('accepts allowlisted workspace paths', () => {
    const result = resolveConfigLocation(workspacePath, createState());
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'workspace') {
      expect(result.resolved).toBe(workspacePath);
    }
  });

  it('rejects workspace paths outside the allowlist', () => {
    const result = resolveConfigLocation('/tmp/other-workspace', createState());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/allowlisted/i);
    }
  });
});

describe('sendBadRequest', () => {
  it('responds with 400 JSON and returns true', () => {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
      },
    };

    expect(sendBadRequest(res as Response, 'Invalid request body: model: Required')).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request body: model: Required' });
  });
});

describe('parseRequestBody', () => {
  it('parses a valid chat body', () => {
    const result = parseRequestBody(PostChatBodySchema, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects chat body with wrong types before business logic', () => {
    const result = parseRequestBody(PostChatBodySchema, {
      model: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('model');
    }
  });

  it('rejects config body with invalid schema', () => {
    const result = parseRequestBody(PostConfigBodySchema, {
      location: 'user',
      config: { providers: { x: { engine: false } } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unexpected top-level fields on config body', () => {
    const result = parseRequestBody(PostConfigBodySchema, {
      location: 'user',
      config: { providers: {} },
      extra: true,
    });
    expect(result.success).toBe(false);
  });

  it('strips unknown OpenAI client fields instead of rejecting them', () => {
    const result = parseRequestBody(PostOpenAIChatCompletionsBodySchema, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
      user: 'client-1',
      stop: ['\n'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('openai/gpt-4o');
      expect(result.data.stream).toBe(true);
      expect('stream_options' in result.data).toBe(false);
      expect('user' in result.data).toBe(false);
    }
  });

  it('keeps OpenAI tools and tool_choice for passthrough mapping', () => {
    const tools = [{ type: 'function', function: { name: 'web_search', parameters: {} } }];
    const result = parseRequestBody(PostOpenAIChatCompletionsBodySchema, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      tool_choice: 'required',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toEqual(tools);
      expect(result.data.tool_choice).toBe('required');
    }
  });
});

describe('formatZodError', () => {
  it('includes path and message', () => {
    const schema = z.object({ model: z.string() });
    const parsed = schema.safeParse({ model: 1 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = formatZodError(parsed.error);
      expect(msg).toContain('model');
      expect(msg).toMatch(/Invalid request body/);
    }
  });
});
