/*
 * TWO ZOD FLAVOURS IN ONE FILE, DELIBERATELY.
 *
 * The wire schema below is written against `zod/v4` -- the v4 API that ships
 * inside zod 3.25.x -- because `zodOutputFormat` from @anthropic-ai/sdk 0.133.0
 * imports `zod/v4` and will not accept a classic v3 schema (the two produce
 * structurally different ZodType internals; the mismatch is a compile error,
 * not a runtime surprise).
 *
 * The Checkpoint A domain schemas stay on the classic v3 API and are NOT
 * touched. That is the point of the split: the wire contract follows whatever
 * the SDK requires, while the engine's own validation is insulated from it.
 * These schemas only meet inside `toConstraint`, where a v4-validated wire
 * value is re-validated by the v3 domain schema before it can reach the engine.
 */
import * as z from 'zod/v4';
import {
  constraintSchema,
  type Constraint,
  type ConstraintKey,
} from '../schema/constraint';
import { cabinSchema } from '../schema/flightOption';
import { zonedWallClockSchema } from '../schema/time';

/**
 * The model's output contract -- a PROPOSAL, never a decision.
 *
 * Wire format note: every value crosses as a STRING, with the timezone carried
 * separately for a deadline. The model is not asked to produce a typed
 * Constraint. Instead `toConstraint()` parses each raw string through the
 * SAME Zod schemas Checkpoint A already uses, so the engine can never receive a
 * shape it did not already validate. A model that invents a cabin name or a
 * malformed timezone fails conversion and is reported, not applied.
 *
 * This also keeps the JSON schema flat, which models handle far more reliably
 * than a seven-way discriminated union over heterogeneous value types.
 */

export const CONSTRAINT_KEYS = [
  'arrival_deadline',
  'min_connection_minutes',
  'cabin_floor',
  'budget_ceiling',
  'origin',
  'destination',
  'avoid_overnight_connection',
] as const;

export const proposedConstraintSchema = z.object({
  key: z.enum(CONSTRAINT_KEYS),
  /**
   * The value as a plain string.
   *  arrival_deadline            -> "2026-11-04T18:00" (local, no offset)
   *  min_connection_minutes      -> "90"
   *  budget_ceiling              -> "1200"
   *  cabin_floor                 -> "business"
   *  origin / destination        -> "LHR"
   *  avoid_overnight_connection  -> "true" | "false"
   */
  rawValue: z.string(),
  /** IANA zone. Required for arrival_deadline, null otherwise. */
  timezone: z.string().nullable(),
  /** What the model thinks it should be. The USER decides, not this field. */
  suggestedKind: z.enum(['hard', 'soft']),
  confidence: z.number().min(0).max(1),
  /** Quoted or paraphrased support from the utterance. */
  evidence: z.string(),
});

export const constraintPatchSchema = z.object({
  proposals: z.array(proposedConstraintSchema),
  /** At most two, enforced below. Generated only when something is genuinely absent. */
  clarifyingQuestions: z.array(z.string()),
  /** Things mentioned that map to no supported constraint. Surfaced, not dropped. */
  unmapped: z.array(z.string()),
});

export type ProposedConstraint = z.infer<typeof proposedConstraintSchema>;
export type ConstraintPatch = z.infer<typeof constraintPatchSchema>;

export const MAX_CLARIFYING_QUESTIONS = 2;

export type ConversionResult =
  | { ok: true; constraint: Constraint }
  | { ok: false; key: ConstraintKey; reason: string };

/**
 * Converts one proposal into a real Constraint, or explains why it cannot.
 *
 * Two invariants are enforced here and are the heart of "proposals, not
 * decisions":
 *
 *   1. `source` is always 'inferred'. The model cannot claim a value was
 *      stated by the user, which is what makes the ledger able to render it
 *      distinctly and the user able to see what was assumed.
 *
 *   2. `kind` is always 'soft' at this stage, regardless of suggestedKind.
 *      A hard constraint ELIMINATES options, so the model is never permitted
 *      to create one. Promotion to hard is an explicit user action in the
 *      ledger. `suggestedKind` is preserved separately for display.
 */
