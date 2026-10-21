import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DaemonClient } from '../daemon/client';
import { completeDaemonStartupUnlessDisabled, openDashboardForClient } from '../extension';
import { DEFAULT_DASHBOARD_PORT, EMBEDDED_DASHBOARD_PORT, type DaemonConnectionConfig } from '../daemon/connection-config';

suite('Extension Smoke Tests', () => {
  suiteSetup(async function () {
    // Keep persisted VS Code test settings from prior runs from changing startup behavior.
    await vscode.workspace.getConfiguration('abbenay').update('daemonMode', 'auto', vscode.ConfigurationTarget.Global);

    // Activation may auto-start the bundled SEA and wait for IPC readiness.
    this.timeout(60000);

    // Clear stale runtime artifacts so a dead PID / leftover socket cannot
    // confuse liveness checks or leave activate() waiting on a bad endpoint.
    const runtimeDir = path.join(os.tmpdir(), 'abbenay');
    for (const name of ['abbenay.pid', 'daemon.sock', 'daemon.addr']) {
      const p = path.join(runtimeDir, name);
      try {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
        }
      } catch {
        // best-effort cleanup
      }
    }

    const ext = vscode.extensions.getExtension('redhat.abbenay-provider');
    if (ext && !ext.isActive) {
      try {
        await ext.activate();
      } catch (err) {
        console.error('Extension activation error (expected without daemon):', err);
      }
    }
  });

  test('Extension should be present', () => {
    const ext = vscode.extensions.getExtension('redhat.abbenay-provider');
    assert.ok(ext, 'Extension not found in registry');
  });

  test('Extension should activate without crashing', () => {
    const ext = vscode.extensions.getExtension('redhat.abbenay-provider');
    assert.ok(ext);
    assert.strictEqual(ext.isActive, true, 'Extension should be active (even without daemon)');
  });

  test('Contributed commands should be registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);

    const expected = [
      'abbenay.daemonStatus',
      'abbenay.openDashboard',
      'abbenay.configureProvider',
      'abbenay.chat.newSession',
      'abbenay.chat.deleteSession',
      'abbenay.chat.settings',
      'abbenay.chat.send',
      'abbenay.setDaemonToken',
      'abbenay.clearDaemonToken',
    ];

    for (const cmd of expected) {
      assert.ok(
        allCommands.includes(cmd),
        `Expected command "${cmd}" to be registered`,
      );
    }
  });

  test('Chat view should be registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(
      allCommands.includes('abbenay.chatView.focus'),
      'Expected chat view focus command to be auto-registered',
    );
  });

  test('Configuration section should exist', () => {
    const config = vscode.workspace.getConfiguration('abbenay');
    const logLevel = config.get<string>('logLevel');
    assert.strictEqual(logLevel, 'info', 'Default logLevel should be "info"');
    assert.strictEqual(config.get<string>('daemonMode'), 'auto');
    assert.strictEqual(DEFAULT_DASHBOARD_PORT, 8787);
    assert.strictEqual(EMBEDDED_DASHBOARD_PORT, 8788);
    assert.strictEqual(config.get<string>('daemonAddress'), '');
    assert.strictEqual(config.get<boolean>('daemonTls'), true);
    assert.strictEqual(config.get<string>('daemonSslTargetName'), 'abbenay-grpc');
  });

  test('daemon startup rolls back when mode becomes Disabled before startup completes', async () => {
    let daemonMode = 'auto';
    let finishStartup: ((value: { id: string }) => void) | undefined;
    let rolledBack = false;
    const startup = completeDaemonStartupUnlessDisabled(
      () => new Promise<{ id: string }>((resolve) => { finishStartup = resolve; }),
      () => daemonMode === 'disabled',
      async (client: { id: string }) => {
        assert.strictEqual(client.id, 'daemon-client');
        rolledBack = true;
      },
    );

    await Promise.resolve();
    daemonMode = 'disabled';
    finishStartup?.({ id: 'daemon-client' });

    assert.strictEqual(await startup, undefined);
    assert.strictEqual(rolledBack, true);
  });

  test('dashboard opens the URL returned by the selected embedded daemon', async () => {
    const opened: string[] = [];
    const config = vscode.workspace.getConfiguration('abbenay');
    const originalMode = config.get<string>('daemonMode');
    const embeddedConfig: DaemonConnectionConfig = {
      mode: 'embedded',
      address: undefined,
      isRemote: false,
      tls: false,
      caPath: undefined,
      sslTargetName: 'abbenay-grpc',
      tokenEnv: undefined,
    };
    const fakeClient = {
      startWebServer: async () => ({
        started: true,
        alreadyRunning: false,
        port: EMBEDDED_DASHBOARD_PORT,
        url: `http://localhost:${EMBEDDED_DASHBOARD_PORT}`,
      }),
    };

    try {
      await config.update('daemonMode', 'embedded', vscode.ConfigurationTarget.Global);
      const url = await openDashboardForClient(fakeClient, async (uri) => {
        opened.push(uri.toString());
        return true;
      }, embeddedConfig);
      assert.strictEqual(url, `http://localhost:${EMBEDDED_DASHBOARD_PORT}`);
      assert.deepStrictEqual(opened, [`http://localhost:${EMBEDDED_DASHBOARD_PORT}/`]);
    } finally {
      await config.update('daemonMode', originalMode, vscode.ConfigurationTarget.Global);
    }
  });

  test('dashboard opens the actual custom port returned by the selected daemon', async () => {
    const opened: string[] = [];
    const standaloneConfig: DaemonConnectionConfig = {
      mode: 'standalone',
      address: undefined,
      isRemote: false,
      tls: false,
      caPath: undefined,
      sslTargetName: 'abbenay-grpc',
      tokenEnv: undefined,
    };
    const customPort = 3000;
    const url = await openDashboardForClient(
      {
        startWebServer: async () => ({
          started: false,
          alreadyRunning: true,
          port: customPort,
          url: '',
        }),
      },
      async (uri) => {
        opened.push(uri.toString());
        return true;
      },
      standaloneConfig,
      (response) => response.url || `http://localhost:${response.port}`,
    );
    assert.strictEqual(url, `http://localhost:${customPort}`);
    assert.deepStrictEqual(opened, [`http://localhost:${customPort}/`]);
  });

  test('dashboard failure does not fall back to the standalone dashboard URL', async () => {
    const opened: string[] = [];
    const embeddedConfig: DaemonConnectionConfig = {
      mode: 'embedded',
      address: undefined,
      isRemote: false,
      tls: false,
      caPath: undefined,
      sslTargetName: 'abbenay-grpc',
      tokenEnv: undefined,
    };
    await assert.rejects(
      openDashboardForClient(
        { startWebServer: async () => { throw new Error('port conflict'); } },
        async (uri) => {
          opened.push(uri.toString());
          return true;
        },
        embeddedConfig,
      ),
      /port conflict/,
    );
    assert.deepStrictEqual(opened, []);
  });

  test('disabled daemon mode disconnects existing daemon transports', async () => {
    const client = new DaemonClient();
    const channel = { close: () => { closed = true; } } as never;
    let closed = false;
    (client as unknown as { channel: unknown; client: unknown }).channel = channel;
    (client as unknown as { channel: unknown; client: unknown }).client = {};

    const config = vscode.workspace.getConfiguration('abbenay');
    const originalMode = config.get<string>('daemonMode');
    await config.update('daemonMode', 'disabled', vscode.ConfigurationTarget.Global);
    try {
      await assert.rejects(client.connect(), /Abbenay is disabled by the abbenay\.daemonMode setting/);
      assert.strictEqual(client.isConnected(), false);
      assert.strictEqual(closed, true);
    } finally {
      await client.close();
      await config.update('daemonMode', originalMode, vscode.ConfigurationTarget.Global);
    }
  });
});
