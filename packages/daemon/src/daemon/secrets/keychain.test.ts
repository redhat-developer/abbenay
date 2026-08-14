/**
 * Unit tests for KeychainSecretStore (keytar / SEA loading).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import Module from 'node:module';

const SERVICE_NAME = 'abbenay';

const mocks = vi.hoisted(() => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
}));

function createDefaultKeytarMock() {
  const api = {
    getPassword: mocks.getPassword,
    setPassword: mocks.setPassword,
    deletePassword: mocks.deletePassword,
  };

  return { default: api, ...api };
}

vi.mock('keytar', () => createDefaultKeytarMock());

function registerDefaultKeytarMock(): void {
  vi.doMock('keytar', () => createDefaultKeytarMock());
}

type KeychainInternals = {
  keytar: {
    getPassword: typeof mocks.getPassword;
    setPassword: typeof mocks.setPassword;
    deletePassword: typeof mocks.deletePassword;
  } | null;
  loadError: string | null;
  loadPromise: Promise<unknown> | null;
  loadKeytarFromSea: () => {
    getPassword: typeof mocks.getPassword;
    setPassword: typeof mocks.setPassword;
    deletePassword: typeof mocks.deletePassword;
  };
};

function patchNodeSeaModule(
  seaExports: Record<string, unknown> | Error,
): () => void {
  const original = Module.prototype.require;
  Module.prototype.require = function (this: NodeModule, id: string, ...args: unknown[]) {
    if (id === 'node:sea') {
      if (seaExports instanceof Error) {
        throw seaExports;
      }
      return seaExports;
    }
    return original.apply(this, [id, ...args] as [string]);
  };
  return () => {
    Module.prototype.require = original;
  };
}

describe('KeychainSecretStore', () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    vi.doUnmock('keytar');
    registerDefaultKeytarMock();
    vi.resetModules();
    mocks.getPassword.mockReset();
    mocks.setPassword.mockReset();
    mocks.deletePassword.mockReset();
    errorSpy.mockClear();
  });

  async function loadStoreWithFailingKeytarImport(
    importError: unknown = new Error('keytar missing'),
  ) {
    vi.doMock('keytar', () => ({
      get default() {
        throw importError;
      },
    }));
    // Drop any successful keytar module from an earlier test (flake under --coverage).
    vi.resetModules();
    const { KeychainSecretStore } = await import('./keychain.js');
    const store = new KeychainSecretStore();
    await vi.dynamicImportSettled();
    return store;
  }

  /**
   * Load a fresh KeychainSecretStore instance, then let its constructor's
   * fire-and-forget `loadKeytar()` call settle. By default we reset the
   * internal cached state afterwards and inject a real keytar mock, since
   * most tests want to control the keytar behavior directly rather than via
   * the constructor's own load path (which is tested separately below).
   */
  async function loadStore(setup?: (internals: KeychainInternals) => void) {
    const { KeychainSecretStore } = await import('./keychain.js');
    const store = new KeychainSecretStore();
    await vi.dynamicImportSettled();
    const internals = store as unknown as KeychainInternals;
    internals.keytar = null;
    internals.loadError = null;
    internals.loadPromise = null;
    setup?.(internals);
    return store;
  }

  function injectKeytar(internals: KeychainInternals): void {
    internals.keytar = {
      getPassword: mocks.getPassword,
      setPassword: mocks.setPassword,
      deletePassword: mocks.deletePassword,
    };
  }

  it('get returns password from keytar', async () => {
    mocks.getPassword.mockResolvedValue('secret-value');
    const store = await loadStore(injectKeytar);

    await expect(store.get('OPENAI_API_KEY')).resolves.toBe('secret-value');
    expect(mocks.getPassword).toHaveBeenCalledWith(SERVICE_NAME, 'OPENAI_API_KEY');
  });

  it('get returns null when keytar is unavailable', async () => {
    const store = await loadStore((internals) => {
      internals.keytar = null;
      internals.loadError = 'keytar missing';
    });

    await expect(store.get('MISSING')).resolves.toBeNull();
  });

  it('records Error keytar import failures', async () => {
    const store = await loadStoreWithFailingKeytarImport();
    const internals = store as unknown as KeychainInternals;

    await expect(store.get('MISSING')).resolves.toBeNull();
    // Prefer sticky loadError over console.warn — parallel suites can clobber spies.
    expect(internals.keytar).toBeNull();
    expect(internals.loadError).toMatch(/keytar missing/);
  });

  it('get returns null and logs when keytar throws', async () => {
    mocks.getPassword.mockRejectedValue(new Error('keychain denied'));
    const store = await loadStore(injectKeytar);

    await expect(store.get('BAD_KEY')).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      "[Secrets] Failed to get key 'BAD_KEY':",
      'keychain denied',
    );
  });

  it('get returns null when keytar throws a non-Error value', async () => {
    mocks.getPassword.mockRejectedValue('denied');
    const store = await loadStore(injectKeytar);

    await expect(store.get('BAD_KEY')).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      "[Secrets] Failed to get key 'BAD_KEY':",
      'denied',
    );
  });

  it('set stores password via keytar', async () => {
    mocks.setPassword.mockResolvedValue(undefined);
    const store = await loadStore(injectKeytar);

    await expect(store.set('OPENAI_API_KEY', 'sk-test')).resolves.toBeUndefined();
    expect(mocks.setPassword).toHaveBeenCalledWith(SERVICE_NAME, 'OPENAI_API_KEY', 'sk-test');
  });

  it('set throws when keytar is unavailable', async () => {
    const store = await loadStore((internals) => {
      internals.keytar = null;
      internals.loadError = 'keytar missing';
    });

    await expect(store.set('KEY', 'value')).rejects.toThrow('Keychain storage not available');
  });

  it('set wraps keytar errors', async () => {
    mocks.setPassword.mockRejectedValue(new Error('write failed'));
    const store = await loadStore(injectKeytar);

    await expect(store.set('KEY', 'value')).rejects.toThrow(
      "Failed to store key 'KEY': write failed",
    );
  });

  it('set wraps non-Error keytar failures', async () => {
    mocks.setPassword.mockRejectedValue('write failed');
    const store = await loadStore(injectKeytar);

    await expect(store.set('KEY', 'value')).rejects.toThrow(
      "Failed to store key 'KEY': write failed",
    );
  });

  it('delete removes password via keytar', async () => {
    mocks.deletePassword.mockResolvedValue(true);
    const store = await loadStore(injectKeytar);

    await expect(store.delete('OPENAI_API_KEY')).resolves.toBe(true);
    expect(mocks.deletePassword).toHaveBeenCalledWith(SERVICE_NAME, 'OPENAI_API_KEY');
  });

  it('delete returns false when keytar is unavailable', async () => {
    const store = await loadStore((internals) => {
      internals.keytar = null;
      internals.loadError = 'keytar missing';
    });

    await expect(store.delete('KEY')).resolves.toBe(false);
  });

  it('delete returns false and logs when keytar throws', async () => {
    mocks.deletePassword.mockRejectedValue(new Error('delete failed'));
    const store = await loadStore(injectKeytar);

    await expect(store.delete('KEY')).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "[Secrets] Failed to delete key 'KEY':",
      'delete failed',
    );
  });

  it('delete returns false when keytar throws a non-Error value', async () => {
    mocks.deletePassword.mockRejectedValue('delete failed');
    const store = await loadStore(injectKeytar);

    await expect(store.delete('KEY')).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "[Secrets] Failed to delete key 'KEY':",
      'delete failed',
    );
  });

  it('has returns true for non-empty secrets', async () => {
    mocks.getPassword.mockResolvedValue('present');
    const store = await loadStore(injectKeytar);

    await expect(store.has('KEY')).resolves.toBe(true);
  });

  it('has returns false for missing secrets', async () => {
    mocks.getPassword.mockResolvedValue(null);
    const store = await loadStore(injectKeytar);

    await expect(store.has('KEY')).resolves.toBe(false);
  });

  it('has returns false for empty string secrets', async () => {
    mocks.getPassword.mockResolvedValue('');
    const store = await loadStore(injectKeytar);

    await expect(store.has('KEY')).resolves.toBe(false);
  });

  it('reuses cached keytar after first successful load', async () => {
    mocks.getPassword.mockResolvedValue('cached');
    const store = await loadStore(injectKeytar);

    await store.get('A');
    await store.get('B');

    expect(mocks.getPassword).toHaveBeenCalledTimes(2);
  });

  it('short-circuits further loads after keytar import failure', async () => {
    const store = await loadStoreWithFailingKeytarImport();
    const internals = store as unknown as KeychainInternals;

    await expect(store.get('ONE')).resolves.toBeNull();
    expect(internals.keytar).toBeNull();
    expect(internals.loadError).toMatch(/keytar missing/);
    const cachedError = internals.loadError;

    await expect(store.get('TWO')).resolves.toBeNull();
    // Failure is sticky — no second import attempt / error rewrite.
    expect(internals.loadError).toBe(cachedError);
    expect(internals.keytar).toBeNull();
  });

  it('loads keytar from named export when default export lacks getPassword', async () => {
    vi.doMock('keytar', () => ({
      default: {},
      getPassword: mocks.getPassword,
      setPassword: mocks.setPassword,
      deletePassword: mocks.deletePassword,
    }));
    mocks.getPassword.mockResolvedValue('named-export');
    const store = await loadStore();

    await expect(store.get('KEY')).resolves.toBe('named-export');
  });

  it('loads keytar from module export when there is no default export', async () => {
    vi.doMock('keytar', () => ({
      default: undefined,
      getPassword: mocks.getPassword,
      setPassword: mocks.setPassword,
      deletePassword: mocks.deletePassword,
    }));
    mocks.getPassword.mockResolvedValue('module-export');
    const store = await loadStore();

    await expect(store.get('KEY')).resolves.toBe('module-export');
  });

  it('loads keytar via process.dlopen when running as SEA', async () => {
    const dlopenSpy = vi.spyOn(process, 'dlopen').mockImplementation((mod, filePath) => {
      expect(filePath).toBe(path.join(path.dirname(process.execPath), 'keytar.node'));
      (mod as { exports: Record<string, unknown> }).exports = {
        getPassword: mocks.getPassword,
        setPassword: mocks.setPassword,
        deletePassword: mocks.deletePassword,
      };
    });
    const store = await loadStore();
    const internals = store as unknown as KeychainInternals;

    const keytar = internals.loadKeytarFromSea();

    expect(dlopenSpy).toHaveBeenCalledOnce();
    expect(keytar.getPassword).toBe(mocks.getPassword);
    dlopenSpy.mockRestore();
  });

  it('loads keytar through SEA runtime when isSea is true', async () => {
    const restoreNodeSea = patchNodeSeaModule({ isSea: () => true });
    const dlopenSpy = vi.spyOn(process, 'dlopen').mockImplementation((mod) => {
      (mod as { exports: Record<string, unknown> }).exports = {
        getPassword: mocks.getPassword,
        setPassword: mocks.setPassword,
        deletePassword: mocks.deletePassword,
      };
    });
    mocks.getPassword.mockResolvedValue('sea-loaded');
    try {
      const store = await loadStore();
      dlopenSpy.mockClear();

      await expect(store.get('SEA_KEY')).resolves.toBe('sea-loaded');
      expect(dlopenSpy).toHaveBeenCalledOnce();
    } finally {
      dlopenSpy.mockRestore();
      restoreNodeSea();
    }
  });

  it('treats missing node:sea module as non-SEA runtime', async () => {
    const restoreNodeSea = patchNodeSeaModule(new Error('node:sea unavailable'));
    vi.doMock('keytar', () => {
      const api = {
        getPassword: mocks.getPassword,
        setPassword: mocks.setPassword,
        deletePassword: mocks.deletePassword,
      };
      return { default: api, ...api };
    });
    mocks.getPassword.mockResolvedValue('normal-runtime');
    try {
      const store = await loadStore();

      await expect(store.get('KEY')).resolves.toBe('normal-runtime');
      expect(mocks.getPassword).toHaveBeenCalledWith(SERVICE_NAME, 'KEY');
    } finally {
      restoreNodeSea();
    }
  });

  it('treats malformed node:sea module as non-SEA runtime', async () => {
    const restoreNodeSea = patchNodeSeaModule({ isSea: 'not-a-function' });
    vi.doMock('keytar', () => {
      const api = {
        getPassword: mocks.getPassword,
        setPassword: mocks.setPassword,
        deletePassword: mocks.deletePassword,
      };
      return { default: api, ...api };
    });
    mocks.getPassword.mockResolvedValue('normal-runtime');
    try {
      const store = await loadStore();

      await expect(store.get('KEY')).resolves.toBe('normal-runtime');
    } finally {
      restoreNodeSea();
    }
  });

  it('loads keytar through normal import path when not running as SEA', async () => {
    vi.doMock('keytar', () => {
      const api = {
        getPassword: mocks.getPassword,
        setPassword: mocks.setPassword,
        deletePassword: mocks.deletePassword,
      };
      return { default: api, ...api };
    });
    mocks.getPassword.mockResolvedValue('normal-runtime');
    const store = await loadStore();

    await expect(store.get('KEY')).resolves.toBe('normal-runtime');
    expect(mocks.getPassword).toHaveBeenCalledWith(SERVICE_NAME, 'KEY');
  });

  it('records non-Error keytar import failures', async () => {
    const store = await loadStoreWithFailingKeytarImport('native addon missing');
    const internals = store as unknown as KeychainInternals;

    await expect(store.get('KEY')).resolves.toBeNull();
    // Prefer sticky loadError over console.warn — parallel suites can clobber spies.
    expect(internals.keytar).toBeNull();
    expect(internals.loadError).toBe('native addon missing');
    expect(mocks.getPassword).not.toHaveBeenCalled();
  });
});
