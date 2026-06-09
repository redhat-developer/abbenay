import { DaemonClient } from '../../daemon/client';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function createMockDaemonClient(overrides: Record<string, any> = {}): DaemonClient {
  const defaults: Record<string, any> = {
    listProviders: async () => [],
    listModels: async () => [],
    listEngines: async () => [],
    listSessions: async () => [],
    listSecrets: async () => [],
    getProviderTemplates: async () => [],
    discoverModels: async () => [],
    configureProvider: async () => ({}),
    removeProvider: async () => {},
    setSecret: async () => {},
    deleteSecret: async () => {},
    getKeyStatus: async () => false,
    getConfig: async () => ({ config: {}, path: '' }),
    updateConfig: async () => ({ config: {}, path: '' }),
    createSession: async () => ({
      id: 'test-session',
      model: 'test/model',
      topic: 'Test',
      messages: [],
      messageCount: 0,
      createdBy: '',
      createdAt: undefined,
      updatedAt: undefined,
      metadata: {},
    }),
    deleteSession: async () => {},
    getSession: async () => ({
      id: 'test-session',
      model: 'test/model',
      topic: 'Test',
      messages: [],
      messageCount: 0,
      createdBy: '',
      createdAt: undefined,
      updatedAt: undefined,
      metadata: {},
    }),
  };

  return { ...defaults, ...overrides } as unknown as DaemonClient;
}
