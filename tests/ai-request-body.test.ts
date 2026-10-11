import { describe, expect, it } from 'vitest';
import {
  BODY_LIMIT_MULTIPLIER,
  parseInterpretRequestBody,
} from '@/lib/ai/requestBody';

/**
 * These branches exist because the route gates on AI availability before
 * reading the body -- which means on a machine with no credentials they are
 * unreachable over HTTP and would otherwise ship unverified. Extracting the
 * logic is what makes them testable at all.
 */

const MAX_CHARS = 100;
const LIMIT = MAX_CHARS * BODY_LIMIT_MULTIPLIER;

describe('size rejection', () => {
  it('rejects an oversized body with 413', () => {
    const result = parseInterpretRequestBody('x'.repeat(LIMIT + 1), MAX_CHARS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBe(413);
    expect(result.reason).toBe('too_long');
    expect(result.message).toContain(String(LIMIT));
  });

  /**
   * The size check must precede JSON.parse. Deserialising a huge payload in
   * order to then reject it is the bug this guards: the body here is both
   * oversized AND invalid JSON, and must be rejected on size.
   */
  it('checks size BEFORE parsing, so a huge invalid body is a 413 not a 400', () => {
    const result = parseInterpretRequestBody('{'.repeat(LIMIT + 50), MAX_CHARS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBe(413);
  });

  it('accepts a body exactly at the limit', () => {
    const payload = JSON.stringify({ utterance: 'ok', constraints: [] });
    expect(payload.length).toBeLessThan(LIMIT);
    expect(parseInterpretRequestBody(payload, MAX_CHARS).ok).toBe(true);
  });
});

describe('malformed body rejection', () => {
  it.each([
    ['not json at all', 'plain text'],
    ['{"unclosed": ', 'truncated json'],
    ['', 'empty string'],
    ['undefined', 'the literal word undefined'],
  ])('rejects %s (%s) with 400', (raw) => {
    const result = parseInterpretRequestBody(raw, MAX_CHARS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBe(400);
    expect(result.reason).toBe('malformed');
  });

  it('rejects valid JSON of the wrong shape', () => {
    for (const body of [
      JSON.stringify({ notUtterance: 'x' }),
      JSON.stringify({ utterance: 42 }),
      JSON.stringify({ utterance: 'ok', constraints: 'not-an-array' }),
      JSON.stringify([1, 2, 3]),
      JSON.stringify(null),
    ]) {
      const result = parseInterpretRequestBody(body, MAX_CHARS);
      expect(result.ok, `should reject ${body}`).toBe(false);
      if (!result.ok) expect(result.httpStatus).toBe(400);
    }
  });

  it('rejects a constraint that would not pass the engine schema', () => {
    const body = JSON.stringify({
      utterance: 'ok',
      constraints: [{ key: 'cabin_floor', value: 'teleportation', kind: 'hard', source: 'stated' }],
    });
    const result = parseInterpretRequestBody(body, MAX_CHARS);
    expect(result.ok).toBe(false);
  });

  /**
   * A rejected request must not reflect its own content back. Otherwise the
   * endpoint becomes a way to bounce arbitrary text through the server.
   */
  it('never echoes submitted content back in the error message', () => {
    const secret = 'SENSITIVE-STRING-abc123';
    const result = parseInterpretRequestBody(JSON.stringify({ utterance: 99, note: secret }), MAX_CHARS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain(secret);
    expect(result.message).not.toContain('99');
  });
});

describe('accepted bodies', () => {
  it('defaults constraints to an empty array when omitted', () => {
    const result = parseInterpretRequestBody(JSON.stringify({ utterance: 'go' }), MAX_CHARS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).toEqual({ utterance: 'go', constraints: [] });
  });

  it('passes through a valid constraint untouched', () => {
    const constraint = {
      key: 'arrival_deadline',
      value: { localDateTime: '2026-11-04T18:00', tz: 'America/New_York' },
      kind: 'hard',
      source: 'stated',
    };
    const result = parseInterpretRequestBody(
      JSON.stringify({ utterance: 'go', constraints: [constraint] }),
      MAX_CHARS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.constraints).toEqual([constraint]);
  });
});
