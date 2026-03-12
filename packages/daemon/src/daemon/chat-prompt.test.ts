/**
 * CLI approval prompt input parsing tests
 *
 * Tests parseApprovalInput for all input variations including
 * the case-sensitive A vs a distinction that was a real bug.
 */

import { describe, it, expect } from 'vitest';
import { parseApprovalInput } from './chat.js';

describe('parseApprovalInput', () => {
  describe('allow once', () => {
    it.each(['a', 'allow', 'y', 'yes'])('"%s" -> allow', (input) => {
      expect(parseApprovalInput(input)).toBe('allow');
    });

    it('handles whitespace', () => {
      expect(parseApprovalInput('  a  ')).toBe('allow');
      expect(parseApprovalInput('\ty\n')).toBe('allow');
    });
  });

  describe('allow always (case-sensitive)', () => {
    it('"A" (uppercase) -> allow-always', () => {
      expect(parseApprovalInput('A')).toBe('allow-always');
    });

    it('"always" -> allow-always', () => {
      expect(parseApprovalInput('always')).toBe('allow-always');
    });

    it('"ALWAYS" -> allow-always', () => {
      expect(parseApprovalInput('ALWAYS')).toBe('allow-always');
    });

    it('"Always" -> allow-always', () => {
      expect(parseApprovalInput('Always')).toBe('allow-always');
    });

    it('"A" is NOT "allow" — this was a real bug', () => {
      const decision = parseApprovalInput('A');
      expect(decision).not.toBe('allow');
      expect(decision).toBe('allow-always');
    });
  });

  describe('deny', () => {
    it.each(['d', 'deny', 'n', 'no'])('"%s" -> deny', (input) => {
      expect(parseApprovalInput(input)).toBe('deny');
    });
  });

  describe('abort', () => {
    it.each(['b', 'abort'])('"%s" -> abort', (input) => {
      expect(parseApprovalInput(input)).toBe('abort');
    });
  });

  describe('invalid input', () => {
    it.each(['', 'x', 'maybe', '123', 'allowalways'])('"%s" -> null (re-prompt)', (input) => {
      expect(parseApprovalInput(input)).toBeNull();
    });

    it('whitespace-only -> null', () => {
      expect(parseApprovalInput('   ')).toBeNull();
    });
  });

  describe('case insensitivity for non-A inputs', () => {
    it.each(['ALLOW', 'Allow', 'YES', 'Yes'])('"%s" -> allow', (input) => {
      expect(parseApprovalInput(input)).toBe('allow');
    });

    it.each(['DENY', 'Deny', 'NO', 'No'])('"%s" -> deny', (input) => {
      expect(parseApprovalInput(input)).toBe('deny');
    });

    it.each(['ABORT', 'Abort', 'B'])('"%s" -> abort', (input) => {
      expect(parseApprovalInput(input)).toBe('abort');
    });
  });
});
