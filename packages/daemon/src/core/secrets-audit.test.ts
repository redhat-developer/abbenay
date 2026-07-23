/**
 * Unit tests for secret mutation audit logging (finding A1).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { auditSecretChange } from './secrets.js';

describe('auditSecretChange', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs key and op without the secret value', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    auditSecretChange({
      key: 'OPENAI_API_KEY',
      op: 'set',
      source: 'http-secrets',
    });
    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain('[Audit] secret changed');
    expect(line).toContain('key=OPENAI_API_KEY');
    expect(line).toContain('op=set');
    expect(line).toContain('source=http-secrets');
    expect(line).not.toMatch(/sk-|secret-value|password/i);
  });

  it('strips control characters from key and actor', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    auditSecretChange({
      key: 'OPENAI_API_KEY\n[Audit] forged',
      op: 'set',
      source: 'http-secrets',
      actor: 'alice\rbob',
    });
    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0][0]);
    expect(line).not.toMatch(/\n|\r/);
    expect(line).toContain('key=OPENAI_API_KEY[Audit] forged');
    expect(line).toContain('actor=alicebob');
  });
});
