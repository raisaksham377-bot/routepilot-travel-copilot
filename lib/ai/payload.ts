import { z } from 'zod';
import type { Constraint, ConstraintKey, ConstraintKind } from '../schema/constraint';

/**
 * The outbound payload contract.
 *
 * This is the structural guarantee behind the privacy claim. Rather than
 * trusting call sites to remember what not to send, the payload type physically
 * cannot carry a profile, a trip state, an option, a measure, or a trace --
 * there is nowhere to put them.
 *
 * What goes out:
 *   - the redacted utterance
 *   - the KEYS and KINDS of constraints already recorded
 *
 * What never goes out:
 *   - constraint VALUES (knowing a deadline exists is enough to patch it
 *     coherently; knowing it is 18:00 in New York is not needed)
 *   - TravelerProfile, in whole or in part, including the role label
 *   - FlightOption records, measures, rankings, recommendations, traces
 *
 * `tests/ai-payload.test.ts` asserts the serialised body against an allowlist,
 * so widening it in a future refactor fails the build rather than leaking.
 */

export const constraintContextEntrySchema = z.object({
  key: z.string(),
  kind: z.enum(['hard', 'soft']),
});

export const interpretPayloadSchema = z
  .object({
    utterance: z.string().min(1),
    constraintContext: z.array(constraintContextEntrySchema),
  })
  .strict(); // rejects any additional property, so a leak fails validation

export type ConstraintContextEntry = z.infer<typeof constraintContextEntrySchema>;
export type InterpretPayload = z.infer<typeof interpretPayloadSchema>;

/** Every key the payload is permitted to contain, at any depth. */
export const ALLOWED_PAYLOAD_KEYS = ['utterance', 'constraintContext', 'key', 'kind'] as const;

/**
 * Reduces the recorded constraints to keys and kinds only.
 *
 * Note the deliberate discarding of `value`, `source`, `confidence` and `note`.
 */
export function buildConstraintContext(constraints: readonly Constraint[]): ConstraintContextEntry[] {
  return constraints.map((c) => ({ key: c.key as ConstraintKey, kind: c.kind as ConstraintKind }));
}

export function buildInterpretPayload(args: {
  redactedUtterance: string;
  constraints: readonly Constraint[];
}): InterpretPayload {
  return interpretPayloadSchema.parse({
    utterance: args.redactedUtterance,
    constraintContext: buildConstraintContext(args.constraints),
  });
}

/**
 * Walks a serialised payload and returns any key outside the allowlist.
 * Used by the route as a last line of defence and by the test suite.
 */
export function findDisallowedKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findDisallowedKeys(v, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (!(ALLOWED_PAYLOAD_KEYS as readonly string[]).includes(k)) {
        bad.push(`${path}.${k}`);
      }
      bad.push(...findDisallowedKeys(v, `${path}.${k}`));
    }
    return bad;
  }
  return [];
}
