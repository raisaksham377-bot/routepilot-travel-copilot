import { z } from 'zod';
import { constraintSchema, type Constraint } from '../schema/constraint';

/**
 * Request-body validation for the interpret route, extracted as a pure
 * function so it can actually be tested.
 *
 * Why this file exists: the route gates on AI availability BEFORE reading the
 * body, which is the right order -- a disabled deployment should do no work at
 * all, and should not be made to parse attacker-supplied JSON. The consequence
 * is that the size and JSON-validity branches are unreachable end-to-end
 * without credentials configured, so testing them through HTTP is impossible
 * on a keyless machine.
 *
 * Rather than leave those branches unverified, the logic lives here and is
 * exercised directly. The route becomes a thin adapter over it.
 */

export const interpretRequestSchema = z.object({
  utterance: z.string(),
  constraints: z.array(constraintSchema).default([]),
});

export type InterpretRequest = { utterance: string; constraints: Constraint[] };

export type BodyParseResult =
  | { ok: true; request: InterpretRequest }
  | {
      ok: false;
      httpStatus: 400 | 413;
      reason: 'too_long' | 'malformed';
      message: string;
    };

/** Multiplier turning a character budget into a byte-ish body ceiling. */
export const BODY_LIMIT_MULTIPLIER = 4;

export function parseInterpretRequestBody(rawBody: string, maxInputChars: number): BodyParseResult {
  const byteLimit = maxInputChars * BODY_LIMIT_MULTIPLIER;

  // Size is checked FIRST, before JSON.parse, so an oversized payload is never
  // deserialised. Parsing a 50MB body to then reject it would be the bug.
  if (rawBody.length > byteLimit) {
    return {
      ok: false,
      httpStatus: 413,
      reason: 'too_long',
      message: `Request body exceeds ${byteLimit} characters.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      ok: false,
      httpStatus: 400,
      reason: 'malformed',
      message: 'Body is not valid JSON.',
    };
  }

  const validated = interpretRequestSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      httpStatus: 400,
      reason: 'malformed',
      // Field PATHS only. The submitted content is never echoed back, so a
      // rejected request cannot be used to reflect data through the server.
      message: `Invalid request: ${validated.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}`,
    };
  }

  return {
    ok: true,
    request: { utterance: validated.data.utterance, constraints: validated.data.constraints },
  };
}
