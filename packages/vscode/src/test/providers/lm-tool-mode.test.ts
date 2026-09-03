import * as assert from 'assert';
import {
  LM_TOOL_MODE_DEFAULT,
  readLmToolModeSetting,
  resolveDaemonToolMode,
} from '../../providers/lm-tool-mode';

function fakeConfig(values: Record<string, unknown>): {
  get<T>(key: string, defaultValue?: T): T | undefined;
} {
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      if (key in values) {
        return values[key] as T;
      }
      return defaultValue;
    },
  };
}

suite('lm-tool-mode', () => {
  test('resolveDaemonToolMode returns none when host sends no tools', () => {
    assert.strictEqual(resolveDaemonToolMode(false, 'passthrough'), 'none');
    assert.strictEqual(resolveDaemonToolMode(false, 'auto'), 'none');
  });

  test('resolveDaemonToolMode maps setting when host sends tools', () => {
    assert.strictEqual(resolveDaemonToolMode(true, 'passthrough'), 'passthrough');
    assert.strictEqual(resolveDaemonToolMode(true, 'auto'), 'auto');
  });

  test('readLmToolModeSetting defaults to passthrough', () => {
    assert.strictEqual(readLmToolModeSetting(fakeConfig({})), LM_TOOL_MODE_DEFAULT);
    assert.strictEqual(readLmToolModeSetting(fakeConfig({ lmToolMode: undefined })), 'passthrough');
  });

  test('readLmToolModeSetting honors auto', () => {
    assert.strictEqual(readLmToolModeSetting(fakeConfig({ lmToolMode: 'auto' })), 'auto');
  });

  test('readLmToolModeSetting treats unknown values as passthrough', () => {
    assert.strictEqual(readLmToolModeSetting(fakeConfig({ lmToolMode: 'bogus' })), 'passthrough');
  });
});
