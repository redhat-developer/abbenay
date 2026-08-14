/**
 * Unit tests for FileSecretStore (config-dir secrets.json).
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  rename: vi.fn(),
  actualRename: undefined as typeof import('node:fs/promises').rename | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsMocks.actualRename = actual.rename.bind(actual);
  fsMocks.rename.mockImplementation(fsMocks.actualRename);
  return { ...actual, rename: fsMocks.rename };
});

import { FileSecretStore } from './file-store.js';

describe('FileSecretStore', () => {
  let dir: string;
  let filePath: string;
  let store: FileSecretStore;

  beforeEach(async () => {
    fsMocks.rename.mockReset();
    fsMocks.rename.mockImplementation(fsMocks.actualRename!);
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'abbenay-secrets-'));
    filePath = path.join(dir, 'secrets.json');
    store = new FileSecretStore(filePath);
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('set/get/has/delete round-trip', async () => {
    expect(await store.has('K')).toBe(false);
    await store.set('K', 'secret-value');
    expect(await store.has('K')).toBe(true);
    expect(await store.get('K')).toBe('secret-value');
    expect(await store.delete('K')).toBe(true);
    expect(await store.get('K')).toBeNull();
    expect(await store.delete('K')).toBe(false);
  });

  it('persists across store instances (reload from disk)', async () => {
    await store.set('OPENROUTER_API_KEY', 'sk-or-test');
    const reloaded = new FileSecretStore(filePath);
    expect(await reloaded.get('OPENROUTER_API_KEY')).toBe('sk-or-test');
  });

  it.skipIf(process.platform === 'win32')('writes mode 0600 on unix', async () => {
    await store.set('K', 'v');
    const st = await fsp.stat(filePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('starts empty when file is missing', async () => {
    expect(await store.get('missing')).toBeNull();
  });

  it('refuses writes when file is corrupt JSON', async () => {
    await fsp.writeFile(filePath, 'not-json{', 'utf8');
    const reloaded = new FileSecretStore(filePath);
    expect(await reloaded.get('K')).toBeNull();
    await expect(reloaded.set('K', 'v')).rejects.toThrow(/unparseable/);
    expect(await fsp.readFile(filePath, 'utf8')).toBe('not-json{');
  });

  it('refuses writes when file is a JSON array', async () => {
    await fsp.writeFile(filePath, '[]', 'utf8');
    const reloaded = new FileSecretStore(filePath);
    expect(await reloaded.get('K')).toBeNull();
    await expect(reloaded.set('K', 'v')).rejects.toThrow(/unparseable/);
  });

  it('exposes absolute path', () => {
    expect(store.path).toBe(filePath);
  });

  it('serializes concurrent writes so all keys survive', async () => {
    await Promise.all([
      store.set('A', '1'),
      store.set('B', '2'),
      store.set('C', '3'),
      store.delete('missing'),
    ]);
    expect(await store.get('A')).toBe('1');
    expect(await store.get('B')).toBe('2');
    expect(await store.get('C')).toBe('3');
    const reloaded = new FileSecretStore(filePath);
    expect(await reloaded.get('A')).toBe('1');
    expect(await reloaded.get('B')).toBe('2');
    expect(await reloaded.get('C')).toBe('3');
  });

  it('leaves cache consistent with disk when persist fails', async () => {
    await store.set('K', 'ok');
    fsMocks.rename.mockRejectedValueOnce(new Error('disk full'));
    await expect(store.set('K', 'bad')).rejects.toThrow(/Failed to persist/);
    expect(await store.get('K')).toBe('ok');
    const reloaded = new FileSecretStore(filePath);
    expect(await reloaded.get('K')).toBe('ok');
  });
});
