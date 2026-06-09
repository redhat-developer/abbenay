import * as assert from 'assert';
import { getNonce } from '../../webviews/shared/getNonce';

suite('getNonce', () => {
  test('should return a 32-character hex string', () => {
    const nonce = getNonce();
    assert.strictEqual(nonce.length, 32);
    assert.match(nonce, /^[0-9a-f]{32}$/);
  });

  test('should return unique values on consecutive calls', () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 100; i++) {
      nonces.add(getNonce());
    }
    assert.strictEqual(nonces.size, 100, 'All 100 nonces should be unique');
  });
});
