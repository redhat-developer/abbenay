/**
 * Unit tests for HTTP API Zod request-body schemas.
 */

import { describe, it, expect } from 'vitest';
import {
  EmptyBodySchema,
  LoginBodySchema,
  PostChatApproveBodySchema,
  PostChatBodySchema,
  PostConfigBodySchema,
  PostMcpApprovalBodySchema,
  PostMcpConnectionDecisionBodySchema,
  PostMcpStdioSpawnDecisionBodySchema,
  PostOpenAIChatCompletionsBodySchema,
  PostPolicyBodySchema,
  PostProviderConfigureBodySchema,
  PostSecretBodySchema,
  PostSecretByKeyBodySchema,
  PostSessionBodySchema,
  PostSessionChatBodySchema,
  DiscoverModelsBodySchema,
} from './api-schemas.js';

describe('EmptyBodySchema', () => {
  it('accepts undefined, null, and empty object', () => {
    expect(EmptyBodySchema.safeParse(undefined).success).toBe(true);
    expect(EmptyBodySchema.safeParse(null).success).toBe(true);
    expect(EmptyBodySchema.safeParse({}).success).toBe(true);
  });

  it('rejects unexpected fields', () => {
    expect(EmptyBodySchema.safeParse({ extra: true }).success).toBe(false);
  });
});

describe('LoginBodySchema', () => {
  it('accepts token or api_token', () => {
    expect(LoginBodySchema.safeParse({ token: 'secret' }).success).toBe(true);
    expect(LoginBodySchema.safeParse({ api_token: 'secret' }).success).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(LoginBodySchema.safeParse({ token: 'x', password: 'y' }).success).toBe(false);
  });
});

describe('PostProviderConfigureBodySchema', () => {
  it('requires workspacePath when target is workspace', () => {
    const result = PostProviderConfigureBodySchema.safeParse({
      target: 'workspace',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('workspacePath'))).toBe(true);
    }
  });

  it('accepts workspace target with workspacePath', () => {
    const result = PostProviderConfigureBodySchema.safeParse({
      target: 'workspace',
      workspacePath: '/tmp/ws',
      engine: 'openai',
    });
    expect(result.success).toBe(true);
  });

  it('accepts apiKeyKeychainName to pick an existing secret', () => {
    expect(
      PostProviderConfigureBodySchema.safeParse({
        engine: 'openai',
        apiKeyKeychainName: 'SHARED_OPENAI',
      }).success,
    ).toBe(true);
  });

  it('rejects apiKeyKeychainName together with envVarName', () => {
    expect(
      PostProviderConfigureBodySchema.safeParse({
        engine: 'openai',
        apiKeyKeychainName: 'SHARED',
        envVarName: 'OPENAI_API_KEY',
      }).success,
    ).toBe(false);
  });
});

describe('PostPolicyBodySchema', () => {
  it('requires a valid virtual name and policy config', () => {
    expect(
      PostPolicyBodySchema.safeParse({
        name: 'my-policy',
        config: { tool: { tool_mode: 'auto' } },
      }).success,
    ).toBe(true);
    expect(PostPolicyBodySchema.safeParse({ name: '', config: {} }).success).toBe(false);
  });
});

describe('PostSessionBodySchema', () => {
  it('requires model and allows optional metadata', () => {
    const ok = PostSessionBodySchema.safeParse({
      model: 'openai/gpt-4o',
      title: 'Test',
      metadata: { source: 'dashboard' },
    });
    expect(ok.success).toBe(true);
    expect(PostSessionBodySchema.safeParse({ title: 'no model' }).success).toBe(false);
  });
});

describe('PostSessionChatBodySchema', () => {
  it('requires message content', () => {
    expect(
      PostSessionChatBodySchema.safeParse({ message: { content: 'hello' } }).success,
    ).toBe(true);
    expect(
      PostSessionChatBodySchema.safeParse({ message: { content: '' } }).success,
    ).toBe(false);
  });
});

describe('PostChatApproveBodySchema', () => {
  it('accepts allow, deny, and abort decisions', () => {
    for (const decision of ['allow', 'deny', 'abort'] as const) {
      expect(
        PostChatApproveBodySchema.safeParse({ requestId: 'req-1', decision }).success,
      ).toBe(true);
    }
    expect(
      PostChatApproveBodySchema.safeParse({ requestId: 'req-1', decision: 'maybe' }).success,
    ).toBe(false);
  });
});

