/**
 * Layer 1: Direct gRPC streaming tests
 * 
 * Tests the gRPC Chat streaming RPC directly (client → mock server).
 * No Express, no SSE — pure gRPC streaming isolation.
 * 
 * This layer verifies that:
 * - gRPC server-streaming works correctly
 * - Text chunks are received in order
 * - Done/error chunks are handled
 * - Stream cancellation works
 * - Multiple concurrent streams work
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createMockDaemon,
  createTestClient,
  callUnary,
  type MockDaemon,
} from './helpers/mock-daemon.js';

let daemon: MockDaemon;
let client: any;

beforeAll(async () => {
  daemon = await createMockDaemon({
    chunks: ['Hello', ' world', '!'],
    chunkDelayMs: 10,
  });
  client = createTestClient(daemon.address);
  
  // Wait for the channel to be ready
  await new Promise<void>((resolve, reject) => {
    const deadline = new Date(Date.now() + 5000);
    client.waitForReady(deadline, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

afterAll(async () => {
  if (client) client.close();
  if (daemon) await daemon.stop();
});

describe('gRPC Unary RPCs', () => {
  it('should respond to HealthCheck', async () => {
    const result = await callUnary(client, 'HealthCheck', {});
    expect(result.healthy).toBe(true);
    expect(result.version).toBe('0.1.0-mock');
  });
  
  it('should respond to Register', async () => {
    const result = await callUnary(client, 'Register', {
      client: { client_type: 2 },
      is_spawner: false,
    });
    expect(result.client_id).toBe('mock-client-001');
    expect(result.connected_clients).toBe(1);
  });
  
  it('should respond to ListProviders', async () => {
    const result = await callUnary(client, 'ListProviders', {});
    expect(result.providers).toHaveLength(2);
    expect(result.providers[0].id).toBe('openai');
    expect(result.providers[0].configured).toBe(true);
  });
  
  it('should respond to ListModels', async () => {
    const result = await callUnary(client, 'ListModels', {});
    expect(result.models).toHaveLength(2);
    expect(result.models[0].id).toBe('openai/gpt-4o');
  });
});

describe('gRPC Chat Streaming', () => {
  it('should stream text chunks in order', async () => {
    const chunks: any[] = [];
    
    await new Promise<void>((resolve, reject) => {
      const stream = client.Chat({
        model: 'openai/gpt-4o',
        messages: [{ role: 2, content: 'Hi' }],
      });
      
      stream.on('data', (chunk: any) => {
        chunks.push(chunk);
      });
      
      stream.on('end', () => {
        resolve();
      });
      
      stream.on('error', (err: Error) => {
        reject(err);
      });
    });
    
    // Should have 3 text chunks + 1 done chunk
    expect(chunks.length).toBe(4);
    
    // Verify text chunks
    expect(chunks[0].text?.text).toBe('Hello');
    expect(chunks[1].text?.text).toBe(' world');
    expect(chunks[2].text?.text).toBe('!');
    
    // Verify done chunk
    expect(chunks[3].done?.finish_reason).toBe('stop');
  });
  
  it('should concatenate streamed text correctly', async () => {
    let fullText = '';
    
    await new Promise<void>((resolve, reject) => {
      const stream = client.Chat({
        model: 'openai/gpt-4o',
        messages: [{ role: 2, content: 'Hi' }],
      });
      
      stream.on('data', (chunk: any) => {
        if (chunk.text?.text) {
          fullText += chunk.text.text;
        }
      });
      
      stream.on('end', () => resolve());
      stream.on('error', (err: Error) => reject(err));
    });
    
    expect(fullText).toBe('Hello world!');
  });
  
  it('should record chat requests on the server', async () => {
    daemon.chatRequests.length = 0; // Reset
    
    await new Promise<void>((resolve, reject) => {
      const stream = client.Chat({
        model: 'test/model-123',
        messages: [
          { role: 1, content: 'You are helpful' },
          { role: 2, content: 'What is 2+2?' },
        ],
      });
      
      stream.on('data', () => {});
      stream.on('end', () => resolve());
      stream.on('error', (err: Error) => reject(err));
    });
    
    expect(daemon.chatRequests).toHaveLength(1);
    expect(daemon.chatRequests[0].model).toBe('test/model-123');
    expect(daemon.chatRequests[0].messages).toHaveLength(2);
  });
  
  it('should handle error responses from Chat', async () => {
    daemon.setChatOptions({ errorMessage: 'Model not found' });
    
    const chunks: any[] = [];
    
    await new Promise<void>((resolve, reject) => {
      const stream = client.Chat({
        model: 'bad/model',
        messages: [{ role: 2, content: 'Hi' }],
      });
      
      stream.on('data', (chunk: any) => {
        chunks.push(chunk);
      });
      
      stream.on('end', () => resolve());
      stream.on('error', (err: Error) => reject(err));
    });
    
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].error?.message).toBe('Model not found');
    
    // Reset
    daemon.setChatOptions({ chunks: ['Hello', ' world', '!'], chunkDelayMs: 10 });
  });
  
  it('should handle delayed chunks (simulating real provider latency)', async () => {
    daemon.setChatOptions({
      chunks: ['Thinking', '...', ' Done'],
      chunkDelayMs: 50,
      initialDelayMs: 100,
    });
    
    const chunks: any[] = [];
    const startTime = Date.now();
    
    await new Promise<void>((resolve, reject) => {
      const stream = client.Chat({
        model: 'openai/gpt-4o',
        messages: [{ role: 2, content: 'Hi' }],
      });
      
      stream.on('data', (chunk: any) => {
        chunks.push(chunk);
      });
      
      stream.on('end', () => resolve());
      stream.on('error', (err: Error) => reject(err));
    });
    
    const elapsed = Date.now() - startTime;
    
    // Should have text chunks + done
    expect(chunks.length).toBe(4);
    expect(chunks[0].text?.text).toBe('Thinking');
    
    // Should take at least initialDelay + (numChunks - 1) * chunkDelay
    expect(elapsed).toBeGreaterThan(100);
    
    // Reset
    daemon.setChatOptions({ chunks: ['Hello', ' world', '!'], chunkDelayMs: 10 });
  });
  
  it('should handle stream cancellation gracefully', async () => {
    daemon.setChatOptions({
      chunks: ['A', 'B', 'C', 'D', 'E'],
      chunkDelayMs: 100, // Slow enough to cancel mid-stream
    });
    
    const chunks: any[] = [];
    
    await new Promise<void>((resolve) => {
      const stream = client.Chat({
        model: 'openai/gpt-4o',
        messages: [{ role: 2, content: 'Hi' }],
      });
      
      stream.on('data', (chunk: any) => {
        chunks.push(chunk);
        // Cancel after receiving 2 chunks
        if (chunks.length >= 2) {
          stream.cancel();
        }
      });
      
      stream.on('end', () => resolve());
      stream.on('error', () => resolve()); // Cancelled stream may emit error
    });
    
    // Should have received at least 2 but fewer than all chunks
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThan(6); // 5 text + 1 done
    
    // Reset
    daemon.setChatOptions({ chunks: ['Hello', ' world', '!'], chunkDelayMs: 10 });
  });
  
  it('should handle multiple concurrent streams', async () => {
    daemon.setChatOptions({ chunks: ['A', 'B', 'C'], chunkDelayMs: 10 });
    
    const collectStream = (): Promise<string> => {
      return new Promise((resolve, reject) => {
        let text = '';
        const stream = client.Chat({
          model: 'openai/gpt-4o',
          messages: [{ role: 2, content: 'Hi' }],
        });
        
        stream.on('data', (chunk: any) => {
          if (chunk.text?.text) text += chunk.text.text;
        });
        stream.on('end', () => resolve(text));
        stream.on('error', (err: Error) => reject(err));
      });
    };
    
    // Launch 5 concurrent streams
    const results = await Promise.all([
      collectStream(),
      collectStream(),
      collectStream(),
      collectStream(),
      collectStream(),
    ]);
    
    // All should receive the same text
    for (const text of results) {
      expect(text).toBe('ABC');
    }
  });
  
  it('should handle empty messages array', async () => {
    daemon.setChatOptions({ chunks: ['OK'], chunkDelayMs: 0 });
    
    const chunks: any[] = [];
    
    await new Promise<void>((resolve, reject) => {
      const stream = client.Chat({
        model: 'openai/gpt-4o',
        messages: [],
      });
      
      stream.on('data', (chunk: any) => chunks.push(chunk));
      stream.on('end', () => resolve());
      stream.on('error', (err: Error) => reject(err));
    });
    
    expect(chunks.length).toBe(2); // text + done
    expect(chunks[0].text?.text).toBe('OK');
  });
  
  it('should handle large streaming responses', async () => {
    const largeChunks = Array.from({ length: 100 }, (_, i) => `chunk${i}`);
    daemon.setChatOptions({ chunks: largeChunks, chunkDelayMs: 0 });
    
    const received: string[] = [];
    
    await new Promise<void>((resolve, reject) => {
      const stream = client.Chat({
        model: 'openai/gpt-4o',
        messages: [{ role: 2, content: 'Hi' }],
      });
      
      stream.on('data', (chunk: any) => {
        if (chunk.text?.text) received.push(chunk.text.text);
      });
      stream.on('end', () => resolve());
      stream.on('error', (err: Error) => reject(err));
    });
    
    expect(received).toHaveLength(100);
    expect(received[0]).toBe('chunk0');
    expect(received[99]).toBe('chunk99');
    
    // Reset
    daemon.setChatOptions({ chunks: ['Hello', ' world', '!'], chunkDelayMs: 10 });
  });
});
