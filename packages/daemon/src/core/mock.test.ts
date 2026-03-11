/**
 * Mock LLM provider tests
 * 
 * Verifies that the mock provider (ported from Rust) works correctly
 * for all modes: echo, fixed, error, empty, slow.
 * 
 * These tests don't require any API keys or network access.
 */

import { describe, it, expect } from 'vitest';
import { mockStreamChat, getMockModels, type MockChatChunk } from './mock.js';

/**
 * Helper: collect all chunks from the mock provider
 */
async function collectChat(
  modelId: string,
  messages: Array<{ role: string; content: string }>,
): Promise<{ text: string; chunks: MockChatChunk[]; finishReason?: string }> {
  const chunks: MockChatChunk[] = [];
  let text = '';
  let finishReason: string | undefined;
  
  for await (const chunk of mockStreamChat(modelId, messages)) {
    chunks.push(chunk);
    if (chunk.type === 'text' && chunk.text) {
      text += chunk.text;
    }
    if (chunk.type === 'done') {
      finishReason = chunk.finishReason;
    }
  }
  
  return { text, chunks, finishReason };
}

const userMessage = (content: string) => [{ role: 'user', content }];

describe('Mock Provider - Model List', () => {
  it('should return static model list without API call', () => {
    const models = getMockModels();
    expect(models.length).toBeGreaterThanOrEqual(4);
    
    const ids = models.map(m => m.id);
    expect(ids).toContain('echo');
    expect(ids).toContain('fixed');
    expect(ids).toContain('error');
    expect(ids).toContain('empty');
    expect(ids).toContain('slow');
  });
  
  it('should have mock as provider for all models', () => {
    const models = getMockModels();
    for (const m of models) {
      expect(m.provider).toBe('mock');
    }
  });
  
  it('should report full capabilities', () => {
    const models = getMockModels();
    for (const m of models) {
      expect(m.capabilities?.supportsTools).toBe(true);
      expect(m.capabilities?.supportsVision).toBe(true);
    }
  });
});

describe('Mock Provider - Echo Mode', () => {
  it('should echo the user message', async () => {
    const { text } = await collectChat('echo', userMessage('Hello, world!'));
    expect(text).toContain('Echo: Hello, world!');
  });
  
  it('should echo with mock-echo alias', async () => {
    const { text } = await collectChat('mock-echo', userMessage('Test'));
    expect(text).toContain('Echo: Test');
  });
  
  it('should echo the LAST user message', async () => {
    const messages = [
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'Second' },
    ];
    const { text } = await collectChat('echo', messages);
    expect(text).toContain('Echo: Second');
    expect(text).not.toContain('First');
  });
  
  it('should fall back to echo for unknown model names', async () => {
    const { text } = await collectChat('gpt-4o', userMessage('Fallback test'));
    expect(text).toContain('Echo: Fallback test');
  });
  
  it('should end with done chunk', async () => {
    const { finishReason } = await collectChat('echo', userMessage('Hi'));
    expect(finishReason).toBe('stop');
  });
  
  it('should stream in multiple chunks', async () => {
    const { chunks } = await collectChat('echo', userMessage('A longer message that should be split into multiple chunks'));
    const textChunks = chunks.filter(c => c.type === 'text');
    expect(textChunks.length).toBeGreaterThan(1);
  });
});

describe('Mock Provider - Fixed Mode', () => {
  it('should return default fixed response', async () => {
    const { text } = await collectChat('fixed', userMessage('Anything'));
    expect(text).toBe('Hello from MockProvider!');
  });
  
  it('should return custom fixed response', async () => {
    const { text } = await collectChat('fixed:Custom response text', userMessage('Anything'));
    expect(text).toBe('Custom response text');
  });
  
  it('should work with mock-fixed alias', async () => {
    const { text } = await collectChat('mock-fixed', userMessage('Anything'));
    expect(text).toBe('Hello from MockProvider!');
  });
  
  it('should ignore message content', async () => {
    const { text: text1 } = await collectChat('fixed:Same', userMessage('One'));
    const { text: text2 } = await collectChat('fixed:Same', userMessage('Two'));
    expect(text1).toBe(text2);
  });
});

describe('Mock Provider - Error Mode', () => {
  it('should throw with default error message', async () => {
    await expect(collectChat('error', userMessage('Hi'))).rejects.toThrow('Mock error for testing');
  });
  
  it('should throw with custom error message', async () => {
    await expect(collectChat('error:Connection timeout', userMessage('Hi'))).rejects.toThrow('Connection timeout');
  });
  
  it('should work with mock-error alias', async () => {
    await expect(collectChat('mock-error', userMessage('Hi'))).rejects.toThrow();
  });
});

describe('Mock Provider - Empty Mode', () => {
  it('should return no text content', async () => {
    const { text, chunks } = await collectChat('empty', userMessage('Hi'));
    expect(text).toBe('');
    
    const textChunks = chunks.filter(c => c.type === 'text');
    expect(textChunks).toHaveLength(0);
  });
  
  it('should still return done chunk', async () => {
    const { finishReason } = await collectChat('empty', userMessage('Hi'));
    expect(finishReason).toBe('stop');
  });
});

describe('Mock Provider - Slow Mode', () => {
  it('should echo with delay', async () => {
    const { text } = await collectChat('slow', userMessage('Hi'));
    expect(text).toContain('Echo: Hi');
  });
  
  it('should respect custom delay', async () => {
    const start = Date.now();
    const { text } = await collectChat(
      'slow:50',
      userMessage('This is a longer message that will be split into multiple chunks for testing'),
    );
    const elapsed = Date.now() - start;
    
    expect(text).toContain('Echo: This is a longer message');
    expect(elapsed).toBeGreaterThan(50);
  });
  
  it('should work with mock-slow alias', async () => {
    const { text } = await collectChat('mock-slow', userMessage('Test'));
    expect(text).toContain('Echo: Test');
  });
});

describe('Mock Provider - Case Insensitivity', () => {
  it('should handle uppercase model names', async () => {
    const { text } = await collectChat('ECHO', userMessage('Test'));
    expect(text).toContain('Echo: Test');
  });
  
  it('should handle mixed case', async () => {
    const { text } = await collectChat('Mock-Echo', userMessage('Test'));
    expect(text).toContain('Echo: Test');
  });
  
  it('should handle FIXED with custom text (preserves case in response)', async () => {
    const { text } = await collectChat('FIXED:Hello World', userMessage('x'));
    expect(text).toBe('Hello World');
  });
});
