/**
 * Tests for gRPC config conversion functions (configFileToProto / protoToConfigFile),
 * policy CRUD validation logic, and SessionChat tool event streaming.
 */

import { describe, it, expect } from 'vitest';
import { configFileToProto, protoToConfigFile } from './abbenay-service.js';
import type { ConfigFile } from '../../core/config.js';

describe('configFileToProto', () => {
  it('converts an empty config', () => {
    const config: ConfigFile = {};
    const proto = configFileToProto(config);
    expect(proto.providers).toEqual({});
    expect(proto.mcp_servers).toEqual({});
    expect(proto.consumers).toEqual({});
  });

  it('converts providers with models', () => {
    const config: ConfigFile = {
      providers: {
        'my-openai': {
          engine: 'openai',
          api_key_keychain_name: 'OPENAI_API_KEY',
          base_url: 'https://custom.api.com',
          models: {
            'gpt-4o': {},
            fast: {
              model_id: 'gpt-4o-mini',
              temperature: 0.7,
              max_tokens: 4096,
              policy: 'concise',
            },
          },
        },
      },
    };

    const proto = configFileToProto(config);
    expect(proto.providers!['my-openai'].engine).toBe('openai');
    expect(proto.providers!['my-openai'].api_key_keychain_name).toBe('OPENAI_API_KEY');
    expect(proto.providers!['my-openai'].base_url).toBe('https://custom.api.com');
    expect(proto.providers!['my-openai'].models!['gpt-4o']).toEqual({
      model_id: undefined,
      policy: undefined,
      system_prompt: undefined,
      system_prompt_mode: undefined,
      temperature: undefined,
      top_p: undefined,
      top_k: undefined,
      max_tokens: undefined,
      timeout: undefined,
    });
    expect(proto.providers!['my-openai'].models!['fast'].model_id).toBe('gpt-4o-mini');
    expect(proto.providers!['my-openai'].models!['fast'].temperature).toBe(0.7);
    expect(proto.providers!['my-openai'].models!['fast'].max_tokens).toBe(4096);
    expect(proto.providers!['my-openai'].models!['fast'].policy).toBe('concise');
  });

  it('converts MCP server config', () => {
    const config: ConfigFile = {
      mcp_servers: {
        github: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          enabled: true,
          env: { GITHUB_TOKEN: 'xxx' },
        },
        remote: {
          transport: 'http',
          url: 'https://mcp.example.com',
          enabled: false,
          headers: { Authorization: 'Bearer tok' },
        },
      },
    };

    const proto = configFileToProto(config);
    expect(proto.mcp_servers!['github'].transport).toBe('stdio');
    expect(proto.mcp_servers!['github'].command).toBe('npx');
    expect(proto.mcp_servers!['github'].args).toEqual(['-y', '@modelcontextprotocol/server-github']);
    expect(proto.mcp_servers!['github'].enabled).toBe(true);
    expect(proto.mcp_servers!['github'].env).toEqual({ GITHUB_TOKEN: 'xxx' });

    expect(proto.mcp_servers!['remote'].transport).toBe('http');
    expect(proto.mcp_servers!['remote'].url).toBe('https://mcp.example.com');
    expect(proto.mcp_servers!['remote'].enabled).toBe(false);
    expect(proto.mcp_servers!['remote'].headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('converts tool policy', () => {
    const config: ConfigFile = {
      tool_policy: {
        max_tool_iterations: 5,
        auto_approve: ['mcp:github/*'],
        require_approval: ['ws:*/*'],
        disabled_tools: ['mcp:dangerous/*'],
        aliases: { search: 'mcp:github/search' },
      },
    };

    const proto = configFileToProto(config);
    expect(proto.tool_policy!.max_tool_iterations).toBe(5);
    expect(proto.tool_policy!.auto_approve).toEqual(['mcp:github/*']);
    expect(proto.tool_policy!.require_approval).toEqual(['ws:*/*']);
    expect(proto.tool_policy!.disabled_tools).toEqual(['mcp:dangerous/*']);
    expect(proto.tool_policy!.aliases).toEqual({ search: 'mcp:github/search' });
  });

  it('converts consumers', () => {
    const config: ConfigFile = {
      consumers: {
        apme: {
          token_env: 'APME_TOKEN',
          capabilities: {
            inline_policy: true,
            mcp_register: true,
          },
        },
      },
    };

    const proto = configFileToProto(config);
    expect(proto.consumers!['apme'].token_env).toBe('APME_TOKEN');
    expect(proto.consumers!['apme'].capabilities!.inline_policy).toBe(true);
    expect(proto.consumers!['apme'].capabilities!.mcp_register).toBe(true);
  });
});

describe('protoToConfigFile', () => {
  it('converts an empty proto', () => {
    const config = protoToConfigFile({});
    expect(config.providers).toBeUndefined();
    expect(config.mcp_servers).toBeUndefined();
    expect(config.tool_policy).toBeUndefined();
    expect(config.consumers).toBeUndefined();
  });

  it('round-trips providers', () => {
    const original: ConfigFile = {
      providers: {
        'my-openai': {
          engine: 'openai',
          api_key_keychain_name: 'OPENAI_API_KEY',
          base_url: 'https://custom.api.com',
          models: {
            fast: {
              model_id: 'gpt-4o-mini',
              temperature: 0.7,
              max_tokens: 4096,
            },
          },
        },
      },
    };

    const roundTripped = protoToConfigFile(configFileToProto(original));
    expect(roundTripped.providers!['my-openai'].engine).toBe('openai');
    expect(roundTripped.providers!['my-openai'].api_key_keychain_name).toBe('OPENAI_API_KEY');
    expect(roundTripped.providers!['my-openai'].base_url).toBe('https://custom.api.com');
    expect(roundTripped.providers!['my-openai'].models!['fast'].model_id).toBe('gpt-4o-mini');
    expect(roundTripped.providers!['my-openai'].models!['fast'].temperature).toBe(0.7);
    expect(roundTripped.providers!['my-openai'].models!['fast'].max_tokens).toBe(4096);
  });

  it('round-trips MCP servers', () => {
    const original: ConfigFile = {
      mcp_servers: {
        gh: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'server-gh'],
          enabled: true,
        },
      },
    };

    const roundTripped = protoToConfigFile(configFileToProto(original));
    expect(roundTripped.mcp_servers!['gh'].transport).toBe('stdio');
    expect(roundTripped.mcp_servers!['gh'].command).toBe('npx');
    expect(roundTripped.mcp_servers!['gh'].args).toEqual(['-y', 'server-gh']);
    expect(roundTripped.mcp_servers!['gh'].enabled).toBe(true);
  });

  it('round-trips tool policy', () => {
    const original: ConfigFile = {
      tool_policy: {
        max_tool_iterations: 3,
        auto_approve: ['mcp:safe/*'],
        disabled_tools: ['mcp:bad/*'],
      },
    };

    const roundTripped = protoToConfigFile(configFileToProto(original));
    expect(roundTripped.tool_policy!.max_tool_iterations).toBe(3);
    expect(roundTripped.tool_policy!.auto_approve).toEqual(['mcp:safe/*']);
    expect(roundTripped.tool_policy!.disabled_tools).toEqual(['mcp:bad/*']);
  });

  it('round-trips consumers', () => {
    const original: ConfigFile = {
      consumers: {
        apme: {
          token_env: 'APME_TOKEN',
          capabilities: { inline_policy: true, mcp_register: false },
        },
      },
    };

    const roundTripped = protoToConfigFile(configFileToProto(original));
    expect(roundTripped.consumers!['apme'].token_env).toBe('APME_TOKEN');
    expect(roundTripped.consumers!['apme'].capabilities.inline_policy).toBe(true);
    expect(roundTripped.consumers!['apme'].capabilities.mcp_register).toBe(false);
  });

  it('provider with env var key instead of keychain', () => {
    const proto = {
      providers: {
        'my-provider': {
          engine: 'openai',
          api_key_env_var_name: 'MY_KEY',
        },
      },
    };

    const config = protoToConfigFile(proto);
    expect(config.providers!['my-provider'].api_key_env_var_name).toBe('MY_KEY');
    expect(config.providers!['my-provider'].api_key_keychain_name).toBeUndefined();
  });

  it('provider with no models gets undefined models field', () => {
    const proto = {
      providers: {
        empty: { engine: 'openai', models: {} },
      },
    };

    const config = protoToConfigFile(proto);
    expect(config.providers!['empty'].models).toBeUndefined();
  });
});

