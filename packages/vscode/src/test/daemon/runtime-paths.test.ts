import * as assert from 'assert';
import * as path from 'path';
import {
  getRuntimeDir,
  getAddressFilePath,
  parseDaemonAddress,
  getBundledSeaBinaryName,
  getUnixDaemonAddress,
  getSocketFilePath,
} from '../../daemon/runtime-paths';

suite('runtime-paths', () => {
  test('getRuntimeDir uses tmpdir on win32', () => {
    const dir = getRuntimeDir('win32', {}, '/tmp/fake-temp');
    assert.strictEqual(dir, path.join('/tmp/fake-temp', 'abbenay'));
  });

  test('getRuntimeDir uses XDG_RUNTIME_DIR when set', () => {
    const dir = getRuntimeDir('linux', { XDG_RUNTIME_DIR: '/run/user/1000' }, '/unused');
    assert.strictEqual(dir, path.join('/run/user/1000', 'abbenay'));
  });

  test('getAddressFilePath ends with daemon.addr', () => {
    assert.strictEqual(
      getAddressFilePath('/tmp/abbenay'),
      path.join('/tmp/abbenay', 'daemon.addr'),
    );
  });

  test('getSocketFilePath returns named pipe stub on win32', () => {
    assert.strictEqual(
      getSocketFilePath('/tmp/abbenay', 'win32'),
      '\\\\.\\pipe\\abbenay-daemon',
    );
  });

  test('parseDaemonAddress parses host:port', () => {
    assert.deepStrictEqual(parseDaemonAddress('127.0.0.1:54321\n'), {
      host: '127.0.0.1',
      port: 54321,
    });
  });

  test('parseDaemonAddress rejects invalid input', () => {
    assert.strictEqual(parseDaemonAddress(''), null);
    assert.strictEqual(parseDaemonAddress('nope'), null);
    assert.strictEqual(parseDaemonAddress('127.0.0.1:99999'), null);
  });

  test('getBundledSeaBinaryName appends .exe on win32', () => {
    assert.strictEqual(
      getBundledSeaBinaryName('win32', 'x64'),
      'abbenay-daemon-win32-x64.exe',
    );
    assert.strictEqual(
      getBundledSeaBinaryName('linux', 'x64'),
      'abbenay-daemon-linux-x64',
    );
    assert.strictEqual(
      getBundledSeaBinaryName('darwin', 'arm64'),
      'abbenay-daemon-darwin-arm64',
    );
  });

  test('getUnixDaemonAddress prefixes unix://', () => {
    assert.strictEqual(
      getUnixDaemonAddress('/run/user/1000/abbenay/daemon.sock'),
      'unix:///run/user/1000/abbenay/daemon.sock',
    );
  });
});
