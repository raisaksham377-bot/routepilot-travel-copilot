import type { FlightOption } from '../schema/flightOption';
import { cabinRank, optionDestination, optionOrigin } from '../schema/flightOption';
import type { Constraint } from '../schema/constraint';
import type { EliminationReason, Measures } from './types';
import { connectionWindows, formatDuration, isOvernightConnection } from './time';
import { CABIN_LABELS } from '../schema/flightOption';

/**
 * Stage 1: the feasibility gate.
 *
 * This runs BEFORE any ranking and is never monetised or traded off. An option
 * that misses a hard arrival deadline is not "expensive" -- it is out. Options
 * eliminated here are removed from the ranked set entirely, which is what makes
 * "a hard-constraint violator can never rank first" true by construction rather
 * than by tuning a penalty large enough to dominate.
 *
 * Only constraints marked `hard` eliminate. A soft version of the same
 * constraint informs ranking or raises a named risk instead.
 */
export function evaluateFeasibility(args: {
  option: FlightOption;
  constraints: readonly Constraint[];
  measures: Measures;
  deadlineInstant: string | null;
}): EliminationReason[] {
  const { option, constraints, measures, deadlineInstant } = args;
  const reasons: EliminationReason[] = [];

  for (const c of constraints) {
    if (c.kind !== 'hard') continue;

    switch (c.key) {
      case 'arrival_deadline': {
        // An unresolvable deadline is handled upstream as `missing_required`;
        // it must never be silently treated as "no deadline".
        if (deadlineInstant === null || measures.arrivalMarginMinutes === null) break;
        if (measures.arrivalMarginMinutes < 0) {
          const late = Math.abs(measures.arrivalMarginMinutes);
          reasons.push({
            constraintKey: 'arrival_deadline',
            comparison: `arrival ${option.legs[option.legs.length - 1]!.arrival} is after the deadline ${deadlineInstant} by ${formatDuration(late)}`,
            exceededBy: late,
            exceededByUnit: 'minutes',
          });
        }
        break;
      }

      case 'min_connection_minutes': {
        const windows = connectionWindows(option);
        const worst = windows.reduce<null | (typeof windows)[number]>(
          (acc, w) => (acc === null || w.bufferMinutes < acc.bufferMinutes ? w : acc),
          null,
        );
        if (worst !== null && worst.bufferMinutes < c.value) {
          reasons.push({
            constraintKey: 'min_connection_minutes',
            comparison: `shortest connection at ${worst.airport} is ${formatDuration(worst.bufferMinutes)}, below the required ${formatDuration(c.value)}`,
            exceededBy: c.value - worst.bufferMinutes,
            exceededByUnit: 'minutes',
          });
        }
        break;
      }

      case 'cabin_floor': {
        if (cabinRank(option.cabin) < cabinRank(c.value)) {
          reasons.push({
            constraintKey: 'cabin_floor',
            comparison: `cabin is ${CABIN_LABELS[option.cabin]}, below the required ${CABIN_LABELS[c.value]}`,
            exceededBy: cabinRank(c.value) - cabinRank(option.cabin),
            exceededByUnit: 'cabin_steps',
          });
        }
        break;
      }

      case 'budget_ceiling': {
        if (measures.cashPayable !== null && measures.cashPayable > c.value) {
          reasons.push({
            constraintKey: 'budget_ceiling',
            comparison: `cash payable ${measures.cashPayable} exceeds the ceiling ${c.value}`,
            exceededBy: measures.cashPayable - c.value,
            exceededByUnit: 'currency',
          });
        }
        break;
      }

      case 'origin': {
        if (optionOrigin(option) !== c.value) {
          reasons.push({
            constraintKey: 'origin',
            comparison: `departs ${optionOrigin(option)}, not ${c.value}`,
            exceededBy: null,
            exceededByUnit: null,
          });
        }
        break;
      }

      case 'destination': {
        if (optionDestination(option) !== c.value) {
          reasons.push({
            constraintKey: 'destination',
            comparison: `arrives ${optionDestination(option)}, not ${c.value}`,
            exceededBy: null,
            exceededByUnit: null,
          });
        }
        break;
      }

      case 'avoid_overnight_connection': {
        if (!c.value) break;
        const overnight = connectionWindows(option).filter(isOvernightConnection);
        if (overnight.length > 0) {
          reasons.push({
            constraintKey: 'avoid_overnight_connection',
            comparison: `has an overnight connection at ${overnight.map((w) => w.airport).join(', ')}`,
            exceededBy: null,
            exceededByUnit: null,
          });
        }
        break;
      }
    }
  }

  // Soft thresholds do not eliminate: they become named connection risks in
  // measures.ts instead. That split is what lets scenario S2 keep an awkward
  // overnight itinerary in the ranked set while still flagging it.
  return reasons;
}
