import { describe, expect, it } from 'vitest';
import { Message } from '../../../proto-ts/src/abbenay/v1/service.js';

describe('multimodal protobuf message transport', () => {
  it('round-trips inline content parts with MIME type and bytes', () => {
    const encoded = Message.encode({
      role: 0,
      content: 'Describe this image',
      toolCalls: [],
      toolCallId: '',
      name: '',
      contentParts: [{
        text: '',
        mimeType: 'image/png',
        data: Uint8Array.from([1, 2, 3]),
        uri: '',
      }],
    }).finish();

    const decoded = Message.decode(encoded);
    expect(decoded.content).toBe('Describe this image');
    expect(decoded.contentParts).toHaveLength(1);
    expect(decoded.contentParts[0]?.mimeType).toBe('image/png');
    expect([...((decoded.contentParts[0]?.data as Uint8Array) || [])]).toEqual([1, 2, 3]);
  });
});