export function toConstraint(proposed: ProposedConstraint): ConversionResult {
  const { key, rawValue, timezone } = proposed;
  const common = {
    kind: 'soft' as const,
    source: 'inferred' as const,
    confidence: proposed.confidence,
    note: proposed.evidence,
  };

  let candidate: unknown;

  switch (key) {
    case 'arrival_deadline': {
      if (timezone === null || timezone.trim() === '') {
        return {
          ok: false,
          key,
          reason:
            'A deadline needs a timezone to become a real moment. The model did not supply one, and the engine will not assume the local zone.',
        };
      }
      const wall = zonedWallClockSchema.safeParse({ localDateTime: rawValue, tz: timezone });
      if (!wall.success) {
        return {
          ok: false,
          key,
          reason: `Not a usable date-and-time plus timezone: ${wall.error.issues.map((i) => i.message).join('; ')}`,
        };
      }
      candidate = { key, value: wall.data, ...common };
      break;
    }

    case 'min_connection_minutes':
    case 'budget_ceiling': {
      const n = Number(rawValue.replace(/[,\s£$€]/g, ''));
      if (!Number.isFinite(n)) {
        return { ok: false, key, reason: `"${rawValue}" is not a number.` };
      }
      candidate = { key, value: key === 'min_connection_minutes' ? Math.round(n) : n, ...common };
      break;
    }

    case 'cabin_floor': {
      const cabin = cabinSchema.safeParse(rawValue.trim().toLowerCase().replace(/\s+/g, '_'));
      if (!cabin.success) {
        return {
          ok: false,
          key,
          reason: `"${rawValue}" is not a cabin this engine knows (economy, premium_economy, business, first).`,
        };
      }
      candidate = { key, value: cabin.data, ...common };
      break;
    }

    case 'origin':
    case 'destination': {
      const code = rawValue.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) {
        return { ok: false, key, reason: `"${rawValue}" is not a 3-letter airport code.` };
      }
      candidate = { key, value: code, ...common };
      break;
    }

    case 'avoid_overnight_connection': {
      const v = rawValue.trim().toLowerCase();
      if (v !== 'true' && v !== 'false') {
        return { ok: false, key, reason: `"${rawValue}" is not true or false.` };
      }
      candidate = { key, value: v === 'true', ...common };
      break;
    }
  }

  // Final gate: the real Checkpoint A schema has the last word.
  const parsed = constraintSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      key,
      reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, constraint: parsed.data };
}

export interface ConvertedPatch {
  /** Ready to show in the ledger for confirmation. All soft, all inferred. */
  accepted: Array<{ constraint: Constraint; suggestedKind: 'hard' | 'soft'; evidence: string }>;
  /** Proposals that failed conversion, with the reason. Never silently dropped. */
  rejected: Array<{ key: ConstraintKey; rawValue: string; reason: string }>;
  clarifyingQuestions: string[];
  unmapped: string[];
}

export function convertPatch(patch: ConstraintPatch): ConvertedPatch {
  const accepted: ConvertedPatch['accepted'] = [];
  const rejected: ConvertedPatch['rejected'] = [];

  for (const proposal of patch.proposals) {
    const result = toConstraint(proposal);
    if (result.ok) {
      accepted.push({
        constraint: result.constraint,
        suggestedKind: proposal.suggestedKind,
        evidence: proposal.evidence,
      });
    } else {
      rejected.push({ key: result.key, rawValue: proposal.rawValue, reason: result.reason });
    }
  }

  return {
    accepted,
    rejected,
    // Capped here rather than trusted from the model.
    clarifyingQuestions: patch.clarifyingQuestions.slice(0, MAX_CLARIFYING_QUESTIONS),
    unmapped: patch.unmapped,
  };
}
