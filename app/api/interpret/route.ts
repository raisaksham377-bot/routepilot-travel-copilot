import { NextResponse } from 'next/server';
import { getAiConfig, aiAvailability } from '@/lib/ai/config';
import { parseInterpretRequestBody } from '@/lib/ai/requestBody';
import { interpretUtterance } from '@/lib/ai/interpret';
import { anthropicModelCaller } from '@/lib/ai/anthropicCaller';

/**
 * POST /api/interpret
 *
 * The first and, in Checkpoint B, only server route. It exists solely to hold
 * the API key, which must never reach the browser.
 *
 * Everything it will not do is as important as what it does:
 *   - it does not rank, score, or decide anything
 *   - it does not read or write the traveller profile
 *   - it does not return constraints as committed; it returns PROPOSALS
 *   - it is default-denied: AI_FEATURES_ENABLED must be exactly "true"
 *
 * This handler is a thin adapter. Gating lives in lib/ai/config, body
 * validation in lib/ai/requestBody, orchestration in lib/ai/interpret -- all
 * pure and unit-tested, because a Next route handler is awkward to test
 * directly and untestable code is where defects accumulate.
 *
 * Node runtime is explicit because the SDK is not edge-compatible.
 */
export const runtime = 'nodejs';
/** Never cached: this is a user action, not a page. */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const config = getAiConfig();

  /*
   * Gate BEFORE reading the body, deliberately.
   *
   * A deployment with AI switched off does no work at all: it does not read,
   * buffer, or deserialise attacker-supplied input. The cost is that a
   * malformed request to a disabled deployment gets 503 rather than 400, which
   * is the right trade -- the security property matters more than the
   * precision of an error code nobody can reach.
   */
  const availability = aiAvailability(config);
  if (!availability.available) {
    return NextResponse.json(
      { status: 'unavailable', reason: availability.reason, message: availability.message },
      { status: 503 },
    );
  }

  // Passphrase gate, when one is configured. Protects a non-local deployment
  // from anonymous use of the owner's credits.
  if (config.requiresPassphrase) {
    const supplied = request.headers.get('x-demo-passphrase') ?? '';
    if (supplied !== process.env.DEMO_PASSPHRASE) {
      return NextResponse.json(
        {
          status: 'unauthorised',
          message: 'This demo requires a passphrase for AI features. The form works without one.',
        },
        { status: 401 },
      );
    }
  }

  const body = parseInterpretRequestBody(await request.text(), config.maxInputChars);
  if (!body.ok) {
    return NextResponse.json(
      { status: 'input_rejected', reason: body.reason, message: body.message },
      { status: body.httpStatus },
    );
  }

  const result = await interpretUtterance(
    { utterance: body.request.utterance, constraints: body.request.constraints, config },
    anthropicModelCaller,
  );

  /*
   * Deliberately NOT logged anywhere in this handler: the raw utterance, the
   * redacted utterance, the constraint values, the model response, or the full
   * request body. Only shapes and outcomes would ever be safe to log, and
   * Checkpoint B logs nothing at all. A test asserts no console call exists in
   * any route file.
   */

  const httpStatus =
    result.status === 'ok'
      ? 200
      : result.status === 'input_rejected'
        ? 400
        : result.status === 'unavailable'
          ? 503
          : result.status === 'payload_blocked'
            ? 500
            : 502;

  return NextResponse.json(result, { status: httpStatus });
}

/** Any other method is a client error, answered without touching the model. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { status: 'method_not_allowed', message: 'POST a trip description to this endpoint.' },
    { status: 405 },
  );
}
