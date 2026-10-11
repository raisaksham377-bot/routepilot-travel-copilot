import type { Constraint, ConstraintKind } from '../schema/constraint';
import type { TripState } from '../schema/tripState';

/**
 * Committing an AI proposal to the trip state.
 *
 * Extracted from the component so the confirmation rules are testable without
 * a DOM. These rules are the difference between "the model suggested
 * something" and "the model changed your trip", so they need direct coverage.
 *
 * Three rules enforced here:
 *
 *  1. NOTHING is applied without passing through this function, which is only
 *     ever called from an explicit click. There is no auto-apply path.
 *
 *  2. A proposal may NEVER silently overwrite a constraint the human supplied.
 *     If the user said "arrive by noon" and the model infers 18:00, replacing
 *     it would discard what the user actually stated. That returns a CONFLICT
 *     requiring a second, explicit decision.
 *
 *  3. On application, `source` becomes 'user-edited'. The user has taken
 *     ownership of the value; the ledger should not keep calling it inferred.
 */

/** Sources that represent a human decision, which an inference must not overwrite. */
const HUMAN_SOURCES = ['stated', 'user-edited'] as const;

export function isHumanAuthored(constraint: Constraint): boolean {
  return (HUMAN_SOURCES as readonly string[]).includes(constraint.source);
}

export type ApplyOutcome =
  | { outcome: 'applied'; state: TripState }
  /** Replaced a value that was itself inferred, or that matched exactly. */
  | { outcome: 'replaced'; state: TripState; previous: Constraint }
  /**
   * Blocked: a human-authored constraint for this key already exists with a
   * different value. The caller must ask the user which to keep.
   */
  | { outcome: 'conflict'; existing: Constraint; proposed: Constraint; message: string };

function sameValue(a: Constraint, b: Constraint): boolean {
  return JSON.stringify(a.value) === JSON.stringify(b.value);
}

function describeValue(c: Constraint): string {
  return c.key === 'arrival_deadline'
    ? `${c.value.localDateTime} (${c.value.tz})`
    : String(c.value);
}

export function applyProposedConstraint(
  state: TripState,
  proposed: Constraint,
  asKind: ConstraintKind,
  options: { overrideHumanValue?: boolean } = {},
): ApplyOutcome {
  const existing = state.constraints.find((c) => c.key === proposed.key);
  const committed = { ...proposed, kind: asKind, source: 'user-edited' as const } as Constraint;

  const withReplacement = (): TripState => ({
    ...state,
    constraints: [...state.constraints.filter((c) => c.key !== proposed.key), committed],
  });

  if (existing === undefined) {
    return { outcome: 'applied', state: withReplacement() };
  }

  // Overwriting a human decision needs a second, explicit confirmation.
  if (isHumanAuthored(existing) && !sameValue(existing, proposed) && !options.overrideHumanValue) {
    return {
      outcome: 'conflict',
      existing,
      proposed,
      message:
        `You already set this to ${describeValue(existing)} (${existing.source}). ` +
        `The suggestion is ${describeValue(proposed)}. Keep yours, or replace it?`,
    };
  }

  return { outcome: 'replaced', state: withReplacement(), previous: existing };
}

/**
 * Turns the engine's own `needs` into questions for the user.
 *
 * Note the direction: the ENGINE decides what is missing, deterministically.
 * The model is never asked what information is required -- only, at most, to
 * phrase it. That keeps "what must be known before a recommendation" a
 * reviewable rule rather than a model opinion.
 */
export function needsToQuestions(needs: ReadonlyArray<{ message: string }>): string[] {
  return needs.map((n) => n.message);
}
