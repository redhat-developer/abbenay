import * as assert from 'assert';
import {
  normalizeDaemonAddress,
  readDaemonConnectionConfig,
  resolveDaemonToken,
  describeConnectionMode,
  affectsDaemonConnection,
  dashboardUrlFromDaemonAddress,
  dashboardUrlForConnection,
  dashboardPortForMode,
  DEFAULT_DASHBOARD_PORT,
  EMBEDDED_DASHBOARD_PORT,
  GRPC_TLS_DEFAULT_CN,
  DAEMON_TOKEN_SECRET_KEY,
  DaemonConnectionConfig,
} from '../../daemon/connection-config';

function fakeConfig(values: Record<string, unknown>): {
  get<T>(key: string): T | undefined;
} {
  return {
    get<T>(key: string): T | undefined {
      return values[key] as T | undefined;
    },
  };
}

suite('connection-config', () => {
  test('normalizeDaemonAddress trims and strips URL schemes', () => {
    assert.strictEqual(normalizeDaemonAddress('  127.0.0.1:50051  '), '127.0.0.1:50051');
    assert.strictEqual(normalizeDaemonAddress('http://127.0.0.1:50051'), '127.0.0.1:50051');
    assert.strictEqual(normalizeDaemonAddress('https://host:50051/path'), 'host:50051');
    assert.strictEqual(normalizeDaemonAddress('grpc://127.0.0.1:50051'), '127.0.0.1:50051');
    assert.strictEqual(normalizeDaemonAddress('tcp://host:50051'), 'host:50051');
    assert.strictEqual(normalizeDaemonAddress('[::1]:50051'), '[::1]:50051');
    assert.strictEqual(normalizeDaemonAddress(''), undefined);
    assert.strictEqual(normalizeDaemonAddress('   '), undefined);
    assert.strictEqual(normalizeDaemonAddress('unix:///tmp/daemon.sock'), undefined);
    assert.strictEqual(normalizeDaemonAddress('hostname'), undefined);
    // Userinfo must be rejected (with or without a URL scheme).
    assert.strictEqual(normalizeDaemonAddress('https://user:secret@host:50051'), undefined);
    assert.strictEqual(normalizeDaemonAddress('user:secret@host:50051'), undefined);
    // HTTP dashboard port is never a gRPC target (IPv4 and IPv6).
    assert.strictEqual(normalizeDaemonAddress('http://127.0.0.1:8787'), undefined);
    assert.strictEqual(normalizeDaemonAddress('127.0.0.1:8787'), undefined);
    assert.strictEqual(normalizeDaemonAddress('[::1]:8787'), undefined);
  });

  test('dashboard port selection reserves a distinct embedded port and leaves local defaults unspecified', () => {
    assert.strictEqual(dashboardPortForMode('embedded'), EMBEDDED_DASHBOARD_PORT);
    assert.notStrictEqual(EMBEDDED_DASHBOARD_PORT, DEFAULT_DASHBOARD_PORT);
    assert.strictEqual(dashboardPortForMode('auto'), 0);
    assert.strictEqual(dashboardPortForMode('standalone'), 0);
  });

  test('dashboardUrlForConnection preserves daemon-reported ports for remote and local daemons', () => {
    assert.strictEqual(
      dashboardUrlForConnection(
        { isRemote: true, address: 'daemon.example:50051' },
        'https://localhost:3000',
      ),
      'https://daemon.example:3000',
    );
    assert.strictEqual(
      dashboardUrlForConnection(
        { isRemote: false, address: undefined },
        'http://localhost:3000',
      ),
      'http://localhost:3000',
    );
    assert.strictEqual(
      dashboardUrlForConnection({ isRemote: true, address: undefined }, 'http://localhost:3000'),
      'http://localhost:3000',
    );
    assert.strictEqual(
      dashboardUrlForConnection(
        { isRemote: true, address: 'daemon.example:50051' },
        'http://localhost:80',
      ),
      'http://daemon.example',
    );
    assert.strictEqual(
      dashboardUrlForConnection(
        { isRemote: true, address: 'daemon.example:50051' },
        'http://localhost',
      ),
      'http://daemon.example',
    );
    assert.strictEqual(
      dashboardUrlForConnection(
        { isRemote: true, address: 'daemon.example:50051' },
        'http://localhost:80',
      ),
      'http://daemon.example',
    );
    assert.strictEqual(
      dashboardUrlForConnection(
        { isRemote: true, address: 'daemon.example:50051' },
        'http://localhost:3000',
      ),
      'http://daemon.example:3000',
    );
    assert.strictEqual(
      dashboardUrlForConnection({ isRemote: true, address: 'daemon.example:50051' }, 'not a url'),
      'not a url',
    );
  });

  test('dashboardUrlFromDaemonAddress uses host:8787', () => {
    assert.strictEqual(
      dashboardUrlFromDaemonAddress('127.0.0.1:50051'),
      'http://127.0.0.1:8787',
    );
    assert.strictEqual(
      dashboardUrlFromDaemonAddress('[::1]:50051'),
      'http://[::1]:8787',
    );
    assert.strictEqual(dashboardUrlFromDaemonAddress(undefined), undefined);
  });

  test('readDaemonConnectionConfig defaults to auto and preserves address-based remote connection', () => {
    const cfg = readDaemonConnectionConfig(fakeConfig({ daemonAddress: '127.0.0.1:50051' }) as never);
    assert.strictEqual(cfg.mode, 'auto');
    assert.strictEqual(cfg.isRemote, true);
    assert.strictEqual(describeConnectionMode(cfg), 'remote:127.0.0.1:50051 (tls)');
  });

  test('readDaemonConnectionConfig local when address empty', () => {
    const cfg = readDaemonConnectionConfig(fakeConfig({
      daemonMode: 'auto',
      daemonAddress: '',
      daemonTls: true,
    }) as never);

    assert.strictEqual(cfg.mode, 'auto');
    assert.strictEqual(cfg.isRemote, false);
    assert.strictEqual(cfg.address, undefined);
    assert.strictEqual(cfg.tls, false);
    assert.strictEqual(describeConnectionMode(cfg), 'local:auto');
  });

  test('disabled mode never becomes remote even if an address is configured', () => {
    const cfg = readDaemonConnectionConfig(fakeConfig({
      daemonMode: 'disabled',
      daemonAddress: '127.0.0.1:50051',
      daemonTls: true,
    }) as never);
    assert.strictEqual(cfg.mode, 'disabled');
    assert.strictEqual(cfg.isRemote, false);
    assert.strictEqual(cfg.tls, false);
    assert.strictEqual(describeConnectionMode(cfg), 'disabled');
  });

  test('explicit remote mode requires an address even when empty', () => {
    const cfg = readDaemonConnectionConfig(fakeConfig({ daemonMode: 'remote', daemonAddress: '' }) as never);
    assert.strictEqual(cfg.mode, 'remote');
    assert.strictEqual(cfg.isRemote, true);
    assert.strictEqual(cfg.address, undefined);
    assert.strictEqual(describeConnectionMode(cfg), 'remote (missing daemonAddress)');
  });

  test('local modes ignore address and TLS settings', () => {
    for (const mode of ['embedded', 'standalone'] as const) {
      const cfg = readDaemonConnectionConfig(fakeConfig({
        daemonMode: mode,
        daemonAddress: '127.0.0.1:50051',
        daemonTls: true,
      }) as never);
      assert.strictEqual(cfg.mode, mode);
      assert.strictEqual(cfg.isRemote, false);
      assert.strictEqual(cfg.tls, false);
      assert.strictEqual(describeConnectionMode(cfg), `local:${mode}`);
    }
  });

  test('readDaemonConnectionConfig remote defaults TLS on', () => {
    const cfg = readDaemonConnectionConfig(fakeConfig({
      daemonMode: 'auto',
      daemonAddress: '127.0.0.1:50051',
      daemonCaPath: '/tmp/ca.crt',
      daemonSslTargetName: '',
      daemonTokenEnv: 'APME_TOKEN',
    }) as never);

    assert.strictEqual(cfg.mode, 'auto');
    assert.strictEqual(cfg.isRemote, true);
    assert.strictEqual(cfg.address, '127.0.0.1:50051');
    assert.strictEqual(cfg.tls, true);
    assert.strictEqual(cfg.caPath, '/tmp/ca.crt');
    assert.strictEqual(cfg.sslTargetName, GRPC_TLS_DEFAULT_CN);
    assert.strictEqual(cfg.tokenEnv, 'APME_TOKEN');
    assert.strictEqual(describeConnectionMode(cfg), 'remote:127.0.0.1:50051 (tls)');
  });

  test('readDaemonConnectionConfig respects daemonTls false in remote mode', () => {
    const cfg = readDaemonConnectionConfig(fakeConfig({
      daemonMode: 'remote',
      daemonAddress: 'localhost:50051',
      daemonTls: false,
    }) as never);

    assert.strictEqual(cfg.tls, false);
    assert.strictEqual(describeConnectionMode(cfg), 'remote:localhost:50051 (plaintext)');
  });

  test('resolveDaemonToken prefers SecretStorage over env', async () => {
    const config: DaemonConnectionConfig = {
      mode: 'remote',
      address: '127.0.0.1:50051',
      isRemote: true,
      tls: true,
      caPath: undefined,
      sslTargetName: GRPC_TLS_DEFAULT_CN,
      tokenEnv: 'MY_TOKEN',
    };

    const secrets = {
      get: async (key: string) => {
        assert.strictEqual(key, DAEMON_TOKEN_SECRET_KEY);
        return 'from-secret';
      },
    };

    const token = await resolveDaemonToken(config, secrets as never, { MY_TOKEN: 'from-env' });
    assert.strictEqual(token, 'from-secret');
  });

  test('resolveDaemonToken falls back to env var', async () => {
    const config: DaemonConnectionConfig = {
      mode: 'remote',
      address: '127.0.0.1:50051',
      isRemote: true,
      tls: true,
      caPath: undefined,
      sslTargetName: GRPC_TLS_DEFAULT_CN,
      tokenEnv: 'MY_TOKEN',
    };

    const secrets = {
      get: async () => undefined,
    };

    const token = await resolveDaemonToken(config, secrets as never, { MY_TOKEN: 'env-value' });
    assert.strictEqual(token, 'env-value');
  });

  test('resolveDaemonToken returns undefined when unset', async () => {
    const config: DaemonConnectionConfig = {
      mode: 'auto',
      address: undefined,
      isRemote: false,
      tls: false,
      caPath: undefined,
      sslTargetName: GRPC_TLS_DEFAULT_CN,
      tokenEnv: undefined,
    };
    assert.strictEqual(await resolveDaemonToken(config), undefined);
  });

  test('daemon mode setting triggers reconnect', () => {
    const event = { affectsConfiguration: (key: string) => key === 'abbenay.daemonMode' };
    assert.strictEqual(affectsDaemonConnection(event as never), true);
  });

  test('affectsDaemonConnection matches connection keys', () => {
    const hit = {
      affectsConfiguration: (key: string) => key === 'abbenay.daemonAddress',
    };
    const miss = {
      affectsConfiguration: (key: string) => key === 'abbenay.logLevel',
    };
    assert.strictEqual(affectsDaemonConnection(hit as never), true);
    assert.strictEqual(affectsDaemonConnection(miss as never), false);
  });
});
