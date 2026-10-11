import type { Cabin, FlightOption, Leg } from '../schema/flightOption';
import { flightOptionSchema } from '../schema/flightOption';
import type { Constraint } from '../schema/constraint';
import type { TripState } from '../schema/tripState';
import { DEFAULT_PROFILE, type TravelerProfile } from '../schema/travelerProfile';
import type { Provenance } from '../schema/provenance';

/**
 * Fixture builders.
 *
 * Every fixture option is validated through the real Zod schema on
 * construction. A fixture that could not exist in the app is worse than no
 * fixture -- it would make the golden tests prove something about a shape the
 * product never produces.
 */

export const FIXTURE_AS_OF = '2026-11-01T08:30:00Z';
export const FIXTURE_EVALUATED_AT = '2026-11-01T09:00:00Z';

export interface LegSpec {
  flightNumber: string;
  origin: string;
  destination: string;
  departure: string;
  departureTz: string;
  arrival: string;
  arrivalTz: string;
}

export function buildOption(spec: {
  id: string;
  carrier: string;
  legs: LegSpec[];
  cabin?: Cabin;
  paymentKind?: 'cash' | 'award';
  comparableCashTicketTotal?: number | null;
  awardCashCoPayment?: number | null;
  taxesAndFees?: number | null;
  pointsRequired?: number | null;
  pointsProgram?: string | null;
  provenance?: Provenance;
  asOf?: string;
  capturedFrom?: string;
}): FlightOption {
  const paymentKind = spec.paymentKind ?? 'cash';
  const candidate = {
    id: spec.id,
    carrier: spec.carrier,
    legs: spec.legs as Leg[],
    cabin: spec.cabin ?? ('business' as Cabin),
    paymentKind,
    comparableCashTicketTotal: spec.comparableCashTicketTotal ?? null,
    awardCashCoPayment: spec.awardCashCoPayment ?? (paymentKind === 'award' ? 0 : null),
    taxesAndFees: spec.taxesAndFees ?? null,
    pointsRequired: spec.pointsRequired ?? null,
    pointsProgram: spec.pointsProgram ?? null,
    provenance: spec.provenance ?? ('SAMPLE' as Provenance),
    asOf: spec.asOf ?? FIXTURE_AS_OF,
    ...(spec.capturedFrom === undefined ? {} : { capturedFrom: spec.capturedFrom }),
  };
  return flightOptionSchema.parse(candidate);
}

export function profile(overrides: Partial<TravelerProfile> = {}): TravelerProfile {
  return { ...DEFAULT_PROFILE, ...overrides };
}

export function deadline(
  localDateTime: string,
  tz: string,
  kind: 'hard' | 'soft' = 'hard',
): Constraint {
  return { key: 'arrival_deadline', value: { localDateTime, tz }, kind, source: 'stated' };
}

export function buildTripState(spec: {
  options: FlightOption[];
  constraints?: Constraint[];
  profileOverrides?: Partial<TravelerProfile>;
  priorityRule?: TripState['priorityRule'];
  rewardsModuleEnabled?: boolean;
  stalenessThresholdMinutes?: number;
  asOf?: string;
}): TripState {
  return {
    schemaVersion: 1,
    profile: profile(spec.profileOverrides),
    constraints: spec.constraints ?? [],
    options: spec.options,
    priorityRule: spec.priorityRule ?? 'arrival_buffer_first',
    rewardsModuleEnabled: spec.rewardsModuleEnabled ?? false,
    stalenessThresholdMinutes: spec.stalenessThresholdMinutes ?? 720,
    asOf: spec.asOf ?? FIXTURE_EVALUATED_AT,
  };
}
