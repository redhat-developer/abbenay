/**
 * Tests for gRPC config conversion functions (configFileToProto / protoToConfigFile),
 * policy CRUD validation logic, and service handlers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import type { ConfigFile } from '../../core/config.js';
import type { DaemonState } from '../state.js';
import { ClientType } from '../state.js';
import { StdioCommandDeniedError } from '../stdio-command-policy.js';
import { StdioSpawnApprovalDeniedError } from '../mcp-client-pool.js';
import * as policiesModule from '../../core/policies.js';

// ── Mocks for handler tests ─────────────────────────────────────────────────

const mockLoadConfig = vi.fn().mockReturnValue({ providers: {} });
const mockLoadWorkspaceConfig = vi.fn().mockReturnValue(null);
const mockSaveConfig = vi.fn();
const mockSaveWorkspaceConfig = vi.fn();
const mockGetEngine = vi.fn().mockImplementation((id: string) => (
  id === 'mock' ? { id: 'mock', requiresKey: false, defaultEnvVar: 'MOCK_API_KEY' } : undefined
));
const mockDiscoverModels = vi.fn().mockResolvedValue([]);
const mockResolveProviderCredentials = vi.fn().mockResolvedValue({});
const mockStartEmbeddedWebServer = vi.fn().mockResolvedValue({ port: 3000, url: 'http://localhost:3000' });
const mockStopEmbeddedWebServer = vi.fn().mockResolvedValue(undefined);
const mockIsWebServerRunning = vi.fn().mockReturnValue(false);
const mockGetWebServerPort = vi.fn().mockReturnValue(3000);
const mockLoadCustomPolicies = vi.fn().mockReturnValue({});
const mockSaveCustomPolicies = vi.fn();
const mockGenerateSessionSummary = vi.fn().mockResolvedValue('summary text');
const mockMaybeSummarize = vi.fn().mockResolvedValue(undefined);
const mockAuditSecretChange = vi.fn();
const mockAuditProviderEndpointChange = vi.fn();
const mockAuditProviderEndpointConfigDiff = vi.fn();
const mockValidateProviderEndpoint = vi.fn().mockImplementation((url: string) => ({ ok: true as const, normalized: url }));
const mockValidateConfigProviderEndpoints = vi.fn().mockReturnValue({ ok: true as const });

vi.mock('../../core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/config.js')>();
  return {
    ...actual,
    loadConfig: (...a: unknown[]) => mockLoadConfig(...a),
    loadWorkspaceConfig: (...a: unknown[]) => mockLoadWorkspaceConfig(...a),
    saveConfig: (...a: unknown[]) => mockSaveConfig(...a),
    saveWorkspaceConfig: (...a: unknown[]) => mockSaveWorkspaceConfig(...a),
    getUserConfigPath: () => '/tmp/user-config.yaml',
    getWorkspaceConfigPath: (ws: string) => `/tmp/ws/${ws}/config.yaml`,
    isValidVirtualName: (n: string) => /^[a-z0-9][a-z0-9._-]*$/.test(n),
  };
});

vi.mock('../../core/engines.js', () => ({
  getEngines: () => [
    { id: 'mock', requiresKey: false, displayName: 'Mock', defaultBaseUrl: '', defaultEnvVar: 'MOCK_API_KEY' },
    { id: 'secure', requiresKey: true, displayName: 'Secure', defaultBaseUrl: '', defaultEnvVar: 'SECURE_API_KEY' },
  ],
  getEngine: (...a: unknown[]) => mockGetEngine(...a),
  getProviderTemplates: () => [{
    engine: 'mock',
    suggestedName: 'my-mock',
    defaultBaseUrl: 'http://localhost',
    requiresKey: false,
  }],
  validateConfigProviderEngines: (config: { providers?: Record<string, { engine?: string }> }) => {
    for (const [pid, cfg] of Object.entries(config.providers || {})) {
      if (!cfg?.engine) return { ok: false as const, error: `provider "${pid}": engine is required` };
      if (!mockGetEngine(cfg.engine)) {
        return { ok: false as const, error: `unknown engine "${cfg.engine}"` };
      }
    }
    return { ok: true as const };
  },
}));

vi.mock('../../core/policies.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/policies.js')>();
  return {
    ...actual,
    loadCustomPolicies: (...a: unknown[]) => mockLoadCustomPolicies(...a),
    saveCustomPolicies: (...a: unknown[]) => mockSaveCustomPolicies(...a),
  };
});

vi.mock('../../core/session-summarizer.js', () => ({
  maybeSummarize: (...a: unknown[]) => mockMaybeSummarize(...a),
  generateSessionSummary: (...a: unknown[]) => mockGenerateSessionSummary(...a),
}));

vi.mock('../../core/secrets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/secrets.js')>();
  return {
    ...actual,
    auditSecretChange: (...a: unknown[]) => mockAuditSecretChange(...a),
  };
});

vi.mock('../../core/provider-endpoint.js', () => ({
  auditProviderEndpointChange: (...a: unknown[]) => mockAuditProviderEndpointChange(...a),
  auditProviderEndpointConfigDiff: (...a: unknown[]) => mockAuditProviderEndpointConfigDiff(...a),
  endpointPolicyFromServer: () => ({ allowPrivateHosts: true }),
  validateConfigProviderEndpoints: (...a: unknown[]) => mockValidateConfigProviderEndpoints(...a),
  validateProviderEndpoint: (...a: unknown[]) => mockValidateProviderEndpoint(...a),
}));

vi.mock('../web/server.js', () => ({
  startEmbeddedWebServer: (...a: unknown[]) => mockStartEmbeddedWebServer(...a),
  stopEmbeddedWebServer: (...a: unknown[]) => mockStopEmbeddedWebServer(...a),
  isWebServerRunning: (...a: unknown[]) => mockIsWebServerRunning(...a),
  getWebServerPort: (...a: unknown[]) => mockGetWebServerPort(...a),
}));

import {
  configFileToProto,
  protoToConfigFile,
  createAbbenayService,
  protoToPolicyConfig,
  resolveGrpcSessionOwner,
  authorizeMcpRegister,
  authorizeInlinePolicy,
  DEFAULT_CONSUMER_AUTH_CONTEXT,
} from './abbenay-service.js';
import { withEnv } from '../../../tests/helpers/with-env.js';

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
            secrets: true,
            config: true,
            providers: true,
            shutdown: false,
            chat: true,
          },
        },
      },
    };

    const proto = configFileToProto(config);
    expect(proto.consumers!['apme'].token_env).toBe('APME_TOKEN');
    expect(proto.consumers!['apme'].capabilities!.inline_policy).toBe(true);
    expect(proto.consumers!['apme'].capabilities!.mcp_register).toBe(true);
    expect(proto.consumers!['apme'].capabilities!.secrets).toBe(true);
    expect(proto.consumers!['apme'].capabilities!.config).toBe(true);
    expect(proto.consumers!['apme'].capabilities!.providers).toBe(true);
    expect(proto.consumers!['apme'].capabilities!.shutdown).toBe(false);
    expect(proto.consumers!['apme'].capabilities!.chat).toBe(true);
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
          capabilities: {
            inline_policy: true,
            mcp_register: false,
            secrets: true,
            chat: true,
          },
        },
      },
    };

    const roundTripped = protoToConfigFile(configFileToProto(original));
    expect(roundTripped.consumers!['apme'].token_env).toBe('APME_TOKEN');
    expect(roundTripped.consumers!['apme'].capabilities.inline_policy).toBe(true);
    expect(roundTripped.consumers!['apme'].capabilities.mcp_register).toBe(false);
    expect(roundTripped.consumers!['apme'].capabilities.secrets).toBe(true);
    expect(roundTripped.consumers!['apme'].capabilities.chat).toBe(true);
  });

  it('round-trips consumers with token_keychain', () => {
    const original: ConfigFile = {
      consumers: {
        svc: {
          token_keychain: 'SVC_TOKEN',
          capabilities: { config: true, shutdown: true },
        },
      },
    };
    const roundTripped = protoToConfigFile(configFileToProto(original));
    expect(roundTripped.consumers!.svc.token_keychain).toBe('SVC_TOKEN');
    expect(roundTripped.consumers!.svc.capabilities.config).toBe(true);
    expect(roundTripped.consumers!.svc.capabilities.shutdown).toBe(true);
  });

  it('omits empty tool_policy arrays on round-trip', () => {
    const config = protoToConfigFile({
      tool_policy: {
        max_tool_iterations: 1,
        auto_approve: [],
        require_approval: [],
        disabled_tools: [],
        aliases: {},
      },
    });
    expect(config.tool_policy?.auto_approve).toBeUndefined();
    expect(config.tool_policy?.require_approval).toBeUndefined();
    expect(config.tool_policy?.disabled_tools).toBeUndefined();
    expect(config.tool_policy?.aliases).toBeUndefined();
  });

  it('keeps non-empty tool_policy aliases', () => {
    const config = protoToConfigFile({
      tool_policy: {
        aliases: { old: 'new' },
      },
    });
    expect(config.tool_policy?.aliases).toEqual({ old: 'new' });
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

  it('maps proto secret_store enum values onto provider config', () => {
    const config = protoToConfigFile({
      providers: {
        mem: { engine: 'openai', secret_name: 'M', secret_store: 3 },
        envp: { engine: 'openai', secret_name: 'E', secret_store: 'SECRET_STORE_ENV' },
        kc: { engine: 'openai', secret_name: 'K', secret_store: 'SECRET_STORE_KEYCHAIN' },
        filep: { engine: 'openai', secret_name: 'F', secret_store: 4 },
      },
    });
    expect(config.providers!.mem.secret_store).toBe('memory');
    expect(config.providers!.envp.secret_store).toBe('env');
    expect(config.providers!.kc.secret_store).toBe('keychain');
    expect(config.providers!.filep.secret_store).toBe('file');

    const proto = configFileToProto({
      providers: {
        filep: { engine: 'openai', secret_name: 'F', secret_store: 'file' },
      },
    });
    expect(proto.providers!.filep.secret_store).toBe(4);
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

// ── protoToPolicyConfig ──────────────────────────────────────────────────────

describe('protoToPolicyConfig', () => {
  it('converts valid proto fields', () => {
    const result = protoToPolicyConfig({
      sampling: { temperature: 0.5 },
      output: { format: 'markdown', system_prompt_mode: 'prepend' },
      tool: { tool_mode: 'auto' },
      context: { compression_strategy: 'truncate' },
    });
    expect(result.output?.format).toBe('markdown');
    expect(result.tool?.tool_mode).toBe('auto');
    expect(result.context?.compression_strategy).toBe('truncate');
  });

  it('rejects invalid enum values', () => {
    expect(() => protoToPolicyConfig({ output: { format: 'xml' } })).toThrow(/output\.format/);
    expect(() => protoToPolicyConfig({ tool: { tool_mode: 'force' } })).toThrow(/tool\.tool_mode/);
  });

  it('converts optional reliability settings', () => {
    const result = protoToPolicyConfig({
      reliability: { retry_on_invalid_json: true, timeout: 45 },
    });
    expect(result.reliability).toEqual({ retry_on_invalid_json: true, timeout: 45 });
  });
});

// ── resolveGrpcSessionOwner ──────────────────────────────────────────────────

describe('resolveGrpcSessionOwner', () => {
  it('returns local owner without matching token', () => {
    const call = { metadata: new grpc.Metadata() };
    expect(resolveGrpcSessionOwner(call, { providers: {} })).toBe('local');
  });

  it('returns consumer owner when token matches', () => {
    const prev = process.env.TEST_OWNER_TOKEN;
    process.env.TEST_OWNER_TOKEN = 'owner-tok';
    try {
      const metadata = new grpc.Metadata();
      metadata.add('x-abbenay-token', 'owner-tok');
      const call = { metadata };
      const config: ConfigFile = {
        consumers: {
          apme: { token_env: 'TEST_OWNER_TOKEN', capabilities: { chat: true } },
        },
      };
      expect(resolveGrpcSessionOwner(call, config)).toBe('consumer:apme');
    } finally {
      if (prev === undefined) delete process.env.TEST_OWNER_TOKEN;
      else process.env.TEST_OWNER_TOKEN = prev;
    }
  });
});

// ── deprecated auth wrappers ─────────────────────────────────────────────────

describe('authorizeMcpRegister / authorizeInlinePolicy', () => {
  it('delegate to authorizeConsumer', () => {
    const call = { metadata: new grpc.Metadata() };
    const config: ConfigFile = { providers: {} };
    expect(authorizeMcpRegister(call as never, config).allowed).toBe(true);
    expect(authorizeInlinePolicy(call as never, config).allowed).toBe(true);
  });
});

// ── createAbbenayService handlers ────────────────────────────────────────────

type UnaryHandler = (
  call: { request: unknown; metadata: grpc.Metadata },
  callback: grpc.sendUnaryData<Record<string, unknown>>,
) => void;

function invokeUnary(
  handler: UnaryHandler,
  request: unknown,
  metadata: grpc.Metadata = new grpc.Metadata(),
): Promise<{ error: grpc.ServiceError | null; response: Record<string, unknown> | undefined }> {
  return new Promise((resolve) => {
    handler({ request, metadata }, (error, response) => {
      resolve({
        error: (error ?? null) as grpc.ServiceError | null,
        response: response as Record<string, unknown> | undefined,
      });
    });
  });
}

function rpcField<T>(response: Record<string, unknown> | undefined, key: string): T | undefined {
  return response?.[key] as T | undefined;
}

function rpcArray<T = Record<string, unknown>>(
  response: Record<string, unknown> | undefined,
  key: string,
): T[] {
  const value = response?.[key];
  return Array.isArray(value) ? value as T[] : [];
}

function makeWritableStreamCall(request: object, metadata = new grpc.Metadata()) {
  const written: unknown[] = [];
  const errorHandlers: Array<(err: Error) => void> = [];
  const call = {
    request,
    metadata,
    write: (msg: unknown) => written.push(msg),
    end: vi.fn(),
    on: vi.fn((event: string, handler: (err: Error) => void) => {
      if (event === 'error') errorHandlers.push(handler);
    }),
    emit: vi.fn((event: string, err: Error) => {
      if (event === 'error') {
        for (const handler of errorHandlers) handler(err);
      }
    }),
  };
  return { call, written };
}

function createServiceHandlers(
  state: DaemonState,
  authContext = DEFAULT_CONSUMER_AUTH_CONTEXT,
): Record<string, UnaryHandler> {
  return createAbbenayService(state, authContext) as unknown as Record<string, UnaryHandler>;
}

function createMockState(overrides: Record<string, unknown> = {}): DaemonState {
  const secretStore = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(true),
    has: vi.fn().mockResolvedValue(false),
  };
  const sessionStore = {
    create: vi.fn().mockResolvedValue({
      id: 'sess-1',
      model: 'mock/echo',
      title: 'New Session',
      messages: [],
      metadata: {},
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }),
    getOwned: vi.fn().mockResolvedValue({
      id: 'sess-1',
      model: 'mock/echo',
      title: 'New Session',
      messages: [],
      metadata: {},
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }),
    list: vi.fn().mockResolvedValue({ sessions: [], totalCount: 0 }),
    deleteOwned: vi.fn().mockResolvedValue(undefined),
    appendMessage: vi.fn().mockResolvedValue(undefined),
    updateTitle: vi.fn().mockResolvedValue(undefined),
    updateSummary: vi.fn().mockResolvedValue(undefined),
  };
  const mcpClientPool = {
    getStatuses: vi.fn().mockReturnValue([]),
    getStatus: vi.fn().mockReturnValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    disconnectByScope: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    connectDynamic: vi.fn().mockResolvedValue(['tool-a']),
    applySecurityConfig: vi.fn(),
  };

  return {
    version: '0.0.0-test',
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    clientCount: 2,
    secretStore,
    sessionStore,
    mcpClientPool,
    toolRegistry: { getAll: vi.fn().mockReturnValue([]), clearSessionScope: vi.fn() },
    registerClient: vi.fn().mockReturnValue('client-abc'),
    unregisterClient: vi.fn(),
    listProviders: vi.fn().mockResolvedValue([{
      id: 'mock',
      engine: 'mock',
      configured: true,
      healthy: true,
      requiresKey: false,
      defaultBaseUrl: '',
      baseUrl: '',
    }]),
    listModels: vi.fn().mockResolvedValue([]),
    discoverModels: (...a: unknown[]) => mockDiscoverModels(...a),
    resolveProviderCredentials: (...a: unknown[]) => mockResolveProviderCredentials(...a),
    chat: vi.fn(),
    getVSCodeWorkspaces: vi.fn().mockReturnValue(['/ws/a']),
    getClients: vi.fn().mockReturnValue([{
      clientId: 'c1',
      clientType: ClientType.CLI,
      connectedAt: new Date('2024-01-02T00:00:00.000Z'),
      isSpawner: false,
      workspacePath: '/ws/a',
      workspacePaths: ['/ws/a'],
    }]),
    registerVSCodeConnection: vi.fn().mockReturnValue('vscode-conn-1'),
    unregisterVSCodeConnection: vi.fn(),
    handleVSCodeResponse: vi.fn(),
    handleRegisterToolsNotification: vi.fn(),
    requestWorkspace: vi.fn().mockResolvedValue({ workspacePath: '/ws', workspaceFolders: ['/ws'] }),
    requestVSCodeTools: vi.fn().mockResolvedValue(undefined),
    notifyModelsChanged: vi.fn(),
    refreshMcpConnections: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as DaemonState;
}

describe('createAbbenayService handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ providers: {} });
    mockLoadWorkspaceConfig.mockReturnValue(null);
    mockIsWebServerRunning.mockReturnValue(false);
    mockValidateProviderEndpoint.mockImplementation((url: string) => ({ ok: true as const, normalized: url }));
    mockValidateConfigProviderEndpoints.mockReturnValue({ ok: true as const });
  });

  it('Register maps client types and returns client_id', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);
    const cases: Array<[string | number, boolean]> = [
      ['CLIENT_TYPE_VSCODE', false],
      [2, true],
      ['CLIENT_TYPE_PYTHON', false],
      ['CLIENT_TYPE_NODEJS', false],
      ['CLIENT_TYPE_MCP', false],
      ['UNKNOWN', false],
    ];

    for (const [clientType, isSpawner] of cases) {
      const { error, response } = await invokeUnary(service.Register, {
        client: { client_type: clientType },
        is_spawner: isSpawner,
        workspace_path: '/tmp/ws',
      });
      expect(error).toBeNull();
      expect(response?.client_id).toBe('client-abc');
      expect(state.registerClient).toHaveBeenCalled();
    }
  });

  it('Unregister calls state.unregisterClient', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);
    const { error } = await invokeUnary(service.Unregister, { client_id: 'c1' });
    expect(error).toBeNull();
    expect(state.unregisterClient).toHaveBeenCalledWith('c1');
  });

  it('HealthCheck and GetStatus return daemon metadata', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);

    const health = await invokeUnary(service.HealthCheck, {});
    expect(health.error).toBeNull();
    expect(health.response?.healthy).toBe(true);
    expect(health.response?.version).toBe('0.0.0-test');

    const status = await invokeUnary(service.GetStatus, {});
    expect(status.error).toBeNull();
    expect(status.response?.connected_clients).toBe(2);
    expect(rpcArray<{ client_id: string }>(status.response, 'clients')[0]?.client_id).toBe('c1');
  });

  it('GetConnectedWorkspaces returns VS Code workspaces', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);
    const { response } = await invokeUnary(service.GetConnectedWorkspaces, {});
    expect(response?.workspaces).toEqual(['/ws/a']);
  });

  it('ListProviders and ListModels map response fields', async () => {
    const state = createMockState({
      listModels: vi.fn().mockResolvedValue([{
        id: 'mock/echo',
        name: 'echo',
        engineModelId: 'echo',
        provider: 'mock',
        engine: 'mock',
        contextWindow: 8192,
        capabilities: { supportsTools: true, supportsVision: false },
        params: { temperature: 0.2, policy: 'precise' },
      }]),
    });
    const service = createServiceHandlers(state);

    const providers = await invokeUnary(service.ListProviders, {});
    expect(rpcArray(providers.response, 'providers')[0]?.requires_key).toBe(false);

    const models = await invokeUnary(service.ListModels, { workspace_paths: ['/ws'] });
    const model = rpcArray<{ capabilities?: { supports_tools?: boolean }; policy?: string }>(models.response, 'models')[0];
    expect(model?.capabilities?.supports_tools).toBe(true);
    expect(model?.policy).toBe('precise');
  });

  it('DiscoverModels validates engine_id and maps models', async () => {
    const state = createMockState();
    mockDiscoverModels.mockResolvedValue([{
      id: 'm1',
      engine: 'mock',
      contextWindow: 4096,
      capabilities: { supportsTools: false, supportsVision: true },
    }]);
    const service = createServiceHandlers(state);

    const missing = await invokeUnary(service.DiscoverModels, {});
    expect(missing.error?.code).toBe(grpc.status.INVALID_ARGUMENT);

    const ok = await invokeUnary(service.DiscoverModels, { engine_id: 'mock' });
    expect(ok.error).toBeNull();
    expect(rpcArray(ok.response, 'models')[0]?.context_window).toBe(4096);
  });

  it('GetProviderStatus returns NOT_FOUND for unknown provider', async () => {
    const state = createMockState({ listProviders: vi.fn().mockResolvedValue([]) });
    const service = createServiceHandlers(state);
    const { error } = await invokeUnary(service.GetProviderStatus, { provider_id: 'missing' });
    expect(error?.code).toBe(grpc.status.NOT_FOUND);
  });

  it('Secrets RPCs audit and notify on mutation', async () => {
    const state = createMockState({
      secretStore: {
        get: vi.fn().mockResolvedValue('secret-val'),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(true),
        has: vi.fn().mockResolvedValue(true),
      },
    });
    const service = createServiceHandlers(state);

    const got = await invokeUnary(service.GetSecret, { key: 'K' });
    expect(got.response?.value).toBe('secret-val');
    expect(got.response?.found).toBe(true);

    const set = await invokeUnary(service.SetSecret, { key: 'K', value: 'v' });
    expect(set.error).toBeNull();
    expect(mockAuditSecretChange).toHaveBeenCalledWith({ key: 'K', op: 'set', source: 'grpc-secrets' });
    expect(state.notifyModelsChanged).toHaveBeenCalledWith('secret_updated');

    const del = await invokeUnary(service.DeleteSecret, { key: 'K' });
    expect(del.error).toBeNull();
    expect(mockAuditSecretChange).toHaveBeenCalledWith({ key: 'K', op: 'delete', source: 'grpc-secrets' });

    const listed = await invokeUnary(service.ListSecrets, {});
    expect(rpcArray(listed.response, 'secrets')[0]?.engine).toBe('secure');
    expect(rpcArray(listed.response, 'secrets')[0]?.has_value).toBe(true);
  });

  it('GetConfig and UpdateConfig round-trip user config', async () => {
    const config: ConfigFile = {
      providers: { mock: { engine: 'mock', models: { echo: {} } } },
    };
    mockLoadConfig.mockReturnValue(config);
    const state = createMockState();
    const service = createServiceHandlers(state);

    const got = await invokeUnary(service.GetConfig, { location: 'user' });
    expect(got.response?.path).toBe('/tmp/user-config.yaml');
    expect(rpcField<{ providers?: Record<string, { engine?: string }> }>(got.response, 'config')?.providers?.mock?.engine).toBe('mock');

    const updated = await invokeUnary(service.UpdateConfig, {
      location: 'user',
      config: configFileToProto(config),
    });
    expect(updated.error).toBeNull();
    expect(mockSaveConfig).toHaveBeenCalled();
    expect(mockAuditProviderEndpointConfigDiff).toHaveBeenCalled();
    expect(state.notifyModelsChanged).toHaveBeenCalledWith('config_changed');
  });

  it('UpdateConfig rejects missing config and invalid engines', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);

    const missing = await invokeUnary(service.UpdateConfig, { location: 'user' });
    expect(missing.error?.code).toBe(grpc.status.INVALID_ARGUMENT);

    const badEngine = await invokeUnary(service.UpdateConfig, {
      location: 'user',
      config: { providers: { bad: { engine: 'unknown' } } },
    });
    expect(badEngine.error?.code).toBe(grpc.status.INVALID_ARGUMENT);
  });

  it('CreatePolicy and DeletePolicy manage custom policies', async () => {
    mockLoadCustomPolicies.mockReturnValue({ custom: protoToPolicyConfig({ sampling: { temperature: 0.1 } }) });
    const state = createMockState();
    const service = createServiceHandlers(state);

    const created = await invokeUnary(service.CreatePolicy, {
      name: 'custom',
      config: { sampling: { temperature: 0.2 } },
    });
    expect(created.error).toBeNull();
    expect(mockSaveCustomPolicies).toHaveBeenCalled();

    const deleted = await invokeUnary(service.DeletePolicy, { name: 'custom' });
    expect(deleted.error).toBeNull();
  });

  it('CreatePolicy rejects built-in overwrite and invalid names', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);

    const builtin = await invokeUnary(service.CreatePolicy, {
      name: 'precise',
      config: { sampling: { temperature: 0.1 } },
    });
    expect(builtin.error?.code).toBe(grpc.status.INVALID_ARGUMENT);

    const invalid = await invokeUnary(service.CreatePolicy, {
      name: 'Bad Name',
      config: { sampling: { temperature: 0.1 } },
    });
    expect(invalid.error?.code).toBe(grpc.status.INVALID_ARGUMENT);
  });

  it('StartWebServer starts or reports already running', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);

    const started = await invokeUnary(service.StartWebServer, { port: 3000 });
    expect(started.response?.started).toBe(true);
    expect(mockStartEmbeddedWebServer).toHaveBeenCalledWith(state, 3000);

    mockIsWebServerRunning.mockReturnValue(true);
    mockGetWebServerPort.mockReturnValue(3001);
    const running = await invokeUnary(service.StartWebServer, {});
    expect(running.response?.already_running).toBe(true);
    expect(running.response?.port).toBe(3001);
  });

  it('StopWebServer stops embedded server', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);
    const { error } = await invokeUnary(service.StopWebServer, {});
    expect(error).toBeNull();
    expect(mockStopEmbeddedWebServer).toHaveBeenCalled();
  });

  it('Shutdown acknowledges and schedules SIGTERM', async () => {
    vi.useFakeTimers();
    const emitSpy = vi.spyOn(process, 'emit').mockReturnValue(true as never);
    try {
      const state = createMockState();
      const service = createServiceHandlers(state);

      const { error } = await invokeUnary(service.Shutdown, {});
      expect(error).toBeNull();
      vi.advanceTimersByTime(150);
      expect(emitSpy).toHaveBeenCalledWith('SIGTERM', 'SIGTERM');
    } finally {
      emitSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('Session RPCs validate required fields', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);

    const noModel = await invokeUnary(service.CreateSession, { topic: 'x' });
    expect(noModel.error?.code).toBe(grpc.status.INVALID_ARGUMENT);

    const noId = await invokeUnary(service.GetSession, {});
    expect(noId.error?.code).toBe(grpc.status.INVALID_ARGUMENT);

    const created = await invokeUnary(service.CreateSession, { model: 'mock/echo', topic: 't' });
    expect(created.response?.id).toBe('sess-1');

    const listed = await invokeUnary(service.ListSessions, { limit: 10, offset: 0 });
    expect(listed.response?.total_count).toBe(0);

    const deleted = await invokeUnary(service.DeleteSession, { session_id: 'sess-1' });
    expect(deleted.error).toBeNull();
    expect(state.mcpClientPool.disconnectByScope).toHaveBeenCalledWith('sess-1');
  });

  it('SummarizeSession returns cached summary when counts match', async () => {
    const state = createMockState({
      sessionStore: {
        getOwned: vi.fn().mockResolvedValue({
          id: 'sess-1',
          model: 'mock/echo',
          title: 't',
          messages: [{ role: 'user', content: 'hi' }],
          summary: 'cached',
          summaryMessageCount: 1,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        }),
        updateSummary: vi.fn(),
      },
    });
    const service = createServiceHandlers(state);
    const { response } = await invokeUnary(service.SummarizeSession, { session_id: 'sess-1' });
    expect(response?.summary).toBe('cached');
    expect(response?.from_cache).toBe(true);
    expect(mockGenerateSessionSummary).not.toHaveBeenCalled();
  });

  it('RegisterMcpServer validates input and connects dynamic servers', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);

    const missingId = await invokeUnary(service.RegisterMcpServer, { transport: { type: 'http', url: 'http://x' } });
    expect(missingId.error?.code).toBe(grpc.status.INVALID_ARGUMENT);

    const ok = await invokeUnary(service.RegisterMcpServer, {
      server_id: 'dyn',
      transport: { type: 'http', url: 'http://mcp.example.com' },
    });
    expect(ok.response?.success).toBe(true);
    expect(ok.response?.discovered_tools).toEqual(['tool-a']);
  });

  it('RegisterMcpServer maps stdio denial to PERMISSION_DENIED', async () => {
    const state = createMockState({
      mcpClientPool: {
        applySecurityConfig: vi.fn(),
        connectDynamic: vi.fn().mockRejectedValue(new StdioCommandDeniedError('denied')),
      },
    });
    const service = createServiceHandlers(state);
    const { error } = await invokeUnary(service.RegisterMcpServer, {
      server_id: 'dyn',
      transport: { type: 'stdio', command: 'npx', args: ['x'] },
    });
    expect(error?.code).toBe(grpc.status.PERMISSION_DENIED);
  });

  it('UnregisterMcpServer rejects config-based servers', async () => {
    const state = createMockState({
      mcpClientPool: {
        getStatus: vi.fn().mockReturnValue({ source: 'config', connected: true }),
      },
    });
    const service = createServiceHandlers(state);
    const { error } = await invokeUnary(service.UnregisterMcpServer, { server_id: 'cfg' });
    expect(error?.code).toBe(grpc.status.FAILED_PRECONDITION);
  });

  it('ConfigureProvider validates provider_id and persists config', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);

    const missing = await invokeUnary(service.ConfigureProvider, { engine: 'mock' });
    expect(missing.error?.code).toBe(grpc.status.INVALID_ARGUMENT);

    const ok = await invokeUnary(service.ConfigureProvider, {
      provider_id: 'my-mock',
      engine: 'mock',
      api_key: 'key-123',
      base_url: 'http://localhost:8080',
    });
    expect(ok.response?.success).toBe(true);
    expect(mockSaveConfig).toHaveBeenCalled();
    expect(mockAuditSecretChange).toHaveBeenCalled();
  });

  it('ConfigureProvider writes api_key to memory and rejects conflicting credential fields', async () => {
    const { SecretStoreRegistry } = await import('../secrets/registry.js');
    const { MemorySecretStore } = await import('../../core/secrets.js');
    const registry = new SecretStoreRegistry(new MemorySecretStore(), new MemorySecretStore());
    const state = createMockState({ secretStore: registry });
    const service = createServiceHandlers(state);

    const mem = await invokeUnary(service.ConfigureProvider, {
      provider_id: 'mem-mock',
      engine: 'mock',
      api_key: 'ephemeral',
      secret_store: 'SECRET_STORE_MEMORY',
      secret_name: 'MEM_MOCK_API_KEY',
    });
    expect(mem.response?.success).toBe(true);
    expect(await registry.getFrom('memory', 'MEM_MOCK_API_KEY')).toBe('ephemeral');
    expect(await registry.hasIn('keychain', 'MEM_MOCK_API_KEY')).toBe(false);
    expect(mockAuditSecretChange).toHaveBeenCalledWith({
      key: 'MEM_MOCK_API_KEY',
      op: 'set',
      source: 'grpc-configure-memory',
    });

    expect((await invokeUnary(service.ConfigureProvider, {
      provider_id: 'bad-combo',
      engine: 'mock',
      api_key: 'x',
      env_var_name: 'Y',
    })).error?.code).toBe(grpc.status.INVALID_ARGUMENT);

    expect((await invokeUnary(service.ConfigureProvider, {
      provider_id: 'bad-combo-2',
      engine: 'mock',
      secret_name: 'X',
      env_var_name: 'Y',
    })).error?.code).toBe(grpc.status.INVALID_ARGUMENT);

    expect((await invokeUnary(service.ConfigureProvider, {
      provider_id: 'bad-store',
      engine: 'mock',
      api_key: 'x',
      secret_store: 'SECRET_STORE_ENV',
    })).error?.code).toBe(grpc.status.INVALID_ARGUMENT);

    expect((await invokeUnary(service.ConfigureProvider, {
      provider_id: 'missing-secret',
      engine: 'mock',
      secret_name: 'DOES_NOT_EXIST',
      secret_store: 'SECRET_STORE_MEMORY',
    })).error?.code).toBe(grpc.status.INVALID_ARGUMENT);

    // secret_name without store defaults to keychain lookup.
    await registry.setIn('keychain', 'DEFAULT_KC', 'v');
    const def = await invokeUnary(service.ConfigureProvider, {
      provider_id: 'default-kc',
      engine: 'mock',
      secret_name: 'DEFAULT_KC',
    });
    expect(def.response?.success).toBe(true);

    expect((await invokeUnary(service.ConfigureProvider, {
      provider_id: 'bad-ref-store',
      engine: 'mock',
      secret_name: 'X',
      secret_store: 'vault',
    })).error?.code).toBe(grpc.status.INVALID_ARGUMENT);
  });

  it('Secrets RPCs reject unsupported store selections', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);
    expect((await invokeUnary(service.GetSecret, { key: 'K', store: 'vault' })).error?.code)
      .toBe(grpc.status.INVALID_ARGUMENT);
    expect((await invokeUnary(service.DeleteSecret, { key: 'K', store: 'SECRET_STORE_ENV' })).error?.code)
      .toBe(grpc.status.INVALID_ARGUMENT);
  });

  it('Secrets RPCs reject memory when secret store is not a registry', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const state = createMockState({
      secretStore: {
        get: vi.fn().mockResolvedValue(null),
        set,
        delete: vi.fn().mockResolvedValue(true),
        has: vi.fn().mockResolvedValue(false),
      },
    });
    const service = createServiceHandlers(state);

    for (const method of ['GetSecret', 'SetSecret', 'DeleteSecret'] as const) {
      const req =
        method === 'SetSecret'
          ? { key: 'K', value: 'v', store: 'SECRET_STORE_MEMORY' }
          : { key: 'K', store: 'SECRET_STORE_MEMORY' };
      const { error } = await invokeUnary(service[method], req);
      expect(error?.code, method).toBe(grpc.status.INVALID_ARGUMENT);
      expect(error?.message, method).toMatch(/memory|SecretStoreRegistry/i);
    }
    expect(set).not.toHaveBeenCalled();

    const configure = await invokeUnary(service.ConfigureProvider, {
      provider_id: 'plain-mem',
      engine: 'mock',
      api_key: 'x',
      secret_store: 'SECRET_STORE_MEMORY',
    });
    expect(configure.error?.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(set).not.toHaveBeenCalled();
  });

  it('ListSecrets returns empty has_value rows when registry backends lack the key', async () => {
    mockGetEngine.mockImplementation((id: string) => (
      id === 'mock' ? { id: 'mock', requiresKey: false, defaultEnvVar: 'MOCK_API_KEY' }
        : id === 'secure' ? { id: 'secure', requiresKey: true, defaultEnvVar: 'SECURE_API_KEY' }
          : undefined
    ));
    // getEngines is mocked at module level to return mock+secure
    const { SecretStoreRegistry } = await import('../secrets/registry.js');
    const { MemorySecretStore } = await import('../../core/secrets.js');
    const registry = new SecretStoreRegistry(new MemorySecretStore(), new MemorySecretStore());
    const state = createMockState({ secretStore: registry });
    const service = createServiceHandlers(state);
    const listed = await invokeUnary(service.ListSecrets, {});
    const rows = rpcArray<{ key: string; has_value?: boolean }>(listed.response, 'secrets');
    const secure = rows.filter((r) => r.key === 'SECURE_API_KEY');
    expect(secure.length).toBeGreaterThanOrEqual(1);
    expect(secure.every((r) => r.has_value === false)).toBe(true);
  });

  it('RemoveProvider deletes provider and keychain secret', async () => {
    mockLoadConfig.mockReturnValue({
      providers: {
        mymock: {
          engine: 'mock',
          api_key_keychain_name: 'MYMOCK_API_KEY',
        },
      },
    });
    const state = createMockState();
    const service = createServiceHandlers(state);
    const { error } = await invokeUnary(service.RemoveProvider, { provider_id: 'mymock' });
    expect(error).toBeNull();
    expect(mockSaveConfig).toHaveBeenCalled();
    expect(state.notifyModelsChanged).toHaveBeenCalledWith('provider_removed');
  });

  it('RemoveProvider deletes owned memory secret from the memory backend only', async () => {
    const { SecretStoreRegistry } = await import('../secrets/registry.js');
    const { MemorySecretStore } = await import('../../core/secrets.js');
    const memory = new MemorySecretStore();
    const keychain = new MemorySecretStore();
    await memory.set('MYMOCK_API_KEY', 'mem-value');
    await keychain.set('MYMOCK_API_KEY', 'kc-value');
    const registry = new SecretStoreRegistry(memory, keychain);

    mockLoadConfig.mockReturnValue({
      providers: {
        mymock: {
          engine: 'mock',
          secret_name: 'MYMOCK_API_KEY',
          secret_store: 'memory',
        },
      },
    });
    const state = createMockState({ secretStore: registry });
    const service = createServiceHandlers(state);

    const { error } = await invokeUnary(service.RemoveProvider, { provider_id: 'mymock' });
    expect(error).toBeNull();
    expect(await memory.has('MYMOCK_API_KEY')).toBe(false);
    expect(await keychain.has('MYMOCK_API_KEY')).toBe(true);
    expect(mockAuditSecretChange).toHaveBeenCalledWith({
      key: 'MYMOCK_API_KEY',
      op: 'delete',
      source: 'grpc-configure',
    });
  });

  it('RemoveProvider skips env-backed and shared secret names', async () => {
    const { SecretStoreRegistry } = await import('../secrets/registry.js');
    const { MemorySecretStore } = await import('../../core/secrets.js');
    const memory = new MemorySecretStore();
    const keychain = new MemorySecretStore();
    await keychain.set('SHARED_OPENAI', 'shared');
    await keychain.set('ENV_LOOKALIKE', 'should-remain');
    const registry = new SecretStoreRegistry(memory, keychain);
    const state = createMockState({ secretStore: registry });
    const service = createServiceHandlers(state);

    mockLoadConfig.mockReturnValue({
      providers: {
        'env-openai': {
          engine: 'mock',
          secret_name: 'ENV_LOOKALIKE',
          secret_store: 'env',
        },
      },
    });
    expect((await invokeUnary(service.RemoveProvider, { provider_id: 'env-openai' })).error).toBeNull();
    expect(await keychain.has('ENV_LOOKALIKE')).toBe(true);

    mockLoadConfig.mockReturnValue({
      providers: {
        'shared-openai': {
          engine: 'mock',
          secret_name: 'SHARED_OPENAI',
          secret_store: 'keychain',
        },
      },
    });
    expect((await invokeUnary(service.RemoveProvider, { provider_id: 'shared-openai' })).error).toBeNull();
    expect(await keychain.has('SHARED_OPENAI')).toBe(true);
    expect(mockAuditSecretChange).not.toHaveBeenCalled();
  });

  it('GetKeyStatus checks keychain and env sources', async () => {
    const state = createMockState({
      secretStore: { has: vi.fn().mockResolvedValue(true) },
    });
    const service = createServiceHandlers(state);

    const keychain = await invokeUnary(service.GetKeyStatus, { source: 'keychain', name: 'K' });
    expect(keychain.response?.exists).toBe(true);

    const prev = process.env.TEST_ENV_KEY;
    process.env.TEST_ENV_KEY = 'present';
    try {
      const env = await invokeUnary(service.GetKeyStatus, { source: 'env', name: 'TEST_ENV_KEY' });
      expect(env.response?.exists).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TEST_ENV_KEY;
      else process.env.TEST_ENV_KEY = prev;
    }

    const missing = await invokeUnary(service.GetKeyStatus, { source: '', name: '' });
    expect(missing.error?.code).toBe(grpc.status.INVALID_ARGUMENT);
  });

  it('GetKeyStatus checks memory independently of keychain', async () => {
    const { SecretStoreRegistry } = await import('../secrets/registry.js');
    const { MemorySecretStore } = await import('../../core/secrets.js');
    const memory = new MemorySecretStore();
    const keychain = new MemorySecretStore();
    await memory.set('MEM_ONLY', 'v');
    const registry = new SecretStoreRegistry(memory, keychain);
    const state = createMockState({ secretStore: registry });
    const service = createServiceHandlers(state);

    const mem = await invokeUnary(service.GetKeyStatus, { source: 'memory', name: 'MEM_ONLY' });
    expect(mem.response?.exists).toBe(true);
    const kc = await invokeUnary(service.GetKeyStatus, { source: 'keychain', name: 'MEM_ONLY' });
    expect(kc.response?.exists).toBe(false);
  });

  it('ListMcpServerConfigs merges config and runtime statuses', async () => {
    mockLoadConfig.mockReturnValue({
      mcp_servers: {
        cfg: { transport: 'stdio', command: 'npx', enabled: true },
        disabled: { transport: 'stdio', command: 'x', enabled: false },
      },
    });
    const state = createMockState({
      mcpClientPool: {
        getStatuses: vi.fn().mockReturnValue([
          { id: 'cfg', connected: true, toolCount: 2, config: { transport: 'stdio', enabled: true } },
          { id: 'dynamic', connected: false, error: 'down', toolCount: 0, config: { transport: 'http', enabled: true } },
        ]),
      },
    });
    const service = createServiceHandlers(state);
    const { response } = await invokeUnary(service.ListMcpServerConfigs, {});
    const byId = Object.fromEntries(rpcArray<{ id: string; status: string }>(response, 'mcp_servers').map((s) => [s.id, s]));
    expect(byId.cfg.status).toBe('connected');
    expect(byId.disabled.status).toBe('disabled');
    expect(byId.dynamic.status).toBe('error');
  });

  it('unimplemented session/tool RPCs return UNIMPLEMENTED', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);
    for (const method of ['ReplaySession', 'ForkSession', 'ExportSession', 'ImportSession', 'ExecuteTool'] as const) {
      const { error } = await invokeUnary(service[method] as UnaryHandler, {});
      expect(error?.code).toBe(grpc.status.UNIMPLEMENTED);
    }
  });

  it('Chat stream writes text, tool, done, and error chunks', async () => {
    async function* chunks() {
      yield { type: 'text' as const, text: 'hi' };
      yield {
        type: 'tool' as const,
        name: 'search',
        done: false,
        call: { params: { q: 'x' } },
      };
      yield {
        type: 'tool' as const,
        name: 'search',
        done: true,
        call: { params: { q: 'x' }, result: { ok: true } },
      };
      yield { type: 'done' as const, finishReason: 'stop' };
    }

    const state = createMockState({ chat: vi.fn().mockReturnValue(chunks()) });
    const service = createAbbenayService(state);
    const written: unknown[] = [];
    const call = {
      request: {
        model: 'mock/echo',
        messages: [{ role: 'ROLE_USER', content: 'hello' }],
      },
      metadata: new grpc.Metadata(),
      write: (msg: unknown) => written.push(msg),
      end: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
    };

    service.Chat(call as never);
    await vi.waitFor(() => expect(call.end).toHaveBeenCalled());

    expect(written.some((c) => (c as { text?: { text: string } }).text?.text === 'hi')).toBe(true);
    expect(written.some((c) => (c as { tool_call?: unknown }).tool_call)).toBe(true);
    expect(written.some((c) => (c as { tool_result?: unknown }).tool_result)).toBe(true);
    expect(written.some((c) => (c as { done?: unknown }).done)).toBe(true);
  });

  it('Chat denies inline policy without capability when consumers configured', async () => {
    mockLoadConfig.mockReturnValue({
      providers: {},
      consumers: {
        limited: {
          token_env: 'NO_INLINE',
          capabilities: { chat: true },
        },
      },
    });
    await withEnv('NO_INLINE', 'tok', async () => {
      const state = createMockState({ chat: vi.fn() });
      const service = createAbbenayService(state, DEFAULT_CONSUMER_AUTH_CONTEXT);
      const written: unknown[] = [];
      const metadata = new grpc.Metadata();
      metadata.add('x-abbenay-token', 'tok');
      const call = {
        request: {
          model: 'mock/echo',
          messages: [{ role: 2, content: 'hi' }],
          policy: { sampling: { temperature: 0.2 } },
        },
        metadata,
        write: (msg: unknown) => written.push(msg),
        end: vi.fn(),
        on: vi.fn(),
        emit: vi.fn(),
      };

      service.Chat(call as never);
      await vi.waitFor(() => expect(call.end).toHaveBeenCalled());
      expect(written[0]).toEqual({
        error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Inline policy') },
      });
    });
  });

  it('denies sensitive RPC when consumers configured without token', async () => {
    mockLoadConfig.mockReturnValue({
      providers: {},
      consumers: {
        secrets: { token_env: 'SEC_TOKEN', capabilities: { secrets: true } },
      },
    });
    const state = createMockState();
    const service = createServiceHandlers(state, DEFAULT_CONSUMER_AUTH_CONTEXT);
    const { error } = await invokeUnary(service.GetSecret, { key: 'K' });
    expect(error?.code).toBe(grpc.status.PERMISSION_DENIED);
  });

  it('Chat returns INVALID_ARGUMENT when model missing', async () => {
    const state = createMockState();
    const service = createAbbenayService(state);
    const written: unknown[] = [];
    const call = {
      request: { messages: [{ role: 2, content: 'hi' }] },
      metadata: new grpc.Metadata(),
      write: (msg: unknown) => written.push(msg),
      end: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
    };
    service.Chat(call as never);
    await vi.waitFor(() => expect(call.end).toHaveBeenCalled());
    expect(written[0]).toEqual({ error: { code: 'INVALID_ARGUMENT', message: 'Model is required' } });
  });

  it('Chat stream emits PERMISSION_DENIED via gRPC error when auth fails', async () => {
    mockLoadConfig.mockReturnValue({
      providers: {},
      consumers: {
        chatter: { token_env: 'CHAT_TOKEN', capabilities: { chat: true } },
      },
    });
    const state = createMockState();
    const service = createAbbenayService(state, DEFAULT_CONSUMER_AUTH_CONTEXT);
    const errors: unknown[] = [];
    const call = {
      request: { model: 'mock/echo', messages: [{ role: 2, content: 'hi' }] },
      metadata: new grpc.Metadata(),
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn((event: string, handler: (err: Error) => void) => {
        if (event === 'error') errors.push(handler);
      }),
      emit: vi.fn((event: string, err: Error) => {
        if (event === 'error') {
          for (const h of errors as Array<(e: Error) => void>) h(err);
        }
      }),
    };

    service.Chat(call as never);
    await vi.waitFor(() => expect(call.emit).toHaveBeenCalledWith('error', expect.any(Error)));
    const err = (call.emit as ReturnType<typeof vi.fn>).mock.calls[0][1] as Error & { code?: number };
    expect(err.code).toBe(grpc.status.PERMISSION_DENIED);
  });

  it('SessionChat validates session_id and message content', async () => {
    const state = createMockState();
    const service = createAbbenayService(state);
    const written: unknown[] = [];
    const makeCall = (request: object) => ({
      request,
      metadata: new grpc.Metadata(),
      write: (msg: unknown) => written.push(msg),
      end: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
    });

    service.SessionChat(makeCall({}) as never);
    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));
    expect(written[0]).toEqual({ error: { code: 'INVALID_ARGUMENT', message: 'session_id is required' } });

    written.length = 0;
    service.SessionChat(makeCall({ session_id: 'sess-1' }) as never);
    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));
    expect(written[0]).toEqual({ error: { code: 'INVALID_ARGUMENT', message: 'message with content is required' } });
  });

  it('SessionChat streams assistant text and auto-titles first turn', async () => {
    async function* chunks() {
      yield { type: 'text' as const, text: 'answer' };
      yield { type: 'done' as const, finishReason: 'stop' };
    }
    const session = {
      id: 'sess-1',
      model: 'mock/echo',
      title: 'New Session',
      messages: [],
      metadata: {},
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    const sessionStore = {
      getOwned: vi.fn().mockResolvedValue(session),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      updateTitle: vi.fn().mockResolvedValue(undefined),
    };
    const state = createMockState({ chat: vi.fn().mockReturnValue(chunks()), sessionStore });
    const service = createAbbenayService(state);
    const written: unknown[] = [];
    const call = {
      request: {
        session_id: 'sess-1',
        message: { role: 'ROLE_USER', content: 'First question here' },
      },
      metadata: new grpc.Metadata(),
      write: (msg: unknown) => written.push(msg),
      end: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
    };

    service.SessionChat(call as never);
    await vi.waitFor(() => expect(call.end).toHaveBeenCalled());
    expect(written.some((c) => (c as { text?: { text: string } }).text?.text === 'answer')).toBe(true);
    expect(sessionStore.updateTitle).toHaveBeenCalledWith('sess-1', 'First question here');
    expect(mockMaybeSummarize).toHaveBeenCalled();
  });

  it('RegisterMcpServer requires token when consumers configured', async () => {
    mockLoadConfig.mockReturnValue({
      providers: {},
      consumers: {
        mcp: { token_env: 'MCP_TOKEN', capabilities: { mcp_register: true } },
      },
    });
    const state = createMockState();
    const service = createServiceHandlers(state, DEFAULT_CONSUMER_AUTH_CONTEXT);
    const { error } = await invokeUnary(service.RegisterMcpServer, {
      server_id: 'dyn',
      transport: { type: 'stdio', command: 'npx', args: ['x'] },
    });
    expect(error?.code).toBe(grpc.status.PERMISSION_DENIED);
    expect(error?.message).toMatch(/consumer authentication/i);
  });

  it('RegisterMcpServer allows stdio when consumer has mcp_register capability', async () => {
    await withEnv('MCP_TOKEN', 'good-token', async () => {
      mockLoadConfig.mockReturnValue({
        providers: {},
        consumers: {
          mcp: { token_env: 'MCP_TOKEN', capabilities: { mcp_register: true } },
        },
      });
      const state = createMockState();
      const service = createServiceHandlers(state, DEFAULT_CONSUMER_AUTH_CONTEXT);
      const metadata = new grpc.Metadata();
      metadata.add('x-abbenay-token', 'good-token');
      const { response } = await invokeUnary(service.RegisterMcpServer, {
        server_id: 'dyn',
        transport: { type: 'stdio', command: 'npx', args: ['x'] },
      }, metadata);
      expect(response?.success).toBe(true);
    });
  });

  it('RegisterMcpServer validates transport requirements', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);

    const noTransport = await invokeUnary(service.RegisterMcpServer, { server_id: 'dyn' });
    expect(noTransport.error?.code).toBe(grpc.status.INVALID_ARGUMENT);

    const stdioNoCmd = await invokeUnary(service.RegisterMcpServer, {
      server_id: 'dyn',
      transport: { type: 'stdio' },
    });
    expect(stdioNoCmd.error?.message).toMatch(/requires a command/i);

    const httpNoUrl = await invokeUnary(service.RegisterMcpServer, {
      server_id: 'dyn',
      transport: { type: 'http' },
    });
    expect(httpNoUrl.error?.message).toMatch(/requires a url/i);

    const badType = await invokeUnary(service.RegisterMcpServer, {
      server_id: 'dyn',
      transport: { type: 'ftp', url: 'ftp://x' },
    });
    expect(badType.error?.message).toMatch(/Unknown transport type/i);
  });

  it('DeletePolicy returns NOT_FOUND for missing custom policy', async () => {
    mockLoadCustomPolicies.mockReturnValue({});
    const state = createMockState();
    const service = createServiceHandlers(state);
    const { error } = await invokeUnary(service.DeletePolicy, { name: 'missing' });
    expect(error?.code).toBe(grpc.status.NOT_FOUND);
  });

  it('GetConfig loads workspace config by path', async () => {
    mockLoadWorkspaceConfig.mockReturnValue({ providers: { ws: { engine: 'mock' } } });
    const state = createMockState();
    const service = createServiceHandlers(state);
    const { response } = await invokeUnary(service.GetConfig, { location: '/tmp/project' });
    expect(response?.path).toBe('/tmp/ws//tmp/project/config.yaml');
    expect(rpcField<{ providers?: Record<string, { engine?: string }> }>(response, 'config')?.providers?.ws?.engine).toBe('mock');
  });

  it('ReconnectMcpServer reconnects by server id', async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const state = createMockState({ mcpClientPool: { reconnect } });
    const service = createServiceHandlers(state);
    const missing = await invokeUnary(service.ReconnectMcpServer, {});
    expect(missing.error?.code).toBe(grpc.status.INVALID_ARGUMENT);
    const ok = await invokeUnary(service.ReconnectMcpServer, { server_id: 'dyn' });
    expect(ok.error).toBeNull();
    expect(reconnect).toHaveBeenCalledWith('dyn');
  });

  it('ListPolicies returns built-in policies', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);
    const { response } = await invokeUnary(service.ListPolicies, {});
    expect(rpcArray<{ name: string }>(response, 'policies').some((p) => p.name === 'precise')).toBe(true);
  });

  it('ListTools and GetProviderTemplates return registry and template data', async () => {
    const state = createMockState({
      toolRegistry: {
        getAll: vi.fn().mockReturnValue([{
          namespacedName: 'mcp:gh/search',
          description: 'search',
          inputSchema: '{}',
          source: 'gh',
        }]),
      },
    });
    const service = createServiceHandlers(state);
    const tools = await invokeUnary(service.ListTools, {});
    expect(rpcArray<{ name: string }>(tools.response, 'tools')[0]?.name).toBe('mcp:gh/search');

    const templates = await invokeUnary(service.GetProviderTemplates, {});
    expect(rpcArray<{ engine: string }>(templates.response, 'templates')[0]?.engine).toBe('mock');
  });

  it('VSCodeStream registers connection and handles register_tools notification', async () => {
    vi.useFakeTimers();
    try {
      const state = createMockState();
      const service = createAbbenayService(state);
      const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
      const call = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handlers[event] || [];
          handlers[event].push(handler);
        }),
        end: vi.fn(),
        write: vi.fn(),
      };

      service.VSCodeStream(call as never);
      expect(state.registerVSCodeConnection).toHaveBeenCalled();

      handlers.data?.[0]?.({ register_tools: { tools: [{ name: 't1' }] } });
      expect(state.handleRegisterToolsNotification).toHaveBeenCalledWith(
        'vscode-conn-1',
        { tools: [{ name: 't1' }] },
      );

      handlers.end?.[0]?.();
      expect(state.unregisterVSCodeConnection).toHaveBeenCalledWith('vscode-conn-1');
      expect(call.end).toHaveBeenCalled();

      handlers.error?.[0]?.(new Error('stream failed'));
      expect(state.unregisterVSCodeConnection).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(150);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ListEngines returns engine metadata', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);
    const { response } = await invokeUnary(service.ListEngines, {});
    expect(rpcArray<{ id: string }>(response, 'engines').some((e) => e.id === 'mock')).toBe(true);
  });

  it('WatchSessions ends immediately', () => {
    const state = createMockState();
    const service = createAbbenayService(state);
    const call = { end: vi.fn() };
    service.WatchSessions(call as never);
    expect(call.end).toHaveBeenCalled();
  });

  it('ListProviders and ListModels surface INTERNAL errors', async () => {
    const state = createMockState({
      listProviders: vi.fn().mockRejectedValue(new Error('providers down')),
      listModels: vi.fn().mockRejectedValue('models down'),
    });
    const service = createServiceHandlers(state);

    const providers = await invokeUnary(service.ListProviders, {});
    expect(providers.error?.code).toBe(grpc.status.INTERNAL);
    expect(providers.error?.message).toBe('providers down');

    const models = await invokeUnary(service.ListModels, {});
    expect(models.error?.code).toBe(grpc.status.INTERNAL);
    expect(models.error?.message).toBe('models down');
  });

  it('DiscoverModels resolves credentials, validates base_url, and maps errors', async () => {
    mockResolveProviderCredentials.mockResolvedValue({
      apiKey: 'resolved-key',
      baseUrl: 'http://provider.local',
    });
    mockDiscoverModels.mockResolvedValue([]);
    const state = createMockState();
    const service = createServiceHandlers(state);

    const ok = await invokeUnary(service.DiscoverModels, {
      engine_id: 'mock',
      provider_id: 'my-mock',
      base_url: 'http://provider.local',
    });
    expect(ok.error).toBeNull();
    expect(mockResolveProviderCredentials).toHaveBeenCalledWith('my-mock');
    expect(mockDiscoverModels).toHaveBeenCalledWith('mock', 'resolved-key', 'http://provider.local');

    mockValidateProviderEndpoint.mockReturnValueOnce({ ok: false as const, error: 'bad endpoint' });
    const badEndpoint = await invokeUnary(service.DiscoverModels, {
      engine_id: 'mock',
      base_url: 'ftp://bad',
    });
    expect(badEndpoint.error?.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(badEndpoint.error?.message).toBe('bad endpoint');

    mockDiscoverModels.mockRejectedValueOnce(Object.assign(new Error('custom'), { code: grpc.status.UNAVAILABLE }));
    const coded = await invokeUnary(service.DiscoverModels, { engine_id: 'mock' });
    expect(coded.error?.code).toBe(grpc.status.UNAVAILABLE);

    mockDiscoverModels.mockRejectedValueOnce('plain failure');
    const plain = await invokeUnary(service.DiscoverModels, { engine_id: 'mock' });
    expect(plain.error?.code).toBe(grpc.status.INTERNAL);
    expect(plain.error?.message).toBe('plain failure');
  });

  it('DiscoverModels logs authorized consumer', async () => {
    await withEnv('PROV_TOKEN', 'prov-tok', async () => {
      mockLoadConfig.mockReturnValue({
        providers: {},
        consumers: {
          prov: { token_env: 'PROV_TOKEN', capabilities: { providers: true } },
        },
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const state = createMockState();
      const service = createServiceHandlers(state);
      const metadata = new grpc.Metadata();
      metadata.add('x-abbenay-token', 'prov-tok');

      await invokeUnary(service.DiscoverModels, { engine_id: 'mock' }, metadata);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('providers authorized for consumer "prov"'));
      logSpy.mockRestore();
    });
  });

  it('Secrets RPCs surface INTERNAL errors', async () => {
    const state = createMockState({
      secretStore: {
        get: vi.fn().mockRejectedValue(new Error('get failed')),
        set: vi.fn().mockRejectedValue(new Error('set failed')),
        delete: vi.fn().mockRejectedValue(new Error('delete failed')),
        has: vi.fn().mockRejectedValue(new Error('has failed')),
      },
    });
    const service = createServiceHandlers(state);

    expect((await invokeUnary(service.GetSecret, { key: 'K' })).error?.message).toBe('get failed');
    expect((await invokeUnary(service.SetSecret, { key: 'K', value: 'v' })).error?.message).toBe('set failed');
    expect((await invokeUnary(service.DeleteSecret, { key: 'K' })).error?.message).toBe('delete failed');
    expect((await invokeUnary(service.ListSecrets, {})).error?.message).toBe('has failed');
  });

  it('GetConfig and UpdateConfig surface INTERNAL and validation errors', async () => {
    mockLoadConfig
      .mockReturnValueOnce({ providers: {} })
      .mockImplementationOnce(() => { throw new Error('config read failed'); });
    const state = createMockState();
    const service = createServiceHandlers(state);
    expect((await invokeUnary(service.GetConfig, { location: 'user' })).error?.message).toBe('config read failed');
    mockLoadConfig.mockReturnValue({ providers: {} });

    mockLoadConfig.mockReturnValue({ providers: {} });
    mockValidateConfigProviderEndpoints.mockReturnValueOnce({ ok: false as const, error: 'endpoint blocked' });
    const endpointFail = await invokeUnary(service.UpdateConfig, {
      location: 'user',
      config: configFileToProto({ providers: { mock: { engine: 'mock' } } }),
    });
    expect(endpointFail.error?.message).toBe('endpoint blocked');

    mockValidateConfigProviderEndpoints.mockReturnValue({ ok: true as const });
    mockLoadConfig.mockReturnValue({ providers: {}, server: { allowed_provider_hosts: ['localhost'] } });
    mockLoadWorkspaceConfig.mockReturnValue(null);
    const workspace = await invokeUnary(service.UpdateConfig, {
      location: '/tmp/project',
      config: configFileToProto({ providers: { ws: { engine: 'mock' } } }),
    });
    expect(workspace.error).toBeNull();
    expect(mockSaveWorkspaceConfig).toHaveBeenCalled();

    const refreshFail = vi.fn().mockRejectedValue(new Error('mcp refresh failed'));
    const refreshState = createMockState({ refreshMcpConnections: refreshFail });
    const refreshService = createServiceHandlers(refreshState);
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await invokeUnary(refreshService.UpdateConfig, {
      location: 'user',
      config: configFileToProto({ providers: { mock: { engine: 'mock' } } }),
    });
    await vi.waitFor(() => expect(refreshFail).toHaveBeenCalled());
    expect(logSpy).toHaveBeenCalledWith('[gRPC] MCP refresh after config change failed:', 'mcp refresh failed');
    logSpy.mockRestore();

    mockSaveConfig.mockImplementationOnce(() => { throw new Error('save failed'); });
    expect((await invokeUnary(service.UpdateConfig, {
      location: 'user',
      config: configFileToProto({ providers: { mock: { engine: 'mock' } } }),
    })).error?.message).toBe('save failed');
  });

  it('GetProviderStatus returns provider health and INTERNAL errors', async () => {
    const state = createMockState({
      listProviders: vi.fn()
        .mockResolvedValueOnce([{ id: 'mock', configured: true, healthy: false }])
        .mockRejectedValueOnce(new Error('status failed')),
    });
    const service = createServiceHandlers(state);

    const ok = await invokeUnary(service.GetProviderStatus, { provider_id: 'mock' });
    expect(ok.response?.healthy).toBe(false);

    const fail = await invokeUnary(service.GetProviderStatus, { provider_id: 'mock' });
    expect(fail.error?.message).toBe('status failed');
  });

  it('StartWebServer and StopWebServer surface INTERNAL errors', async () => {
    mockStartEmbeddedWebServer.mockRejectedValueOnce(new Error('bind failed'));
    const state = createMockState();
    const service = createServiceHandlers(state);
    expect((await invokeUnary(service.StartWebServer, {})).error?.message).toBe('Failed to start web server: bind failed');

    mockStopEmbeddedWebServer.mockRejectedValueOnce(new Error('stop failed'));
    expect((await invokeUnary(service.StopWebServer, {})).error?.message).toBe('stop failed');
  });

  it('Session RPCs cover proto mapping, filters, and error paths', async () => {
    const fullSession = {
      id: 'sess-full',
      model: 'mock/echo',
      title: 'Topic',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo', tool_calls: [{ id: 'tc1', name: 'search', arguments: '{}' }] },
        { role: 'tool', content: 'result', name: 'search', tool_call_id: 'tc1' },
        { role: 'unknown', content: 'fallback' },
      ],
      metadata: { k: 'v' },
      summary: 'sum',
      parentSessionId: 'parent',
      forkPoint: 2,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
    };
    const sessionStore = {
      create: vi.fn().mockRejectedValue(new Error('create failed')),
      getOwned: vi.fn()
        .mockResolvedValueOnce(fullSession)
        .mockRejectedValueOnce(new Error('not found')),
      list: vi.fn()
        .mockResolvedValueOnce({
          sessions: [{
            id: 'sess-full',
            model: 'mock/echo',
            title: 'Topic',
            messageCount: 5,
            summary: 'sum',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
          }],
          totalCount: 1,
        })
        .mockRejectedValueOnce(new Error('list failed')),
      deleteOwned: vi.fn()
        .mockRejectedValueOnce(new Error('delete failed')),
      appendMessage: vi.fn(),
      updateTitle: vi.fn(),
      updateSummary: vi.fn(),
    };
    const state = createMockState({
      sessionStore,
      toolRegistry: { getAll: vi.fn(), clearSessionScope: vi.fn() },
    });
    const service = createServiceHandlers(state);

    expect((await invokeUnary(service.CreateSession, { model: 'mock/echo' })).error?.message).toBe('create failed');

    const got = await invokeUnary(service.GetSession, { session_id: 'sess-full', include_messages: true });
    expect(got.response?.id).toBe('sess-full');
    expect(rpcArray<{ role: number }>(got.response, 'messages').map((m) => m.role)).toEqual([1, 2, 3, 4, 2]);

    expect((await invokeUnary(service.GetSession, { session_id: 'missing' })).error?.code).toBe(grpc.status.NOT_FOUND);
    expect((await invokeUnary(service.DeleteSession, {})).error?.code).toBe(grpc.status.INVALID_ARGUMENT);

    const listed = await invokeUnary(service.ListSessions, { model_filter: 'mock/echo', limit: -1, offset: -1 });
    expect(listed.response?.total_count).toBe(1);
    expect((await invokeUnary(service.ListSessions, {})).error?.message).toBe('list failed');
    expect((await invokeUnary(service.DeleteSession, { session_id: 'sess-full' })).error?.message).toBe('delete failed');
  });

  it('SummarizeSession generates summary and handles errors', async () => {
    const sessionStore = {
      getOwned: vi.fn()
        .mockResolvedValueOnce({
          id: 'sess-1',
          model: 'mock/echo',
          title: 't',
          messages: [{ role: 'user', content: 'hi' }, { role: 'user', content: 'again' }],
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        })
        .mockRejectedValueOnce(new Error('summarize failed')),
      updateSummary: vi.fn(),
    };
    mockGenerateSessionSummary.mockResolvedValueOnce('fresh summary');
    const state = createMockState({ sessionStore });
    const service = createServiceHandlers(state);

    const generated = await invokeUnary(service.SummarizeSession, {
      session_id: 'sess-1',
      summarize_model: 'mock/echo',
    });
    expect(generated.response?.summary).toBe('fresh summary');
    expect(generated.response?.from_cache).toBe(false);
    expect(sessionStore.updateSummary).toHaveBeenCalledWith('sess-1', 'fresh summary', 2);

    expect((await invokeUnary(service.SummarizeSession, {})).error?.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect((await invokeUnary(service.SummarizeSession, { session_id: 'sess-1' })).error?.message).toBe('summarize failed');
  });

  it('ListPolicies surfaces INTERNAL errors', async () => {
    vi.spyOn(policiesModule, 'listAllPolicies').mockImplementationOnce(() => { throw new Error('policy list failed'); });
    const state = createMockState();
    const service = createServiceHandlers(state);
    expect((await invokeUnary(service.ListPolicies, {})).error?.message).toBe('policy list failed');
  });

  it('CreatePolicy and DeletePolicy validate inputs and surface INTERNAL errors', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);

    expect((await invokeUnary(service.CreatePolicy, {})).error?.message).toBe('Policy name is required');
    expect((await invokeUnary(service.CreatePolicy, { name: 'custom' })).error?.message).toBe('Policy config is required');
    expect((await invokeUnary(service.DeletePolicy, {})).error?.message).toBe('Policy name is required');
    expect((await invokeUnary(service.DeletePolicy, { name: 'precise' })).error?.message).toMatch(/Cannot delete built-in/);

    vi.spyOn(policiesModule, 'loadCustomPolicies').mockImplementationOnce(() => { throw new Error('policy load failed'); });
    expect((await invokeUnary(service.CreatePolicy, {
      name: 'custom',
      config: { sampling: { temperature: 0.1 } },
    })).error?.message).toBe('policy load failed');

    vi.spyOn(policiesModule, 'loadCustomPolicies').mockImplementationOnce(() => { throw new Error('policy delete failed'); });
    mockLoadCustomPolicies.mockReturnValue({ custom: protoToPolicyConfig({ sampling: { temperature: 0.1 } }) });
    expect((await invokeUnary(service.DeletePolicy, { name: 'custom' })).error?.message).toBe('policy delete failed');
  });

  it('RegisterMcpServer maps connection failures', async () => {
    mockLoadConfig.mockReturnValue({ providers: {} });

    const pool = {
      applySecurityConfig: vi.fn(),
      connectDynamic: vi.fn()
        .mockRejectedValueOnce(new StdioSpawnApprovalDeniedError('spawn denied'))
        .mockRejectedValueOnce(new Error('already registered'))
        .mockRejectedValueOnce(new Error('server limit reached'))
        .mockRejectedValueOnce(new Error('connection refused')),
    };
    const errState = createMockState({ mcpClientPool: pool });
    const errService = createServiceHandlers(errState);

    expect((await invokeUnary(errService.RegisterMcpServer, {
      server_id: 'dyn',
      transport: { type: 'http', url: 'http://mcp.example.com' },
    })).error?.message).toBe('spawn denied');

    expect((await invokeUnary(errService.RegisterMcpServer, {
      server_id: 'dyn',
      transport: { type: 'http', url: 'http://mcp.example.com' },
    })).error?.code).toBe(grpc.status.ALREADY_EXISTS);

    expect((await invokeUnary(errService.RegisterMcpServer, {
      server_id: 'dyn',
      transport: { type: 'http', url: 'http://mcp.example.com' },
    })).error?.code).toBe(grpc.status.RESOURCE_EXHAUSTED);

    expect((await invokeUnary(errService.RegisterMcpServer, {
      server_id: 'dyn',
      transport: { type: 'http', url: 'http://mcp.example.com' },
    })).error?.code).toBe(grpc.status.FAILED_PRECONDITION);
  });

  it('UnregisterMcpServer validates, unregisters dynamic servers, and surfaces errors', async () => {
    const disconnect = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disconnect failed'));
    const state = createMockState({
      mcpClientPool: {
        getStatus: vi.fn()
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce({ source: 'dynamic', connected: true })
          .mockReturnValue({ source: 'dynamic', connected: true }),
        disconnect,
      },
    });
    const service = createServiceHandlers(state);

    expect((await invokeUnary(service.UnregisterMcpServer, {})).error?.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect((await invokeUnary(service.UnregisterMcpServer, { server_id: 'missing' })).error?.code).toBe(grpc.status.NOT_FOUND);

    const ok = await invokeUnary(service.UnregisterMcpServer, { server_id: 'dyn' });
    expect(ok.response?.success).toBe(true);
    expect(disconnect).toHaveBeenCalledWith('dyn');

    expect((await invokeUnary(service.UnregisterMcpServer, { server_id: 'dyn' })).error?.message).toBe('disconnect failed');
  });

  it('ConfigureProvider and RemoveProvider cover workspace and validation paths', async () => {
    const state = createMockState();
    const service = createServiceHandlers(state);

    expect((await invokeUnary(service.ConfigureProvider, { provider_id: 'Bad Name', engine: 'mock' })).error?.message)
      .toMatch(/lowercase alphanumeric/);
    expect((await invokeUnary(service.ConfigureProvider, {
      target: 'workspace',
      provider_id: 'ws-mock',
      engine: 'mock',
    })).error?.message).toMatch(/workspace_path is required/);
    expect((await invokeUnary(service.ConfigureProvider, { provider_id: 'new-prov' })).error?.message)
      .toMatch(/engine is required/);
    expect((await invokeUnary(service.ConfigureProvider, { provider_id: 'new-prov', engine: 'nope' })).error?.message)
      .toMatch(/unknown engine/);

    mockValidateProviderEndpoint.mockReturnValueOnce({ ok: false as const, error: 'invalid url' });
    expect((await invokeUnary(service.ConfigureProvider, {
      provider_id: 'my-mock',
      engine: 'mock',
      base_url: 'bad',
    })).error?.message).toBe('invalid url');

    mockLoadWorkspaceConfig.mockReturnValue({ providers: {} });
    const workspace = await invokeUnary(service.ConfigureProvider, {
      provider_id: 'ws-mock',
      engine: 'mock',
      env_var_name: 'WS_KEY',
      target: 'workspace',
      workspace_path: '/tmp/project',
    });
    expect(workspace.response?.success).toBe(true);
    expect(mockSaveWorkspaceConfig).toHaveBeenCalled();

    mockLoadConfig.mockReturnValue({
      providers: {
        mymock: { engine: 'mock', api_key_keychain_name: 'MYMOCK_API_KEY' },
      },
    });
    const removeWorkspace = await invokeUnary(service.RemoveProvider, {
      provider_id: 'mymock',
      target: 'workspace',
      workspace_path: '/tmp/project',
    });
    expect(removeWorkspace.error).toBeNull();
    expect(mockSaveWorkspaceConfig).toHaveBeenCalled();

    expect((await invokeUnary(service.RemoveProvider, {})).error?.message).toMatch(/provider_id is required/);
    expect((await invokeUnary(service.RemoveProvider, { target: 'workspace', provider_id: 'x' })).error?.message)
      .toMatch(/workspace_path is required/);

    const failingStore = {
      get: vi.fn(),
      set: vi.fn().mockRejectedValue(new Error('configure failed')),
      delete: vi.fn().mockRejectedValue(new Error('ignored')),
      has: vi.fn(),
    };
    const failState = createMockState({ secretStore: failingStore });
    const failService = createServiceHandlers(failState);
    expect((await invokeUnary(failService.ConfigureProvider, {
      provider_id: 'my-mock',
      engine: 'mock',
      api_key: 'secret',
    })).error?.message).toBe('configure failed');
  });

  it('GetKeyStatus, ListMcpServerConfigs, and ReconnectMcpServer surface INTERNAL errors', async () => {
    const state = createMockState({
      secretStore: { has: vi.fn().mockRejectedValue(new Error('key status failed')) },
      mcpClientPool: {
        getStatuses: vi.fn().mockImplementation(() => { throw new Error('status list failed'); }),
        reconnect: vi.fn().mockRejectedValue(new Error('reconnect failed')),
      },
    });
    const service = createServiceHandlers(state);

    expect((await invokeUnary(service.GetKeyStatus, { source: 'keychain', name: 'K' })).error?.message)
      .toBe('key status failed');
    expect((await invokeUnary(service.ListMcpServerConfigs, {})).error?.message).toBe('status list failed');
    expect((await invokeUnary(service.ReconnectMcpServer, { server_id: 'dyn' })).error?.message).toBe('reconnect failed');
  });

  it('Chat covers role mapping, tools, inline policy, and stream errors', async () => {
    async function* allChunks() {
      yield { type: 'tool' as const, name: 'calc', done: false, call: { params: { x: 1 } } };
      yield { type: 'error' as const, error: 'model failed' };
      yield { type: 'done' as const, finishReason: 'length' };
    }
    const chat = vi.fn().mockReturnValue(allChunks());
    const state = createMockState({ chat });
    const service = createAbbenayService(state);

    const { call, written } = makeWritableStreamCall({
      model: 'mock/echo',
      messages: [
        { role: 'ROLE_SYSTEM', content: 'sys' },
        { role: 3, content: 'assistant' },
        { role: 'ROLE_TOOL', content: 'tool out', name: 'calc' },
        { role: 99, content: 'default role' },
      ],
      tools: [{ name: '', description: 'skip' }, { name: 'calc', description: 'calc', input_schema: '{}' }],
      options: {
        temperature: 0.5,
        top_p: 0.9,
        top_k: 40,
        max_tokens: 100,
        timeout: 30,
        tool_mode: 'required',
        max_tool_iterations: 3,
        tool_filter: ['calc'],
      },
      policy: { sampling: { temperature: 0.2 } },
    });
    service.Chat(call as never);
    await vi.waitFor(() => expect(call.end).toHaveBeenCalled());
    expect(chat).toHaveBeenCalled();
    expect(written.some((c) => (c as { tool_call?: unknown }).tool_call)).toBe(true);
    expect(written.some((c) => (c as { error?: { message: string } }).error?.message === 'model failed')).toBe(true);
    expect(written.some((c) => (c as { done?: { finish_reason: string } }).done?.finish_reason === 'length')).toBe(true);

    const invalidPolicy = makeWritableStreamCall({
      model: 'mock/echo',
      messages: [{ role: 2, content: 'hi' }],
      policy: { output: { format: 'xml' } },
    });
    service.Chat(invalidPolicy.call as never);
    await vi.waitFor(() => expect(invalidPolicy.call.end).toHaveBeenCalled());
    expect(invalidPolicy.written[0]).toEqual({
      error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('Invalid inline policy') },
    });

    await withEnv('INLINE_TOKEN', 'inline-tok', async () => {
      mockLoadConfig.mockReturnValue({
        providers: {},
        consumers: {
          inline: { token_env: 'INLINE_TOKEN', capabilities: { inline_policy: true, chat: true } },
        },
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const authorized = makeWritableStreamCall({
        model: 'mock/echo',
        messages: [{ role: 2, content: 'hi' }],
        policy: { sampling: { temperature: 0.2 } },
      }, (() => {
        const metadata = new grpc.Metadata();
        metadata.add('x-abbenay-token', 'inline-tok');
        return metadata;
      })());
      service.Chat(authorized.call as never);
      await vi.waitFor(() => expect(authorized.call.end).toHaveBeenCalled());
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Inline policy authorized for consumer "inline"'));
      logSpy.mockRestore();
    });

    chat.mockImplementationOnce(() => { throw new Error('chat exploded'); });
    mockLoadConfig.mockReturnValue({ providers: {} });
    const failed = makeWritableStreamCall({
      model: 'mock/echo',
      messages: [{ role: 2, content: 'hi' }],
    });
    service.Chat(failed.call as never);
    await vi.waitFor(() => expect(failed.call.end).toHaveBeenCalled());
    expect(failed.written.some((c) => (c as { error?: { message: string } }).error?.message === 'chat exploded')).toBe(true);
  });

  it('SessionChat covers inline policy, tool lifecycle, and errors', async () => {
    async function* toolChunks() {
      yield { type: 'tool' as const, name: 'search', done: false, call: { params: { q: 'x' } } };
      yield {
        type: 'tool' as const,
        name: 'search',
        done: true,
        call: { params: { q: 'x' }, result: { ok: true } },
      };
      yield { type: 'error' as const, error: 'session model failed' };
    }
    const session = {
      id: 'sess-1',
      model: 'mock/echo',
      title: 'New Session',
      messages: [],
      metadata: {},
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    const sessionStore = {
      getOwned: vi.fn().mockResolvedValue(session),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      updateTitle: vi.fn().mockResolvedValue(undefined),
    };
    const state = createMockState({ chat: vi.fn().mockReturnValue(toolChunks()), sessionStore });
    const service = createAbbenayService(state);

    const invalidPolicy = makeWritableStreamCall({
      session_id: 'sess-1',
      message: { role: 2, content: 'hi' },
      policy: { output: { format: 'xml' } },
    });
    service.SessionChat(invalidPolicy.call as never);
    await vi.waitFor(() => expect(invalidPolicy.call.end).toHaveBeenCalled());
    expect(invalidPolicy.written[0]).toEqual({
      error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('Invalid inline policy') },
    });

    await withEnv('SESSION_INLINE', 'sess-inline', async () => {
      mockLoadConfig.mockReturnValue({
        providers: {},
        consumers: {
          inline: { token_env: 'SESSION_INLINE', capabilities: { inline_policy: true, chat: true } },
        },
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const metadata = new grpc.Metadata();
      metadata.add('x-abbenay-token', 'sess-inline');
      const { call, written } = makeWritableStreamCall({
        session_id: 'sess-1',
        message: { role: 'ROLE_USER', content: 'Find docs' },
        policy: { sampling: { temperature: 0.1 } },
        options: {
          temperature: 0.4,
          tool_mode: 'auto',
          max_tool_iterations: 2,
          tool_filter: ['search'],
        },
      }, metadata);
      service.SessionChat(call as never);
      await vi.waitFor(() => expect(call.end).toHaveBeenCalled());
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('SessionChat inline policy authorized'));
      expect(written.some((c) => (c as { tool_result?: unknown }).tool_result)).toBe(true);
      expect(sessionStore.appendMessage).toHaveBeenCalled();
      logSpy.mockRestore();
    });

    sessionStore.getOwned.mockRejectedValueOnce(new Error('session missing'));
    mockLoadConfig.mockReturnValue({ providers: {} });
    const failed = makeWritableStreamCall({
      session_id: 'sess-1',
      message: { role: 2, content: 'oops' },
    });
    service.SessionChat(failed.call as never);
    await vi.waitFor(() => expect(failed.call.end).toHaveBeenCalled());
    expect(failed.written.some((c) => (c as { error?: { message: string } }).error?.message === 'session missing')).toBe(true);
  });

  it('SessionChat denies inline policy without capability', async () => {
    mockLoadConfig.mockReturnValue({
      providers: {},
      consumers: {
        limited: { token_env: 'NO_INLINE', capabilities: { chat: true } },
      },
    });
    await withEnv('NO_INLINE', 'tok', async () => {
      const state = createMockState();
      const service = createAbbenayService(state);
      const metadata = new grpc.Metadata();
      metadata.add('x-abbenay-token', 'tok');
      const { call, written } = makeWritableStreamCall({
        session_id: 'sess-1',
        message: { role: 2, content: 'hi' },
        policy: { sampling: { temperature: 0.2 } },
      }, metadata);
      service.SessionChat(call as never);
      await vi.waitFor(() => expect(call.end).toHaveBeenCalled());
      expect(written[0]).toEqual({
        error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Inline policy') },
      });
    });
  });

  it('SessionChat emits tool_call when only completed tool event arrives', async () => {
    async function* doneOnlyTool() {
      yield {
        type: 'tool' as const,
        name: 'lookup',
        done: true,
        call: { params: { q: 'x' }, result: 'plain-text-result' },
      };
      yield { type: 'done' as const, finishReason: 'stop' };
    }
    const sessionStore = {
      getOwned: vi.fn().mockResolvedValue({
        id: 'sess-1',
        model: 'mock/echo',
        title: 'New Session',
        messages: [],
        metadata: {},
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      }),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      updateTitle: vi.fn().mockResolvedValue(undefined),
    };
    const state = createMockState({ chat: vi.fn().mockReturnValue(doneOnlyTool()), sessionStore });
    const service = createAbbenayService(state);
    const { call, written } = makeWritableStreamCall({
      session_id: 'sess-1',
      message: { role: 2, content: 'search' },
    });
    service.SessionChat(call as never);
    await vi.waitFor(() => expect(call.end).toHaveBeenCalled());
    expect(written.some((c) => (c as { tool_call?: { name: string } }).tool_call?.name === 'lookup')).toBe(true);
    expect(written.some((c) => (c as { tool_result?: { content: string } }).tool_result?.content === 'plain-text-result')).toBe(true);
  });

  it('RemoveProvider saves workspace config and surfaces INTERNAL errors', async () => {
    mockLoadWorkspaceConfig.mockReturnValue({
      providers: {
        wsprov: { engine: 'mock', api_key_keychain_name: 'WSPROV_API_KEY' },
      },
    });
    const state = createMockState();
    const service = createServiceHandlers(state);
    const ok = await invokeUnary(service.RemoveProvider, {
      provider_id: 'wsprov',
      target: 'workspace',
      workspace_path: '/tmp/project',
    });
    expect(ok.error).toBeNull();
    expect(mockSaveWorkspaceConfig).toHaveBeenCalledWith('/tmp/project', { providers: {} });

    mockLoadConfig.mockReturnValue({
      providers: { mymock: { engine: 'mock' } },
    });
    mockSaveConfig.mockImplementationOnce(() => { throw 'remove failed'; });
    const fail = await invokeUnary(service.RemoveProvider, { provider_id: 'mymock' });
    expect(fail.error?.code).toBe(grpc.status.INTERNAL);
    expect(fail.error?.message).toBe('remove failed');
  });

  it('covers camelCase proto fields and remaining status branches', async () => {
    const state = createMockState({
      listModels: vi.fn().mockResolvedValue([]),
      getClients: vi.fn().mockReturnValue([
        { clientId: 'vscode', clientType: ClientType.VSCODE, connectedAt: new Date(), isSpawner: true },
        { clientId: 'other', clientType: 'OTHER', connectedAt: new Date(), isSpawner: false },
      ]),
      listProviders: vi.fn().mockResolvedValue([{ id: 'mock', configured: true, healthy: true }]),
      chat: vi.fn().mockReturnValue((async function* () {
        yield {
          type: 'tool' as const,
          name: 'x',
          done: true,
          call: { params: { a: 1 }, result: { ok: true } },
        };
        yield { type: 'done' as const, finishReason: 'stop' };
      })()),
      sessionStore: {
        create: vi.fn().mockResolvedValue({
          id: 'sess-1',
          model: 'mock/echo',
          title: 'New Session',
          messages: [],
          metadata: {},
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        }),
        getOwned: vi.fn().mockResolvedValue({
          id: 'sess-1',
          model: 'mock/echo',
          title: 'New Session',
          messages: [],
          metadata: {},
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        }),
        list: vi.fn().mockResolvedValue({ sessions: [], totalCount: 0 }),
        deleteOwned: vi.fn().mockResolvedValue(undefined),
        appendMessage: vi.fn().mockResolvedValue(undefined),
        updateTitle: vi.fn().mockResolvedValue(undefined),
        updateSummary: vi.fn().mockResolvedValue(undefined),
      },
      mcpClientPool: {
        getStatuses: vi.fn().mockReturnValue([
          { id: 'cfg-disc', connected: false, toolCount: 0, config: { transport: 'stdio', enabled: true } },
          { id: 'cfg-live', connected: true, toolCount: 3, config: { transport: 'stdio', enabled: true } },
          { id: 'dyn-err', connected: false, error: 'down', toolCount: 0, config: { transport: 'http', enabled: true } },
          { id: 'dyn-ok', connected: true, toolCount: 1, config: { transport: 'http', enabled: true } },
        ]),
        getStatus: vi.fn(),
        disconnect: vi.fn().mockResolvedValue(undefined),
        disconnectByScope: vi.fn().mockResolvedValue(undefined),
        reconnect: vi.fn().mockResolvedValue(undefined),
        connectDynamic: vi.fn().mockResolvedValue(['tool-a']),
        applySecurityConfig: vi.fn(),
      },
    });
    mockLoadConfig.mockReturnValue({
      mcp_servers: {
        'cfg-off': { transport: 'stdio', command: 'x', enabled: false },
        'cfg-new': { transport: 'stdio', command: 'y', enabled: true },
        'cfg-live': { transport: 'stdio', command: 'z', enabled: true },
      },
    });
    const service = createServiceHandlers(state);

    const cliReg = await invokeUnary(service.Register, { client_type: 'CLIENT_TYPE_CLI', is_spawner: true });
    const nodeReg = await invokeUnary(service.Register, { client_type: 'CLIENT_TYPE_NODEJS', is_spawner: false });
    expect(cliReg.error).toBeNull();
    expect(nodeReg.error).toBeNull();
    expect(state.registerClient).toHaveBeenCalledTimes(2);

    const models = await invokeUnary(service.ListModels, { workspacePaths: ['/ws'] });
    expect(models.error).toBeNull();
    expect(state.listModels).toHaveBeenCalledWith(['/ws']);

    const status = await invokeUnary(service.GetStatus, {});
    expect(rpcArray<{ client_type: number }>(status.response, 'clients').map((c) => c.client_type)).toEqual([1, 0]);

    const chatCall = makeWritableStreamCall({
      model: 'mock/echo',
      messages: [{
        role: 2,
        content: 'hi',
        toolCallId: 'tc1',
        toolCalls: [{ id: 'tc1', name: 'x', arguments: '{}' }],
      }],
      tools: [{ name: 'x', description: 'x', inputSchema: '{}' }],
      options: {
        toolMode: 'auto',
        maxToolIterations: 2,
        toolFilter: ['x'],
        maxTokens: 10,
        topK: 1,
      },
    });
    createAbbenayService(state).Chat(chatCall.call as never);
    await vi.waitFor(() => expect(chatCall.call.end).toHaveBeenCalled());

    mockGenerateSessionSummary.mockResolvedValueOnce('generated');
    const summarize = await invokeUnary(service.SummarizeSession, {
      sessionId: 'sess-1',
      summarizeModel: 'mock/fast',
    });
    expect(summarize.error).toBeNull();
    expect(mockGenerateSessionSummary).toHaveBeenCalled();
    expect(state.sessionStore.updateSummary).toHaveBeenCalledWith('sess-1', 'generated', expect.any(Number));

    const getSession = await invokeUnary(service.GetSession, {
      sessionId: 'sess-1',
      includeMessages: false,
    });
    expect(getSession.error).toBeNull();
    expect(state.sessionStore.getOwned).toHaveBeenCalledWith('sess-1', expect.any(String), false);

    const listSessions = await invokeUnary(service.ListSessions, { modelFilter: 'mock/echo' });
    expect(listSessions.error).toBeNull();
    expect(state.sessionStore.list).toHaveBeenCalledWith(expect.objectContaining({ model: 'mock/echo' }));

    const deleteSession = await invokeUnary(service.DeleteSession, { sessionId: 'sess-1' });
    expect(deleteSession.error).toBeNull();
    expect(state.sessionStore.deleteOwned).toHaveBeenCalledWith('sess-1', expect.any(String));

    const reconnect = await invokeUnary(service.ReconnectMcpServer, { serverId: 'dyn-ok' });
    expect(reconnect.error).toBeNull();
    expect(state.mcpClientPool.reconnect).toHaveBeenCalledWith('dyn-ok');

    const configure = await invokeUnary(service.ConfigureProvider, {
      providerId: 'my-mock',
      engine: 'mock',
      apiKey: 'k',
      baseUrl: 'http://localhost',
      target: 'workspace',
      workspacePath: '/tmp/project',
    });
    expect(configure.error).toBeNull();
    expect(mockSaveWorkspaceConfig).toHaveBeenCalled();

    const remove = await invokeUnary(service.RemoveProvider, {
      providerId: 'my-mock',
      target: 'workspace',
      workspacePath: '/tmp/project',
    });
    expect(remove.error).toBeNull();
    expect(mockSaveWorkspaceConfig).toHaveBeenCalledWith('/tmp/project', expect.any(Object));

    const mcp = await invokeUnary(service.ListMcpServerConfigs, {});
    const byId = Object.fromEntries(rpcArray<{ id: string; status: string }>(mcp.response, 'mcp_servers').map((s) => [s.id, s]));
    expect(byId['cfg-off'].status).toBe('disabled');
    expect(byId['cfg-new'].status).toBe('not started');
    expect(byId['cfg-disc'].status).toBe('disconnected');
    expect(byId['cfg-live'].status).toBe('connected');
    expect(byId['dyn-err'].status).toBe('error');
    expect(byId['dyn-ok'].status).toBe('connected');
  });

  it('covers transport variants and chat branches', async () => {
    const state = createMockState({
      listProviders: vi.fn().mockRejectedValue('providers string error'),
      secretStore: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        has: vi.fn().mockResolvedValue(false),
      },
      chat: vi.fn().mockReturnValue((async function* () {
        yield {
          type: 'tool' as const,
          name: 'fmt',
          done: true,
          call: { params: { x: 1 }, result: 'string-result' },
        };
        yield { type: 'done' as const };
      })()),
    });
    const service = createServiceHandlers(state, DEFAULT_CONSUMER_AUTH_CONTEXT);

    const providers = await invokeUnary(service.ListProviders, {});
    expect(providers.error?.message).toBe('providers string error');

    mockLoadConfig.mockReturnValue({ providers: {} });
    const sse = await invokeUnary(service.RegisterMcpServer, {
      server_id: 'sse-srv',
      transport: { type: 'sse', url: 'http://mcp.example/sse' },
    });
    expect(sse.response?.success).toBe(true);

    const stdio = await invokeUnary(service.RegisterMcpServer, {
      server_id: 'stdio-srv',
      transport: { type: 'stdio', command: 'node', env: { FOO: 'bar' } },
    });
    expect(stdio.response?.success).toBe(true);

    const chatService = createAbbenayService(state);
    const { call, written } = makeWritableStreamCall({
      model: 'mock/echo',
      messages: [
        { role: 1, content: 'system' },
        { role: 4, content: 'tool', name: 'fmt' },
      ],
      tools: [{ description: 'no name' }],
    });
    chatService.Chat(call as never);
    await vi.waitFor(() => expect(call.end).toHaveBeenCalled());
    expect(written.some((c) => (c as { tool_result?: { content: string } }).tool_result?.content === 'string-result')).toBe(true);

    mockLoadConfig.mockReturnValue({
      providers: {},
      consumers: {
        chatter: { token_env: 'CHAT_TOKEN', capabilities: { chat: true } },
      },
    });
    const streamDenied = makeWritableStreamCall({
      model: 'mock/echo',
      messages: [{ role: 2, content: 'hi' }],
    });
    createAbbenayService(state, DEFAULT_CONSUMER_AUTH_CONTEXT).Chat(streamDenied.call as never);
    await vi.waitFor(() => expect(streamDenied.call.emit).toHaveBeenCalledWith('error', expect.any(Error)));
  });

  it('VSCodeStream requests workspace/tools and routes generic responses', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const requestWorkspace = vi.fn()
        .mockRejectedValueOnce(new Error('workspace failed'))
        .mockResolvedValue({ workspacePath: '/ws', workspaceFolders: ['/ws'] });
      const requestVSCodeTools = vi.fn().mockRejectedValue(new Error('tools failed'));
      const state = createMockState({ requestWorkspace, requestVSCodeTools });
      const service = createAbbenayService(state);
      const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
      const call = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handlers[event] || [];
          handlers[event].push(handler);
        }),
        end: vi.fn(),
        write: vi.fn(),
      };

      service.VSCodeStream(call as never);

      handlers.data?.[0]?.({ ping: true });
      expect(state.handleVSCodeResponse).toHaveBeenCalledWith('vscode-conn-1', { ping: true });

      await vi.advanceTimersByTimeAsync(100);
      expect(errorSpy).toHaveBeenCalledWith('[gRPC] Failed to get workspace from VS Code: workspace failed');

      service.VSCodeStream(call as never);
      await vi.advanceTimersByTimeAsync(100);
      expect(warnSpy).toHaveBeenCalledWith('[gRPC] Failed to get VS Code tools: tools failed');
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
