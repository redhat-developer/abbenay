/**
 * Unit tests for gRPC consumer authorization (DR-037).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import * as crypto from 'node:crypto';
import {
  authorizeConsumer,
  assertConsumersConfiguredForBind,
  buildConsumerAuthContext,
  hasConfiguredConsumers,
  matchConsumerByToken,
  resolveAllowOpenAuth,
  timingSafeEqualString,
  ConsumerAuthBindError,
  DEFAULT_CONSUMER_AUTH_CONTEXT,
  type ConsumerCapability,
} from './consumer-auth.js';
import type { ConfigFile } from '../../core/config.js';

function mockGrpcCall(token?: string): { metadata: grpc.Metadata } {
  const metadata = new grpc.Metadata();
  if (token) {
    metadata.add('x-abbenay-token', token);
  }
  return { metadata };
}

const ALL_CAPS: Record<ConsumerCapability, boolean> = {
  inline_policy: true,
  mcp_register: true,
  secrets: true,
  config: true,
  providers: true,
  shutdown: true,
  chat: true,
};

function withEnv(key: string, value: string, fn: () => void): void {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

describe('timingSafeEqualString', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqualString('secret', 'secret')).toBe(true);
  });

  it('returns false for unequal same-length strings', () => {
    expect(timingSafeEqualString('secret', 'secreX')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(timingSafeEqualString('short', 'longer-token')).toBe(false);
  });

  it('compares equal-length buffers without throwing (timing-safe path)', () => {
    // Implementation calls crypto.timingSafeEqual when lengths match.
    // ESM prevents spying on crypto exports; assert behavioral contract instead.
    expect(timingSafeEqualString('same-len!', 'same-len!')).toBe(true);
    expect(timingSafeEqualString('same-len!', 'same-len?')).toBe(false);
    expect(typeof crypto.timingSafeEqual).toBe('function');
  });
});

describe('hasConfiguredConsumers / resolveAllowOpenAuth / buildConsumerAuthContext', () => {
  it('detects missing and empty consumers', () => {
    expect(hasConfiguredConsumers(null)).toBe(false);
    expect(hasConfiguredConsumers({ providers: {} })).toBe(false);
    expect(hasConfiguredConsumers({ consumers: {} })).toBe(false);
    expect(hasConfiguredConsumers({
      consumers: { apme: { token_env: 'T', capabilities: {} } },
    })).toBe(true);
  });

  it('resolves open auth from flags and env', () => {
    expect(resolveAllowOpenAuth({})).toBe(false);
    expect(resolveAllowOpenAuth({ allowOpenAuth: true })).toBe(true);
    expect(resolveAllowOpenAuth({ insecure: true })).toBe(true);
    expect(resolveAllowOpenAuth({ env: { ABBENAY_ALLOW_OPEN_AUTH: '1' } })).toBe(true);
    expect(resolveAllowOpenAuth({ env: { ABBENAY_ALLOW_OPEN_AUTH: 'true' } })).toBe(true);
    expect(resolveAllowOpenAuth({ env: { ABBENAY_ALLOW_OPEN_AUTH: '0' } })).toBe(false);
  });

  it('builds loopback-only context without TCP port', () => {
    expect(buildConsumerAuthContext({})).toEqual({
      loopbackOnly: true,
      allowOpenAuth: false,
    });
  });

  it('marks non-loopback TCP as not loopback-only', () => {
    expect(buildConsumerAuthContext({
      grpcPort: 50051,
      grpcHost: '0.0.0.0',
    })).toEqual({ loopbackOnly: false, allowOpenAuth: false });

    expect(buildConsumerAuthContext({
      grpcPort: 50051,
      grpcHost: '127.0.0.1',
    })).toEqual({ loopbackOnly: true, allowOpenAuth: false });
  });
});

describe('assertConsumersConfiguredForBind', () => {
  it('allows loopback without consumers', () => {
    expect(() =>
      assertConsumersConfiguredForBind('127.0.0.1', {}, { allowOpenAuth: false }),
    ).not.toThrow();
  });

  it('refuses non-loopback without consumers and without open auth', () => {
    expect(() =>
      assertConsumersConfiguredForBind('0.0.0.0', { providers: {} }, { allowOpenAuth: false }),
    ).toThrow(ConsumerAuthBindError);
    expect(() =>
      assertConsumersConfiguredForBind('0.0.0.0', { consumers: {} }, { allowOpenAuth: false }),
    ).toThrow(/consumers|--allow-open-auth|--insecure/);
  });

  it('allows non-loopback with configured consumers', () => {
    expect(() =>
      assertConsumersConfiguredForBind(
        '0.0.0.0',
        { consumers: { apme: { token_env: 'T', capabilities: { chat: true } } } },
        { allowOpenAuth: false },
      ),
    ).not.toThrow();
  });

  it('allows non-loopback without consumers when open auth is explicit', () => {
    expect(() =>
      assertConsumersConfiguredForBind('0.0.0.0', {}, { allowOpenAuth: true }),
    ).not.toThrow();
  });
});

describe('matchConsumerByToken', () => {
  afterEach(() => {
    delete process.env.TEST_CONSUMER_TOKEN;
  });

  it('matches with timing-safe compare', () => {
    process.env.TEST_CONSUMER_TOKEN = 'tok-abc';
    const config: ConfigFile = {
      consumers: {
        apme: { token_env: 'TEST_CONSUMER_TOKEN', capabilities: { chat: true } },
      },
    };
    expect(matchConsumerByToken(config, 'tok-abc')).toBe('apme');
    expect(matchConsumerByToken(config, 'wrong')).toBeUndefined();
    expect(matchConsumerByToken(config, undefined)).toBeUndefined();
  });
});

describe('authorizeConsumer', () => {
  afterEach(() => {
    delete process.env.TEST_TOKEN;
  });

  it('allows when no consumers on localhost (default-open local DX)', () => {
    const result = authorizeConsumer(
      mockGrpcCall(),
      { providers: {} },
      'secrets',
      DEFAULT_CONSUMER_AUTH_CONTEXT,
    );
    expect(result.allowed).toBe(true);
  });

  it('allows when consumers section is empty on localhost', () => {
    const result = authorizeConsumer(
      mockGrpcCall(),
      { providers: {}, consumers: {} },
      'shutdown',
      { loopbackOnly: true, allowOpenAuth: false },
    );
    expect(result.allowed).toBe(true);
  });

  it('denies when consumers empty on non-localhost without open auth', () => {
    const result = authorizeConsumer(
      mockGrpcCall(),
      { providers: {} },
      'secrets',
      { loopbackOnly: false, allowOpenAuth: false },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/beyond localhost|consumers/i);
  });

  it('allows empty consumers on non-localhost with open auth', () => {
    const result = authorizeConsumer(
      mockGrpcCall(),
      { providers: {} },
      'secrets',
      { loopbackOnly: false, allowOpenAuth: true },
    );
    expect(result.allowed).toBe(true);
  });

  it('rejects when consumers configured but no token provided', () => {
    withEnv('TEST_TOKEN', 'secret123', () => {
      const result = authorizeConsumer(mockGrpcCall(), {
        consumers: {
          apme: { token_env: 'TEST_TOKEN', capabilities: { inline_policy: true } },
        },
      }, 'inline_policy');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('x-abbenay-token');
    });
  });

  it('rejects wrong token', () => {
    withEnv('TEST_TOKEN', 'secret123', () => {
      const result = authorizeConsumer(mockGrpcCall('wrong-token'), {
        consumers: {
          apme: { token_env: 'TEST_TOKEN', capabilities: { secrets: true } },
        },
      }, 'secrets');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not recognized');
    });
  });

  it('allows when token matches with required capability', () => {
    withEnv('TEST_TOKEN', 'secret123', () => {
      const result = authorizeConsumer(mockGrpcCall('secret123'), {
        consumers: {
          apme: { token_env: 'TEST_TOKEN', capabilities: { secrets: true } },
        },
      }, 'secrets');
      expect(result.allowed).toBe(true);
      expect(result.consumer).toBe('apme');
    });
  });

  it('capability matrix: deny when capability missing', () => {
    withEnv('TEST_TOKEN', 'secret123', () => {
      const cases: ConsumerCapability[] = [
        'secrets', 'config', 'providers', 'shutdown', 'chat', 'mcp_register', 'inline_policy',
      ];
      for (const capability of cases) {
        const result = authorizeConsumer(mockGrpcCall('secret123'), {
          consumers: {
            limited: { token_env: 'TEST_TOKEN', capabilities: {} },
          },
        }, capability);
        expect(result.allowed, capability).toBe(false);
      }
    });
  });

  it('capability matrix: allow each capability independently', () => {
    withEnv('TEST_TOKEN', 'secret123', () => {
      const cases: ConsumerCapability[] = [
        'secrets', 'config', 'providers', 'shutdown', 'chat', 'mcp_register', 'inline_policy',
      ];
      for (const capability of cases) {
        const result = authorizeConsumer(mockGrpcCall('secret123'), {
          consumers: {
            apme: {
              token_env: 'TEST_TOKEN',
              capabilities: { [capability]: true },
            },
          },
        }, capability);
        expect(result.allowed, capability).toBe(true);
        expect(result.consumer).toBe('apme');
      }
    });
  });

  it('allows full-capability consumer for all gated ops', () => {
    withEnv('TEST_TOKEN', 'full-token', () => {
      for (const capability of Object.keys(ALL_CAPS) as ConsumerCapability[]) {
        const result = authorizeConsumer(mockGrpcCall('full-token'), {
          consumers: {
            admin: { token_env: 'TEST_TOKEN', capabilities: { ...ALL_CAPS } },
          },
        }, capability);
        expect(result.allowed, capability).toBe(true);
      }
    });
  });

  it('rejects secrets when consumer only has chat', () => {
    withEnv('TEST_TOKEN', 't', () => {
      const result = authorizeConsumer(mockGrpcCall('t'), {
        consumers: {
          chatter: { token_env: 'TEST_TOKEN', capabilities: { chat: true } },
        },
      }, 'secrets');
      expect(result.allowed).toBe(false);
    });
  });

  it('rejects shutdown when consumer only has config', () => {
    withEnv('TEST_TOKEN', 't', () => {
      const result = authorizeConsumer(mockGrpcCall('t'), {
        consumers: {
          cfg: { token_env: 'TEST_TOKEN', capabilities: { config: true } },
        },
      }, 'shutdown');
      expect(result.allowed).toBe(false);
    });
  });
});
