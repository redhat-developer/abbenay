/**
 * Mock LLM provider for testing
 * 
 * Provides deterministic, configurable responses without network dependencies.
 * Mock LLM provider for testing without API keys.
 * 
 * Mode is driven by the model name:
 *   - "echo" / "mock-echo"       → Echo back the last user message
 *   - "fixed" / "mock-fixed"     → Return "Hello from MockProvider!"
 *   - "fixed:custom text"        → Return custom text
 *   - "error" / "mock-error"     → Throw an error
 *   - "error:custom message"     → Throw error with custom message
 *   - "empty" / "mock-empty"     → Return no content
 *   - "slow" / "mock-slow"       → Echo with 200ms delay per chunk
 *   - "slow:500"                 → Echo with custom delay (ms) per chunk
 *   - any other                  → Falls back to echo mode
 * 
 * Usage:
 *   model = "mock/echo"           → sends to mock provider, echo mode
 *   model = "mock/fixed:hi there" → sends to mock provider, fixed response
 *   model = "mock/error:timeout"  → sends to mock provider, throws "timeout"
 */

/**
 * Basic model info returned by getMockModels().
 * This is a simple shape that adapter.ts maps to DiscoveredModel.
 */
export interface MockModelInfo {
  id: string;
  provider: string;
  contextWindow: number;
  capabilities?: {
    supportsTools?: boolean;
    supportsVision?: boolean;
  };
}

/**
 * Default chunk size for splitting text into streaming chunks
 */
const DEFAULT_CHUNK_SIZE = 20;

/**
 * Parse mock mode from the model ID (the part after "mock/")
 */
interface MockMode {
  type: 'echo' | 'fixed' | 'error' | 'empty' | 'slow';
  text?: string;       // For fixed: the response text; for error: the error message
  delayMs?: number;    // For slow mode
}

function parseMockMode(modelId: string): MockMode {
  const lower = modelId.toLowerCase();
  
  // Echo
  if (lower === 'echo' || lower === 'mock-echo') {
    return { type: 'echo' };
  }
  
  // Empty
  if (lower === 'empty' || lower === 'mock-empty') {
    return { type: 'empty' };
  }
  
  // Fixed with optional custom text
  if (lower === 'fixed' || lower === 'mock-fixed') {
    return { type: 'fixed', text: 'Hello from MockProvider!' };
  }
  if (lower.startsWith('fixed:')) {
    return { type: 'fixed', text: modelId.substring(6) || 'Hello from MockProvider!' };
  }
  
  // Error with optional custom message
  if (lower === 'error' || lower === 'mock-error') {
    return { type: 'error', text: 'Mock error for testing' };
  }
  if (lower.startsWith('error:')) {
    return { type: 'error', text: modelId.substring(6) || 'Mock error for testing' };
  }
  
  // Slow (echo with delay)
  if (lower === 'slow' || lower === 'mock-slow') {
    return { type: 'slow', delayMs: 200 };
  }
  if (lower.startsWith('slow:')) {
    const ms = parseInt(modelId.substring(5), 10);
    return { type: 'slow', delayMs: isNaN(ms) ? 200 : ms };
  }
  
  // Default: echo
  return { type: 'echo' };
}

/**
 * Split text into chunks for streaming
 */
function splitIntoChunks(text: string, chunkSize: number = DEFAULT_CHUNK_SIZE): string[] {
  if (!text || chunkSize <= 0) return [text];
  
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.substring(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Extract the last user message content
 */
function getLastUserMessage(messages: Array<{ role: string; content: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].content) {
      return messages[i].content;
    }
  }
  return 'Hello from MockProvider!';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chat chunk type — matches the ChatChunk union from adapter.ts.
 */
export type MockChatChunk =
  | { type: 'text'; text: string }
  | { type: 'done'; finishReason: string };

/**
 * Stream a mock chat response.
 * 
 * This is the mock equivalent of the real `streamChat` in adapter.ts.
 */
export async function* mockStreamChat(
  modelId: string,
  messages: Array<{ role: string; content: string }>,
): AsyncGenerator<MockChatChunk> {
  const mode = parseMockMode(modelId);
  
  console.log(`[mock] Mode: ${mode.type}, model: ${modelId}`);
  
  switch (mode.type) {
    case 'echo': {
      const userMsg = getLastUserMessage(messages);
      const response = `Echo: ${userMsg}`;
      const chunks = splitIntoChunks(response);
      
      for (const chunk of chunks) {
        yield { type: 'text', text: chunk };
      }
      yield { type: 'done', finishReason: 'stop' };
      break;
    }
    
    case 'fixed': {
      const response = mode.text || 'Hello from MockProvider!';
      const chunks = splitIntoChunks(response);
      
      for (const chunk of chunks) {
        yield { type: 'text', text: chunk };
      }
      yield { type: 'done', finishReason: 'stop' };
      break;
    }
    
    case 'empty': {
      yield { type: 'done', finishReason: 'stop' };
      break;
    }
    
    case 'error': {
      throw new Error(mode.text || 'Mock error for testing');
    }
    
    case 'slow': {
      const userMsg = getLastUserMessage(messages);
      const response = `Echo: ${userMsg}`;
      const chunks = splitIntoChunks(response);
      const delayMs = mode.delayMs || 200;
      
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await sleep(delayMs);
        yield { type: 'text', text: chunks[i] };
      }
      yield { type: 'done', finishReason: 'stop' };
      break;
    }
  }
}

/**
 * Return the list of mock models (static, no API call needed).
 */
export function getMockModels(): MockModelInfo[] {
  return [
    {
      id: 'echo',
      provider: 'mock',
      contextWindow: 128000,
      capabilities: { supportsTools: true, supportsVision: true },
    },
    {
      id: 'fixed',
      provider: 'mock',
      contextWindow: 128000,
      capabilities: { supportsTools: true, supportsVision: true },
    },
    {
      id: 'error',
      provider: 'mock',
      contextWindow: 128000,
      capabilities: { supportsTools: true, supportsVision: true },
    },
    {
      id: 'empty',
      provider: 'mock',
      contextWindow: 128000,
      capabilities: { supportsTools: true, supportsVision: true },
    },
    {
      id: 'slow',
      provider: 'mock',
      contextWindow: 128000,
      capabilities: { supportsTools: true, supportsVision: true },
    },
  ];
}