describe('secret body schemas', () => {
  it('PostSecretBodySchema requires key and value', () => {
    expect(PostSecretBodySchema.safeParse({ key: 'OPENAI_API_KEY', value: 'sk-x' }).success).toBe(true);
    expect(PostSecretBodySchema.safeParse({ key: '', value: 'x' }).success).toBe(false);
  });

  it('PostSecretByKeyBodySchema requires non-empty value', () => {
    expect(PostSecretByKeyBodySchema.safeParse({ value: 'secret' }).success).toBe(true);
    expect(PostSecretByKeyBodySchema.safeParse({ value: '' }).success).toBe(false);
  });

  it('accepts optional store memory|keychain|env', () => {
    expect(
      PostSecretBodySchema.safeParse({ key: 'K', value: 'v', store: 'memory' }).success,
    ).toBe(true);
    expect(
      PostSecretByKeyBodySchema.safeParse({ value: 'v', store: 'keychain' }).success,
    ).toBe(true);
    expect(
      PostSecretBodySchema.safeParse({ key: 'K', value: 'v', store: 'env' }).success,
    ).toBe(true);
    expect(
      PostSecretBodySchema.safeParse({ key: 'K', value: 'v', store: 'vault' }).success,
    ).toBe(false);
  });
});

describe('MCP decision schemas', () => {
  it('PostMcpConnectionDecisionBodySchema accepts allow/deny with optional remember', () => {
    expect(
      PostMcpConnectionDecisionBodySchema.safeParse({ decision: 'allow', remember: true }).success,
    ).toBe(true);
    expect(PostMcpConnectionDecisionBodySchema.safeParse({ decision: 'nope' }).success).toBe(false);
  });

  it('PostMcpApprovalBodySchema accepts allow, deny, abort', () => {
    expect(PostMcpApprovalBodySchema.safeParse({ decision: 'abort' }).success).toBe(true);
  });

  it('PostMcpStdioSpawnDecisionBodySchema accepts allow and deny only', () => {
    expect(PostMcpStdioSpawnDecisionBodySchema.safeParse({ decision: 'allow' }).success).toBe(true);
    expect(PostMcpStdioSpawnDecisionBodySchema.safeParse({ decision: 'abort' }).success).toBe(false);
  });
});

describe('PostConfigBodySchema', () => {
  it('accepts user location with valid config', () => {
    const result = PostConfigBodySchema.safeParse({
      location: 'user',
      config: { providers: {} },
    });
    expect(result.success).toBe(true);
  });

  it('allows omitted optional location (route handler defaults to user)', () => {
    const result = PostConfigBodySchema.safeParse({
      config: { providers: {} },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.location).toBeUndefined();
    }
  });

  it('rejects invalid provider engine types', () => {
    const result = PostConfigBodySchema.safeParse({
      location: 'user',
      config: { providers: { bad: { engine: 1 } } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unexpected top-level fields', () => {
    expect(
      PostConfigBodySchema.safeParse({
        location: 'user',
        config: { providers: {} },
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe('PostChatBodySchema', () => {
  it('accepts optional generation and tool fields', () => {
    const result = PostChatBodySchema.safeParse({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 128,
      tools: [{ name: 'echo', description: 'echo', input_schema: {} }],
      tool_mode: 'auto',
    });
    expect(result.success).toBe(true);
  });

  it('requires at least one message', () => {
    expect(
      PostChatBodySchema.safeParse({
        model: 'openai/gpt-4o',
        messages: [],
      }).success,
    ).toBe(false);
  });

  it('rejects invalid tool_mode values', () => {
    expect(
      PostChatBodySchema.safeParse({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        tool_mode: 'forced',
      }).success,
    ).toBe(false);
  });
});

describe('PostOpenAIChatCompletionsBodySchema', () => {
  it('accepts max_completion_tokens alias', () => {
    const result = PostOpenAIChatCompletionsBodySchema.safeParse({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_completion_tokens: 256,
      stream: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_completion_tokens).toBe(256);
    }
  });

  it('strips unknown OpenAI client fields', () => {
    const result = PostOpenAIChatCompletionsBodySchema.safeParse({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      user: 'client-1',
      stop: ['\n'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('user' in result.data).toBe(false);
      expect('stop' in result.data).toBe(false);
    }
  });
});

describe('DiscoverModelsBodySchema', () => {
  it('accepts optional apiKey, baseUrl, and providerId', () => {
    const result = DiscoverModelsBodySchema.safeParse({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      providerId: 'openai',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(DiscoverModelsBodySchema.safeParse({ apiKey: 'x', query: 'bad' }).success).toBe(false);
  });
});
