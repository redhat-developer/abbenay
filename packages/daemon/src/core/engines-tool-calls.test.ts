/**
 * Unit tests for OpenAI / flat tool_calls normalization in the engine adapter.
 */

import { describe, it, expect } from 'vitest';
import { extractToolCallFields } from './engines.js';

describe('extractToolCallFields', () => {
  it('reads OpenAI nested function tool_calls', () => {
    expect(extractToolCallFields({
      id: 'call_1',
      type: 'function',
      function: { name: 'web_search', arguments: '{"q":"x"}' },
    })).toEqual({
      id: 'call_1',
      name: 'web_search',
      arguments: '{"q":"x"}',
    });
  });

  it('reads flat Abbenay tool_calls', () => {
    expect(extractToolCallFields({
      id: 'call_2',
      name: 'search',
      arguments: { q: 'y' },
    })).toEqual({
      id: 'call_2',
      name: 'search',
      arguments: { q: 'y' },
    });
  });

  it('tolerates missing fields', () => {
    expect(extractToolCallFields(null)).toEqual({
      id: '',
      name: '',
      arguments: undefined,
    });
  });
});
