import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

suite('Extension Smoke Tests', () => {
  suiteSetup(async function () {
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
      'abbenay.chat.send',
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
  });
});
