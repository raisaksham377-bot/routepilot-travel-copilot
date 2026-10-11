import type { PriorityRuleName } from '../schema/tripState';
import type { ComparatorSpec, Measures, MeasureName, RankingDecision } from './types';

/**
 * Stage 4: ranking.
 *
 * Four named rules. Each is a fixed sequence of comparators with an EXPLICIT
 * sort direction; every tie falls through to the next comparator. There are no
 * weights, no blending and no cross-unit conversion, which is what makes a
 * ranking explainable from stored data: "A beat B because arrival margin was
 * 240 against 150" is read straight off the deciding comparator rather than
 * reconstructed from weight contributions.
 *
 * Lexicographic ordering also avoids inventing an exchange rate between time
 * and money that the user never supplied -- the flaw that sank the earlier
 * blended-score design.
 */
export const PRIORITY_RULES: Record<PriorityRuleName, readonly ComparatorSpec[]> = {
  arrival_buffer_first: [
    { measure: 'arrivalMarginMinutes', direction: 'DESC' },
    { measure: 'connectionRiskCount', direction: 'ASC' },
    { measure: 'cashPayable', direction: 'ASC' },
  ],
  fewest_connection_risks: [
    { measure: 'connectionRiskCount', direction: 'ASC' },
    { measure: 'arrivalMarginMinutes', direction: 'DESC' },
    { measure: 'cashPayable', direction: 'ASC' },
  ],
  lowest_cash_outlay: [
    { measure: 'cashPayable', direction: 'ASC' },
    { measure: 'arrivalMarginMinutes', direction: 'DESC' },
    { measure: 'connectionRiskCount', direction: 'ASC' },
  ],
  shortest_travel_time: [
    { measure: 'travelDurationMinutes', direction: 'ASC' },
    { measure: 'cashPayable', direction: 'ASC' },
    { measure: 'connectionRiskCount', direction: 'ASC' },
  ],
} as const;

export function measureValue(m: Measures, name: MeasureName): number | null {
  switch (name) {
    case 'arrivalMarginMinutes':
      return m.arrivalMarginMinutes;
    case 'connectionRiskCount':
      return m.connectionRiskCount;
    case 'cashPayable':
      return m.cashPayable;
    case 'travelDurationMinutes':
      return m.travelDurationMinutes;
  }
}

/**
 * Compares on one measure. Returns a negative number when `a` should rank
 * higher. A null value sorts last regardless of direction -- an unknown is
 * never treated as a good score.
 */
function compareOn(
  a: Measures,
  b: Measures,
  spec: ComparatorSpec,
): { result: number; aValue: number | null; bValue: number | null } {
  const aValue = measureValue(a, spec.measure);
  const bValue = measureValue(b, spec.measure);

  if (aValue === null && bValue === null) return { result: 0, aValue, bValue };
  if (aValue === null) return { result: 1, aValue, bValue };
  if (bValue === null) return { result: -1, aValue, bValue };

  const raw = aValue - bValue;
  const result = spec.direction === 'ASC' ? raw : -raw;
  return { result, aValue, bValue };
}

export interface RankInput {
  id: string;
  measures: Measures;
}

/**
 * Produces a total order plus the decision record for each adjacent pair.
 *
 * The final `option_id_tiebreak` guarantees a TOTAL order. Without it two
 * options identical on every comparator would keep their input order, making
 * the output depend on array order -- which would break both the determinism
 * guarantee and the shuffle-invariance test.
 */
export function rankOptions(
  inputs: readonly RankInput[],
  rule: PriorityRuleName,
): { order: string[]; decisions: RankingDecision[] } {
  const comparators = PRIORITY_RULES[rule];

  const sorted = [...inputs].sort((a, b) => {
    for (const spec of comparators) {
      const { result } = compareOn(a.measures, b.measures, spec);
      if (result !== 0) return result;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const decisions: RankingDecision[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const higher = sorted[i - 1]!;
    const lower = sorted[i]!;
    let recorded: RankingDecision | null = null;

    for (const spec of comparators) {
      const { result, aValue, bValue } = compareOn(higher.measures, lower.measures, spec);
      if (result !== 0) {
        recorded = {
          higherId: higher.id,
          lowerId: lower.id,
          decidedBy: spec.measure,
          direction: spec.direction,
          higherValue: aValue,
          lowerValue: bValue,
        };
        break;
      }
    }

    decisions.push(
      recorded ?? {
        higherId: higher.id,
        lowerId: lower.id,
        decidedBy: 'option_id_tiebreak',
        direction: 'ASC',
        higherValue: null,
        lowerValue: null,
      },
    );
  }

  return { order: sorted.map((s) => s.id), decisions };
}
