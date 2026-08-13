/**
 * Unit tests for the withEnv test helper.
 */

import { describe, it, expect } from 'vitest';
import { withEnv } from './with-env.js';

describe('withEnv', () => {
  it('restores a previously set env value after the callback', async () => {
    const key = 'ABBENAY_TEST_ENV_RESTORE';
    process.env[key] = 'original';
    try {
      await withEnv(key, 'temporary', () => {
        expect(process.env[key]).toBe('temporary');
      });
      expect(process.env[key]).toBe('original');
    } finally {
      delete process.env[key];
    }
  });

  it('deletes the key when it was previously unset', async () => {
    const key = 'ABBENAY_TEST_ENV_DELETE';
    delete process.env[key];
    await withEnv(key, 'temporary', () => {
      expect(process.env[key]).toBe('temporary');
    });
    expect(process.env[key]).toBeUndefined();
  });
});
