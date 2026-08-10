import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRegisterTelemetry = vi.fn();

vi.mock('ai', () => ({
  registerTelemetry: (...args: unknown[]) => mockRegisterTelemetry(...args),
}));

describe('initAiSdkTelemetry', () => {
  const originalEnv = process.env.ABBENAY_AI_TELEMETRY;

  beforeEach(() => {
    vi.resetModules();
    mockRegisterTelemetry.mockClear();
    delete process.env.ABBENAY_AI_TELEMETRY;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ABBENAY_AI_TELEMETRY;
    } else {
      process.env.ABBENAY_AI_TELEMETRY = originalEnv;
    }
  });

  it('skips registration when env is unset', async () => {
    const { initAiSdkTelemetry } = await import('./telemetry.js');
    await initAiSdkTelemetry();
    expect(mockRegisterTelemetry).not.toHaveBeenCalled();
  });

  it('registers @ai-sdk/otel when ABBENAY_AI_TELEMETRY=1', async () => {
    process.env.ABBENAY_AI_TELEMETRY = '1';
    const { initAiSdkTelemetry } = await import('./telemetry.js');
    await initAiSdkTelemetry();
    expect(mockRegisterTelemetry).toHaveBeenCalledOnce();
  });

  it('registers when ABBENAY_AI_TELEMETRY=true', async () => {
    process.env.ABBENAY_AI_TELEMETRY = 'true';
    const { initAiSdkTelemetry } = await import('./telemetry.js');
    await initAiSdkTelemetry();
    expect(mockRegisterTelemetry).toHaveBeenCalledOnce();
  });

  it('is idempotent — second call does not re-register', async () => {
    process.env.ABBENAY_AI_TELEMETRY = '1';
    const { initAiSdkTelemetry } = await import('./telemetry.js');
    await initAiSdkTelemetry();
    await initAiSdkTelemetry();
    expect(mockRegisterTelemetry).toHaveBeenCalledOnce();
  });

  it('handles @ai-sdk/otel import failure gracefully', async () => {
    process.env.ABBENAY_AI_TELEMETRY = '1';
    vi.doMock('@ai-sdk/otel', () => {
      throw new Error('module missing');
    });
    const { initAiSdkTelemetry } = await import('./telemetry.js');
    await expect(initAiSdkTelemetry()).resolves.toBeUndefined();
    expect(mockRegisterTelemetry).not.toHaveBeenCalled();
  });
});
