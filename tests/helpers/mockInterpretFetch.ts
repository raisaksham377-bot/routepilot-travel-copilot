import { vi } from 'vitest';
import type { InterpretResult } from '@/lib/ai/interpret';
import type { ConstraintPatch } from '@/lib/ai/constraintPatch';
import { convertPatch } from '@/lib/ai/constraintPatch';

/**
 * Mocked `/api/interpret` responses for component tests.
 *
 * `fetch` is stubbed per test with `vi.stubGlobal`, which vitest restores
 * automatically. The network guard in setup.no-network.ts stays installed
 * underneath: if a test forgets to stub, fetch rejects and the component shows
 * its transport-failure path. That is a safe default -- a missing stub can
 * never become a real request.
 *
 * Note what is NOT done here: no mock API route is added to the application.
 * The production route is untouched; only the browser-side `fetch` boundary is
 * replaced, which is the actual seam between the component and the server.
 */

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Stubs fetch to return a given InterpretResult with a matching HTTP status. */
export function stubInterpretResult(result: InterpretResult, status = 200): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => jsonResponse(result, status));
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** Stubs a successful interpretation built from a raw model patch. */
export function stubSuccessfulPatch(patch: ConstraintPatch, redactedCategories: string[] = []) {
  return stubInterpretResult({
    status: 'ok',
    patch: convertPatch(patch),
    redactedCategories,
  });
}

/** Stubs a structured model failure, as the real route would return it (502). */
export function stubModelFailure(
  kind: Extract<InterpretResult, { status: 'model_failed' }>['kind'],
  message: string,
) {
  return stubInterpretResult({ status: 'model_failed', kind, message }, 502);
}

/** Stubs the AI capability being switched off or keyless, as the route returns (503). */
export function stubUnavailable(reason: 'feature_disabled' | 'no_credentials', message: string) {
  return stubInterpretResult({ status: 'unavailable', reason, message }, 503);
}

/**
 * Stubs a request that never completes -- a rejected fetch, which is what a
 * dropped connection actually looks like in the browser.
 */
export function stubTransportFailure() {
  const spy = vi.fn(async () => {
    throw new TypeError('Failed to fetch');
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** A patch proposing a business-class cabin floor. */
export const CABIN_PATCH: ConstraintPatch = {
  proposals: [
    {
      key: 'cabin_floor',
      rawValue: 'business',
      timezone: null,
      suggestedKind: 'hard',
      confidence: 0.92,
      evidence: 'needs to work on the flight',
    },
  ],
  clarifyingQuestions: [],
  unmapped: [],
};

/*
 * Deadline-conflict patches are built inline in the workspace tests rather
 * than shared from here, because the conflicting value has to differ from
 * whatever the loaded scenario already seeded. A fixed constant would silently
 * match the seeded value and test the no-conflict path instead.
 */
