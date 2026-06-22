import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./transport.js', () => ({
  isDaemonRunningSync: vi.fn(() => true),
}));

vi.mock('./state.js', () => ({
  DaemonState: vi.fn(),
}));

vi.mock('./daemon.js', () => ({
  startDaemon: vi.fn(),
}));

vi.mock('./chat.js', () => ({
  promptModelPicker: vi.fn(),
}));

// ── selectModel ──────────────────────────────────────────────────────

describe('selectModel', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it('returns null and prints guidance when no models are configured', async () => {
    const { DaemonState } = await import('./state.js');
    vi.mocked(DaemonState).mockImplementation(function () {
      return { listModels: vi.fn().mockResolvedValue([]) } as any;
    });

    const { selectModel } = await import('./model-picker.js');
    const result = await selectModel();

    expect(result).toBeNull();
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('No models configured');
    expect(output).toContain('aby start');
    expect(output).toContain('web UI');
  });

  it('returns model and state via picker when models exist', async () => {
    const models = [
      { id: 'openai/gpt-4o', name: 'gpt-4o', provider: 'openai' },
      { id: 'anthropic/claude-sonnet', name: 'claude-sonnet', provider: 'anthropic' },
    ];
    const { DaemonState } = await import('./state.js');
    vi.mocked(DaemonState).mockImplementation(function () {
      return { listModels: vi.fn().mockResolvedValue(models) } as any;
    });

    const { promptModelPicker } = await import('./chat.js');
    vi.mocked(promptModelPicker).mockResolvedValue('anthropic/claude-sonnet');

    const { selectModel } = await import('./model-picker.js');
    const result = await selectModel();

    expect(result).not.toBeNull();
    expect(result!.model).toBe('anthropic/claude-sonnet');
    expect(result!.state).toBeDefined();
    expect(result!.state.listModels).toBeDefined();
    expect(promptModelPicker).toHaveBeenCalledWith(models, expect.anything());
  });

  it('returns null when user cancels the picker (Ctrl+C)', async () => {
    const models = [
      { id: 'openai/gpt-4o', name: 'gpt-4o', provider: 'openai' },
    ];
    const { DaemonState } = await import('./state.js');
    vi.mocked(DaemonState).mockImplementation(function () {
      return { listModels: vi.fn().mockResolvedValue(models) } as any;
    });

    const { promptModelPicker } = await import('./chat.js');
    vi.mocked(promptModelPicker).mockResolvedValue(null);

    const { selectModel } = await import('./model-picker.js');
    const result = await selectModel();

    expect(result).toBeNull();
  });

  it('starts daemon if not already running', async () => {
    const { isDaemonRunningSync } = await import('./transport.js');
    vi.mocked(isDaemonRunningSync).mockReturnValue(false);

    const { startDaemon } = await import('./daemon.js');
    const fakeState = { listModels: vi.fn().mockResolvedValue([]) };
    vi.mocked(startDaemon).mockResolvedValue(fakeState as any);

    const { selectModel } = await import('./model-picker.js');
    await selectModel();

    expect(startDaemon).toHaveBeenCalledWith({ keepAlive: false });
  });

  it('uses existing DaemonState when daemon is already running', async () => {
    const { isDaemonRunningSync } = await import('./transport.js');
    vi.mocked(isDaemonRunningSync).mockReturnValue(true);

    const { DaemonState } = await import('./state.js');
    vi.mocked(DaemonState).mockImplementation(function () {
      return { listModels: vi.fn().mockResolvedValue([]) } as any;
    });

    const { startDaemon } = await import('./daemon.js');

    const { selectModel } = await import('./model-picker.js');
    await selectModel();

    expect(DaemonState).toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
  });
});

// ── --model flag bypass (chat action guard) ──────────────────────────

describe('chat command --model bypass', () => {
  it('skips picker when --model is provided', () => {
    const options = { model: 'openai/gpt-4o', session: undefined };
    const shouldPickModel = !options.model && !options.session;
    expect(shouldPickModel).toBe(false);
  });

  it('skips picker when --session is provided', () => {
    const options = { model: undefined, session: 'abc123' };
    const shouldPickModel = !options.model && !options.session;
    expect(shouldPickModel).toBe(false);
  });

  it('triggers picker when neither --model nor --session is provided', () => {
    const options = { model: undefined, session: undefined };
    const shouldPickModel = !options.model && !options.session;
    expect(shouldPickModel).toBe(true);
  });
});
