import type { FlightOption } from '../schema/flightOption';
import type { Constraint } from '../schema/constraint';
import { findConstraint } from '../schema/constraint';
import type { TravelerProfile } from '../schema/travelerProfile';
import type { ConnectionRisk, Measures } from './types';
import {
  arrivalMarginMinutes,
  connectionWindows,
  formatDuration,
  isOvernightConnection,
  minutesBetween,
  travelDurationMinutes,
} from './time';

/**
 * Stage 2: compute every measure independently.
 *
 * None of these are combined into a headline figure. The UI shows them as
 * separate columns and the ranking sorts on them one at a time, so a user can
 * always see which number drove an outcome.
 */

/**
 * Cash actually payable for THIS option.
 *
 * The rule that prevents the fee double-count: exactly one of the two cash
 * fields is the answer, depending on how the ticket is paid for. They are never
 * added together.
 *
 *  - cash option  -> the full ticket total
 *  - award option -> the co-payment only (surcharges, taxes, fees)
 *
 * On an award option `comparableCashTicketTotal` is still carried, but as the
 * rewards baseline -- the cash avoided -- not as money changing hands.
 */
export function cashPayable(option: FlightOption): number | null {
  return option.paymentKind === 'award'
    ? option.awardCashCoPayment
    : option.comparableCashTicketTotal;
}

/** Multiplier on the minimum buffer below which a lone connection is called tight. */
export const TIGHT_SINGLE_CONNECTION_FACTOR = 1.5;

/**
 * Named structural findings about the connections in an itinerary.
 *
 * Every one is an observation about the schedule as printed. None is a
 * probability, a punctuality estimate, or a prediction -- the engine has no
 * historical performance data and must not imply otherwise.
 */
export function connectionRisks(
  option: FlightOption,
  minConnectionMinutes: number,
): ConnectionRisk[] {
  const risks: ConnectionRisk[] = [];
  const windows = connectionWindows(option);

  for (const w of windows) {
    if (w.bufferMinutes < minConnectionMinutes) {
      risks.push({
        code: 'buffer_below_minimum',
        airport: w.airport,
        bufferMinutes: w.bufferMinutes,
        detail: `Connection at ${w.airport} allows ${formatDuration(
          w.bufferMinutes,
        )}, below the ${formatDuration(minConnectionMinutes)} minimum set for this trip.`,
      });
    }
    if (isOvernightConnection(w)) {
      risks.push({
        code: 'overnight_connection',
        airport: w.airport,
        bufferMinutes: w.bufferMinutes,
        detail: `Connection at ${w.airport} spans the local small hours (${formatDuration(
          w.bufferMinutes,
        )} wait).`,
      });
    }
  }

  // A single connection with little slack means the whole itinerary hinges on
  // one transfer. Structural statement only: one connection, buffer under
  // 1.5x the minimum.
  if (windows.length === 1) {
    const only = windows[0]!;
    if (only.bufferMinutes < minConnectionMinutes * TIGHT_SINGLE_CONNECTION_FACTOR) {
      risks.push({
        code: 'tight_single_connection',
        airport: only.airport,
        bufferMinutes: only.bufferMinutes,
        detail: `The itinerary depends on one connection at ${only.airport} with ${formatDuration(
          only.bufferMinutes,
        )} of slack.`,
      });
    }
  }

  return risks;
}

export function effectiveMinConnectionMinutes(
  constraints: readonly Constraint[],
  profile: TravelerProfile,
): number {
  return (
    findConstraint(constraints, 'min_connection_minutes')?.value ?? profile.minConnectionMinutes
  );
}

export function computeMeasures(args: {
  option: FlightOption;
  constraints: readonly Constraint[];
  profile: TravelerProfile;
  deadlineInstant: string | null;
  evaluatedAt: string;
  stalenessThresholdMinutes: number;
}): Measures {
  const { option, constraints, profile, deadlineInstant, evaluatedAt } = args;
  const minConnection = effectiveMinConnectionMinutes(constraints, profile);
  const risks = connectionRisks(option, minConnection);

  const ageMinutes = minutesBetween(option.asOf, evaluatedAt);
  const isStale = ageMinutes > args.stalenessThresholdMinutes;

  return {
    cashPayable: cashPayable(option),
    comparableCashTicketTotal: option.comparableCashTicketTotal,
    awardCashCoPayment: option.awardCashCoPayment,
    taxesAndFees: option.taxesAndFees,
    pointsRequired: option.pointsRequired,
    arrivalMarginMinutes:
      deadlineInstant === null ? null : arrivalMarginMinutes(option, deadlineInstant),
    connectionRisks: risks,
    connectionRiskCount: risks.length,
    travelDurationMinutes: travelDurationMinutes(option),
    isStale,
    staleByMinutes: isStale ? ageMinutes - args.stalenessThresholdMinutes : null,
  };
}