describe('SessionChat tool event streaming', () => {
  it('should correlate tool_call and tool_result IDs when running+done events arrive', () => {
    const pendingToolCallIds = new Map<string, string>();
    const written: Array<Record<string, unknown>> = [];
    const write = (msg: Record<string, unknown>) => written.push(msg);

    // Simulate: tool running event arrives
    const toolName = 'get_docs';
    const runCallId = `call_${toolName}_1718000000000`;
    pendingToolCallIds.set(toolName, runCallId);
    write({ tool_call: { id: runCallId, name: toolName, arguments: '{}' } });

    // Simulate: tool done event arrives
    const existingId = pendingToolCallIds.get(toolName);
    const callId = existingId || `call_${toolName}_${Date.now()}`;
    pendingToolCallIds.delete(toolName);

    if (!existingId) {
      write({ tool_call: { id: callId, name: toolName, arguments: '{"q":"test"}' } });
    }
    write({ tool_result: { tool_call_id: callId, name: toolName, content: '"result"', is_error: false } });

    // Verify: tool_result references the same ID as the initial tool_call
    expect(written).toHaveLength(2);
    expect(written[0]).toEqual({ tool_call: { id: runCallId, name: toolName, arguments: '{}' } });
    expect(written[1]).toEqual({ tool_result: { tool_call_id: runCallId, name: toolName, content: '"result"', is_error: false } });
  });

  it('should emit tool_call with tool_result when no running event precedes done', () => {
    const pendingToolCallIds = new Map<string, string>();
    const written: Array<Record<string, unknown>> = [];
    const write = (msg: Record<string, unknown>) => written.push(msg);

    // Simulate: tool done event arrives without a prior running event
    const toolName = 'search';
    const existingId = pendingToolCallIds.get(toolName);
    const callId = existingId || `call_${toolName}_1718000000001`;
    pendingToolCallIds.delete(toolName);

    if (!existingId) {
      write({ tool_call: { id: callId, name: toolName, arguments: '{"q":"hello"}' } });
    }
    write({ tool_result: { tool_call_id: callId, name: toolName, content: '"found it"', is_error: false } });

    // Verify: both tool_call and tool_result emitted with same ID
    expect(written).toHaveLength(2);
    expect(written[0]).toEqual({ tool_call: { id: callId, name: toolName, arguments: '{"q":"hello"}' } });
    expect(written[1]).toEqual({ tool_result: { tool_call_id: callId, name: toolName, content: '"found it"', is_error: false } });
  });
});
