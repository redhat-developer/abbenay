/**
 * Unit tests for HTTP body validation and workspace location allowlisting.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { z } from 'zod';
import {
  containsPathTraversal,
  checkWorkspaceLocation,
  formatZodError,
  parseRequestBody,
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
