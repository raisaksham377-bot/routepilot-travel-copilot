import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { classifyError } from '@/lib/ai/anthropicCaller';
import type { ModelFailureKind } from '@/lib/ai/interpret';

/**
 * SDK error taxonomy -> our failure kinds.
 *
 * This mapping is the only project logic that depends on the SDK's error
 * classes, and getting it wrong fails SILENTLY in the worst way: a
 * misclassified 404 would tell the user "could not reach the provider" when the
 * real cause is a model their account cannot access, sending them to debug
 * networking instead of their ANTHROPIC_MODEL value.
 *
 * Note these tests construct real SDK error instances rather than stubs, so
 * they would catch a class being renamed or re-parented in an SDK upgrade.
 * No network is involved -- an error object is just an object.
 */

function expectKind(error: unknown, kind: ModelFailureKind, detailFragment?: string) {
  const outcome = classifyError(error, Anthropic);
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.kind).toBe(kind);
  if (detailFragment !== undefined) expect(outcome.detail).toContain(detailFragment);
}

/** Minimal valid headers object for the SDK error constructors. */
const headers = new Headers();

describe('each SDK error class maps to the right failure kind', () => {
  it('a timeout maps to timeout, not transport_error', () => {
    expectKind(new Anthropic.APIConnectionTimeoutError({ message: 'timed out' }), 'timeout');
  });

  it('an authentication failure maps to authentication_failed', () => {
    expectKind(
      new Anthropic.AuthenticationError(401, { error: { message: 'bad key' } }, 'unauthorised', headers),
      'authentication_failed',
    );
  });

  /**
   * The case most likely to be misdiagnosed. A 404 on a messages request means
   * the model id is not available to this account -- an actionable
   * configuration problem, not a network problem.
   */
  it('a 404 maps to model_unavailable, so the user checks ANTHROPIC_MODEL', () => {
    expectKind(
      new Anthropic.NotFoundError(404, { error: { message: 'model not found' } }, 'not found', headers),
      'model_unavailable',
      'model not found',
    );
  });

  it('rate limiting maps to rate_limited', () => {
    expectKind(
      new Anthropic.RateLimitError(429, { error: { message: 'slow down' } }, 'rate limited', headers),
      'rate_limited',
    );
  });

  it('a 400 maps to malformed_output', () => {
    expectKind(
      new Anthropic.BadRequestError(400, { error: { message: 'bad request' } }, 'bad request', headers),
      'malformed_output',
    );
  });

  it('any other APIError falls back to transport_error with its status', () => {
    expectKind(
      new Anthropic.InternalServerError(500, { error: { message: 'boom' } }, 'server error', headers),
      'transport_error',
      '500',
    );
  });

  it('a plain non-SDK error falls back to transport_error', () => {
    expectKind(new Error('something odd'), 'transport_error', 'unexpected');
    expectKind('a string', 'transport_error');
    expectKind(null, 'transport_error');
    expectKind(undefined, 'transport_error');
  });
});

describe('classification order is specific-before-general', () => {
  /**
   * Every class tested above extends APIError. If the broad APIError check ran
   * first it would swallow all of them and every failure would read
   * transport_error. This asserts the specific classes really do win.
   */
  it('specific subclasses are not swallowed by the APIError branch', () => {
    const specific: Array<[unknown, ModelFailureKind]> = [
      [new Anthropic.AuthenticationError(401, {}, 'x', headers), 'authentication_failed'],
      [new Anthropic.NotFoundError(404, {}, 'x', headers), 'model_unavailable'],
      [new Anthropic.RateLimitError(429, {}, 'x', headers), 'rate_limited'],
      [new Anthropic.BadRequestError(400, {}, 'x', headers), 'malformed_output'],
    ];

    for (const [error, expected] of specific) {
      expect(error instanceof Anthropic.APIError, 'precondition: extends APIError').toBe(true);
      const outcome = classifyError(error, Anthropic);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.kind).toBe(expected);
    }
  });

  it('never returns a success outcome for any error input', () => {
    for (const error of [
      new Anthropic.APIConnectionTimeoutError({ message: 'x' }),
      new Anthropic.AuthenticationError(401, {}, 'x', headers),
      new Error('x'),
      {},
      0,
    ]) {
      expect(classifyError(error, Anthropic).ok).toBe(false);
    }
  });

  it('a detail string is always present and never contains credential material', () => {
    for (const error of [
      new Anthropic.AuthenticationError(401, { error: { message: 'invalid x-api-key' } }, 'x', headers),
      new Anthropic.NotFoundError(404, {}, 'x', headers),
      new Error('boom'),
    ]) {
      const outcome = classifyError(error, Anthropic);
      if (outcome.ok) throw new Error('expected failure');
      expect(outcome.detail.length).toBeGreaterThan(0);
      expect(outcome.detail).not.toMatch(/sk-ant/);
    }
  });
});
