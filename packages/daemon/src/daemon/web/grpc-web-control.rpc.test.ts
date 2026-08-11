/**
 * RPC-level tests for sendStartWebServer / sendStopWebServer (mocked gRPC transport).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStartWebServer = vi.fn();
const mockStopWebServer = vi.fn();
const mockClose = vi.fn();

vi.mock('@grpc/grpc-js', () => {
  class MockAbbenay {
    StartWebServer(...args: unknown[]) {
      return mockStartWebServer(...args);
    }
    StopWebServer(...args: unknown[]) {
      return mockStopWebServer(...args);
    }
    close() {
      mockClose();
    }
  }
  return {
    loadPackageDefinition: vi.fn(() => ({
      abbenay: { v1: { Abbenay: MockAbbenay } },
    })),
    credentials: {
      createInsecure: vi.fn(() => ({ type: 'insecure' })),
    },
    ChannelCredentials: class {},
  };
});

vi.mock('@grpc/proto-loader', () => ({
  loadSync: vi.fn(() => ({})),
}));

import { sendStartWebServer, sendStopWebServer } from './grpc-web-control.js';

describe('sendStartWebServer', () => {
  beforeEach(() => {
    mockStartWebServer.mockReset();
    mockStopWebServer.mockReset();
    mockClose.mockReset();
  });

  it('returns the gRPC response and closes the client', async () => {
    const response = {
      started: true,
      already_running: false,
      port: 8787,
      url: 'http://127.0.0.1:8787',
    };
    mockStartWebServer.mockImplementation((_req, cb) => cb(null, response));

    const result = await sendStartWebServer(8787);
    expect(result).toEqual(response);
    expect(mockStartWebServer).toHaveBeenCalledWith({ port: 8787 }, expect.any(Function));
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it('propagates gRPC errors and still closes the client', async () => {
    const grpcError = new Error('daemon unreachable');
    mockStartWebServer.mockImplementation((_req, cb) => cb(grpcError));

    await expect(sendStartWebServer(8787)).rejects.toThrow('daemon unreachable');
    expect(mockClose).toHaveBeenCalledOnce();
  });
});

describe('sendStopWebServer', () => {
  beforeEach(() => {
    mockStartWebServer.mockReset();
    mockStopWebServer.mockReset();
    mockClose.mockReset();
  });

  it('calls StopWebServer and closes the client', async () => {
    mockStopWebServer.mockImplementation((_req, cb) => cb(null, {}));

    await sendStopWebServer();
    expect(mockStopWebServer).toHaveBeenCalledWith({}, expect.any(Function));
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it('propagates gRPC errors and still closes the client', async () => {
    mockStopWebServer.mockImplementation((_req, cb) => cb(new Error('stop failed')));

    await expect(sendStopWebServer()).rejects.toThrow('stop failed');
    expect(mockClose).toHaveBeenCalledOnce();
  });
});
