/**
 * Keychain secret store using keytar
 */

import type { SecretStore } from '../../core/secrets.js';
import * as path from 'node:path';

const SERVICE_NAME = 'abbenay';

/**
 * Check if we are running inside a Node.js Single Executable Application (SEA).
 */
function isSea(): boolean {
  try {
    // node:sea module is only available inside a SEA binary
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = require('node:sea');
    return typeof sea.isSea === 'function' ? sea.isSea() : false;
  } catch {
    return false;
  }
}

/**
 * Keychain-based secret store using system keyring
 * 
 * Uses keytar for cross-platform keychain access:
 * - macOS: Keychain
 * - Linux: libsecret (GNOME Keyring / KDE Wallet)
 * - Windows: Credential Vault
 * 
 * When running as a SEA binary, loads keytar.node from alongside the executable.
 * When running normally, uses the standard import('keytar') path.
 */
export class KeychainSecretStore implements SecretStore {
  private keytar: typeof import('keytar') | null = null;
  private loadError: string | null = null;
  
  constructor() {
    // Load keytar lazily since it's a native module
    this.loadKeytar();
  }
  
  private async loadKeytar(): Promise<typeof import('keytar') | null> {
    if (this.keytar) return this.keytar;
    if (this.loadError) return null;
    
    try {
      if (isSea()) {
        // SEA mode: keytar.node ships alongside the executable
        this.keytar = this.loadKeytarFromSea();
      } else {
        // Normal mode: import from node_modules
        const mod = await import('keytar');
        const keytarApi = (mod as { default?: typeof import('keytar') }).default ?? mod;
        this.keytar = typeof keytarApi.getPassword === 'function' ? keytarApi : mod;
      }
      return this.keytar;
    } catch (error: unknown) {
      this.loadError = error instanceof Error ? error.message : String(error);
      console.warn(`[Secrets] keytar not available: ${this.loadError}. Keychain storage disabled.`);
      return null;
    }
  }
  
  /**
   * Load keytar native addon when running inside a SEA binary.
   * The keytar.node file is shipped alongside the SEA executable.
   */
  private loadKeytarFromSea(): typeof import('keytar') {
    const exeDir = path.dirname(process.execPath);
    const keytarNodePath = path.join(exeDir, 'keytar.node');
    
    // Create a minimal module and load the native addon via process.dlopen
    const keytarModule: { exports: Record<string, unknown> } = { exports: {} };
    process.dlopen(keytarModule, keytarNodePath);
    
    return keytarModule.exports as typeof import('keytar');
  }
  
  async get(key: string): Promise<string | null> {
    const kt = await this.loadKeytar();
    if (!kt) return null;
    
    try {
      return await kt.getPassword(SERVICE_NAME, key);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Secrets] Failed to get key '${key}':`, msg);
      return null;
    }
  }
  
  async set(key: string, value: string): Promise<void> {
    const kt = await this.loadKeytar();
    if (!kt) {
      throw new Error('Keychain storage not available');
    }
    
    try {
      await kt.setPassword(SERVICE_NAME, key, value);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to store key '${key}': ${msg}`);
    }
  }
  
  async delete(key: string): Promise<boolean> {
    const kt = await this.loadKeytar();
    if (!kt) return false;
    
    try {
      return await kt.deletePassword(SERVICE_NAME, key);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Secrets] Failed to delete key '${key}':`, msg);
      return false;
    }
  }
  
  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null && value.length > 0;
  }
}
