import type { FlightOption } from '../schema/flightOption';
import { optionDestination, optionOrigin } from '../schema/flightOption';
import type { TravelerProfile } from '../schema/travelerProfile';
import type { RewardsAssessment } from './types';
import { localDate } from './time';

/**
 * Stage 3: the OPTIONAL rewards module.
 *
 * Optional is structural, not cosmetic. It activates only when the user both
 * supplies comparable data AND confirms rewards are permitted and usable --
 * many corporate travellers cannot use personal points for company travel. The
 * whole product passes its core tests with this module off, and eight of the
 * nine seeded scenarios never touch it.
 *
 * What this module will NOT do: produce a number it cannot stand behind. If the
 * cash and award itineraries are not genuinely comparable, it says so and names
 * the check that failed, rather than showing a figure with a caveat attached.
 */

const DISABLED: Omit<RewardsAssessment, 'optionId' | 'inputs' | 'valuationCpp'> = {
  applicable: false,
  effectiveCpp: null,
  reason: 'module_disabled',
  failedCheck: null,
  counterpartOptionId: null,
  verdict: null,
};

function emptyInputs(option: FlightOption) {
  return {
    comparableCashTicketTotal: option.comparableCashTicketTotal,
    awardCashCoPayment: option.awardCashCoPayment,
    pointsRequired: option.pointsRequired,
  };
}

/**
 * Finds a cash option that is genuinely the same trip as the award option.
 *
 * "Comparable" is a conjunction of explicit checks rather than a judgement
 * call, so a failure can name the specific reason.
 */
export function findCashCounterpart(
  award: FlightOption,
  all: readonly FlightOption[],
): { counterpart: FlightOption | null; failedCheck: string | null } {
  const cashOptions = all.filter(
    (o) => o.paymentKind === 'cash' && o.comparableCashTicketTotal !== null,
  );
  if (cashOptions.length === 0) {
    return { counterpart: null, failedCheck: 'no cash option is present to compare against' };
  }

  const awardOrigin = optionOrigin(award);
  const awardDest = optionDestination(award);
  const awardDepDate = localDate(award.legs[0]!.departure, award.legs[0]!.departureTz);
  const awardArrDate = localDate(
    award.legs[award.legs.length - 1]!.arrival,
    award.legs[award.legs.length - 1]!.arrivalTz,
  );

  const failures: string[] = [];

  for (const cash of cashOptions) {
    if (optionOrigin(cash) !== awardOrigin || optionDestination(cash) !== awardDest) {
      failures.push(
        `${cash.id} flies ${optionOrigin(cash)}-${optionDestination(cash)}, not ${awardOrigin}-${awardDest}`,
      );
      continue;
    }
    if (cash.cabin !== award.cabin) {
      failures.push(`${cash.id} is ${cash.cabin}, the award is ${award.cabin}`);
      continue;
    }
    const cashDepDate = localDate(cash.legs[0]!.departure, cash.legs[0]!.departureTz);
    const cashArrDate = localDate(
      cash.legs[cash.legs.length - 1]!.arrival,
      cash.legs[cash.legs.length - 1]!.arrivalTz,
    );
    if (cashDepDate !== awardDepDate || cashArrDate !== awardArrDate) {
      failures.push(
        `${cash.id} travels ${cashDepDate}->${cashArrDate}, the award travels ${awardDepDate}->${awardArrDate}`,
      );
      continue;
    }
    return { counterpart: cash, failedCheck: null };
  }

  return {
    counterpart: null,
    failedCheck: `no cash option matches the award itinerary (${failures.join('; ')})`,
  };
}

/**
 * Effective cents per point.
 *
 *   (comparableCashTicketTotal - awardCashCoPayment) / pointsRequired, in cents
 *
 * The numerator is the cash genuinely AVOIDED by redeeming: the full comparable
 * cash ticket, less the cash still handed over on the award booking.
 *
 * An earlier draft subtracted the award's taxes and fees from the cash fare
 * without distinguishing the two figures, which double-counted fees whenever
 * both were populated. Separate schema fields now make that error
 * unrepresentable, and `tests/rewards.test.ts` guards it directly.
 */
export function assessRewards(args: {
  option: FlightOption;
  allOptions: readonly FlightOption[];
  profile: TravelerProfile;
  moduleEnabled: boolean;
}): RewardsAssessment {
  const { option, allOptions, profile, moduleEnabled } = args;
  const base = {
    optionId: option.id,
    inputs: emptyInputs(option),
    valuationCpp: profile.pointsValuationCpp,
  };

  if (!moduleEnabled) return { ...base, ...DISABLED };
  if (!profile.rewardsPermitted) {
    return { ...base, ...DISABLED, reason: 'rewards_not_permitted' };
  }
  if (option.paymentKind !== 'award') {
    return { ...base, ...DISABLED, reason: 'not_an_award_option' };
  }
  if (option.pointsRequired === null || option.awardCashCoPayment === null) {
    return { ...base, ...DISABLED, reason: 'missing_data', failedCheck: 'award option is missing points or co-payment' };
  }

  const { counterpart, failedCheck } = findCashCounterpart(option, allOptions);
  if (counterpart === null || counterpart.comparableCashTicketTotal === null) {
    return {
      ...base,
      applicable: true,
      effectiveCpp: null,
      reason: failedCheck?.startsWith('no cash option is present') ? 'no_cash_counterpart' : 'not_comparable',
      failedCheck,
      counterpartOptionId: null,
      verdict: null,
    };
  }

  const cashAvoided = counterpart.comparableCashTicketTotal - option.awardCashCoPayment;
  const effectiveCpp = (cashAvoided * 100) / option.pointsRequired;

  const verdict =
    profile.pointsValuationCpp === null
      ? null
      : effectiveCpp >= profile.pointsValuationCpp
        ? ('at_or_above_valuation' as const)
        : ('below_valuation' as const);

  return {
    ...base,
    inputs: {
      comparableCashTicketTotal: counterpart.comparableCashTicketTotal,
      awardCashCoPayment: option.awardCashCoPayment,
      pointsRequired: option.pointsRequired,
    },
    applicable: true,
    effectiveCpp,
    reason: null,
    failedCheck: null,
    counterpartOptionId: counterpart.id,
    verdict,
  };
}

/** Rounds for display without pretending to more precision than exists. */
export function formatCpp(cpp: number): string {
  return `${cpp.toFixed(2)}c per point`;
}
