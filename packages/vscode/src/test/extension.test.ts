import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Smoke Tests', () => {
  suiteSetup(async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension('abbenay.abbenay-provider');
    if (ext && !ext.isActive) {
      try {
        await ext.activate();
      } catch (err) {
        console.error('Extension activation error (expected without daemon):', err);
      }
    }
  });

  test('Extension should be present', () => {
    const ext = vscode.extensions.getExtension('abbenay.abbenay-provider');
    assert.ok(ext, 'Extension not found in registry');
  });

  test('Extension should activate without crashing', () => {
    const ext = vscode.extensions.getExtension('abbenay.abbenay-provider');
    assert.ok(ext);
    assert.strictEqual(ext.isActive, true, 'Extension should be active (even without daemon)');
  });

  test('Contributed commands should be registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);

    const expected = [
      'abbenay.daemonStatus',
      'abbenay.openDashboard',
      'abbenay.configureProvider',
    ];

    for (const cmd of expected) {
      assert.ok(
        allCommands.includes(cmd),
        `Expected command "${cmd}" to be registered`,
      );
    }
  });

  test('Configuration section should exist', () => {
    const config = vscode.workspace.getConfiguration('abbenay');
    const logLevel = config.get<string>('logLevel');
    assert.strictEqual(logLevel, 'info', 'Default logLevel should be "info"');
  });
});
