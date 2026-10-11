import type { ConstraintKey } from '../schema/constraint';
import { RELAXABLE_CONSTRAINTS, type RelaxableConstraint } from '../schema/constraint';
import type { ExcludedOption, RelaxationReport, SingleConstraintRelaxation } from './types';
import { formatDuration } from './time';

export const RELAXATION_DISCLAIMER =
  'Each figure relaxes one named constraint and holds every other constraint unchanged. ' +
  'This is not a search for the smallest overall change across several constraints, and no ' +
  'claim is made that a different combination would not do better.';

function isRelaxable(key: ConstraintKey): key is RelaxableConstraint {
  return (RELAXABLE_CONSTRAINTS as readonly ConstraintKey[]).includes(key);
}

/**
 * Scenario S8: no option satisfies every hard constraint.
 *
 * DELIBERATELY NARROW. Finding the globally minimum relaxation across multiple
 * interacting constraints is a much larger optimisation problem than this MVP
 * needs, and pretending to solve it would be exactly the kind of false
 * precision the rest of the engine avoids.
 *
 * So the rule is: consider only options that violate EXACTLY ONE relaxable hard
 * constraint. For those, the required amount is arithmetic -- how late the
 * deadline would have to be, or how much more budget a specific option needs.
 * Anything else is reported as a candidate list with the constraints it
 * violates, and no optimum is claimed.
 */
export function buildRelaxationReport(excluded: readonly ExcludedOption[]): RelaxationReport {
  const singleConstraint: SingleConstraintRelaxation[] = [];

  for (const ex of excluded) {
    const keys = ex.reasons.map((r) => r.constraintKey);
    const uniqueKeys = [...new Set(keys)];
    if (uniqueKeys.length !== 1) continue;

    const key = uniqueKeys[0]!;
    if (!isRelaxable(key)) continue;

    const reason = ex.reasons.find((r) => r.constraintKey === key);
    if (!reason || reason.exceededBy === null) continue;

    if (key === 'arrival_deadline') {
      singleConstraint.push({
        constraint: 'arrival_deadline',
        amount: reason.exceededBy,
        unit: 'minutes',
        viaOptionId: ex.option.id,
        statement: `${ex.option.id} becomes feasible if the arrival deadline moves ${formatDuration(
          reason.exceededBy,
        )} later, with every other constraint unchanged.`,
      });
    } else if (key === 'budget_ceiling') {
      singleConstraint.push({
        constraint: 'budget_ceiling',
        amount: reason.exceededBy,
        unit: 'currency',
        viaOptionId: ex.option.id,
        statement: `${ex.option.id} becomes feasible if the cash budget rises by ${reason.exceededBy}, with every other constraint unchanged.`,
      });
    }
  }

  // Stable, deterministic ordering: smallest relaxation first, then option id.
  singleConstraint.sort((a, b) =>
    a.amount !== b.amount ? a.amount - b.amount : a.viaOptionId < b.viaOptionId ? -1 : 1,
  );

  const candidates = excluded
    .map((ex) => ({
      optionId: ex.option.id,
      violates: [...new Set(ex.reasons.map((r) => r.constraintKey))].sort(),
    }))
    .sort((a, b) => (a.optionId < b.optionId ? -1 : 1));

  return { singleConstraint, candidates, disclaimer: RELAXATION_DISCLAIMER };
}
