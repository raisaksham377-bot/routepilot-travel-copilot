import { buildOption, buildTripState, deadline } from './build';
import { DISCRIMINATION_DEADLINE, DISCRIMINATION_OPTIONS, discriminationState } from './fixtures';
import type { Constraint } from '../schema/constraint';
import type { FlightOption } from '../schema/flightOption';
import type { TripState } from '../schema/tripState';

/**
 * The nine seeded scenarios.
 *
 * These are the engine's acceptance tests expressed as data. Every option is
 * tagged SAMPLE: none of it was fetched, none of it is live, none of it is
 * bookable.
 *
 * S3 is the only scenario that touches the optional rewards module. The other
 * eight pass with it switched off, which is the structural proof that cash
 * versus points is a module rather than half the product.
 */

export interface Scenario {
  id: string;
  title: string;
  /** What the engine must do. Mirrors the acceptance criteria in the plan. */
  expectation: string;
  state: TripState;
  usesRewardsModule: boolean;
}

/* ---------------------------- S1 --------------------------------------- */

export const s1: Scenario = {
  id: 'S1',
  title: 'The cheapest option misses the arrival deadline',
  expectation:
    'Option D is eliminated at the feasibility gate rather than down-ranked, and cannot appear ' +
    'in any ranked set under any priority rule, despite being both cheapest and fastest.',
  state: discriminationState('arrival_buffer_first'),
  usesRewardsModule: false,
};

/* ---------------------------- S2 --------------------------------------- */

/** Cheap, but the saving is bought with a 14-hour overnight layover. */
export const S2_OVERNIGHT: FlightOption = buildOption({
  id: 'OVERNIGHT',
  carrier: 'Aer Lingus',
  comparableCashTicketTotal: 690,
  taxesAndFees: 140,
  legs: [
    {
      flightNumber: 'EI159',
      origin: 'LHR',
      destination: 'DUB',
      departure: '2026-11-03T21:30:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-03T22:45:00+00:00',
      arrivalTz: 'Europe/Dublin',
    },
    {
      flightNumber: 'EI107',
      origin: 'DUB',
      destination: 'JFK',
      departure: '2026-11-04T13:00:00+00:00',
      departureTz: 'Europe/Dublin',
      arrival: '2026-11-04T16:00:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

/** Clean nonstop: dearer, no findings, more spare time. */
export const S2_NONSTOP: FlightOption = buildOption({
  id: 'NONSTOP',
  carrier: 'British Airways',
  comparableCashTicketTotal: 1180,
  taxesAndFees: 230,
  legs: [
    {
      flightNumber: 'BA179',
      origin: 'LHR',
      destination: 'JFK',
      departure: '2026-11-04T09:00:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T14:00:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

export const s2: Scenario = {
  id: 'S2',
  title: 'A low fare with an impractical overnight connection',
  expectation:
    'OVERNIGHT stays in the ranked set because it is feasible, but carries a named ' +
    'overnight_connection finding and must not rank first under arrival_buffer_first or ' +
    'fewest_connection_risks. It may legitimately rank first under lowest_cash_outlay.',
  state: buildTripState({
    options: [S2_OVERNIGHT, S2_NONSTOP],
    constraints: [DISCRIMINATION_DEADLINE],
    priorityRule: 'arrival_buffer_first',
  }),
  usesRewardsModule: false,
};

/* ---------------------------- S3 (rewards module) ----------------------- */

const S3_SCHEDULE = [
  {
    flightNumber: 'BA183',
    origin: 'LHR',
    destination: 'JFK',
    departure: '2026-11-04T09:00:00+00:00',
    departureTz: 'Europe/London',
    arrival: '2026-11-04T14:00:00-05:00',
    arrivalTz: 'America/New_York',
  },
];

/** The cash way to buy this exact flight. Supplies the rewards baseline. */
export const S3_CASH: FlightOption = buildOption({
  id: 'CASH-BA183',
  carrier: 'British Airways',
  cabin: 'business',
  comparableCashTicketTotal: 2400,
  taxesAndFees: 260,
  legs: S3_SCHEDULE,
});

/**
 * The same flight on points -- with surcharges large enough to destroy the
 * value of the redemption.
 *
 *   cash avoided = 2400 - 1150 = 1250
 *   effective    = 1250 * 100 / 120000 = 1.04c per point
 *   valuation    = 1.50c per point  ->  below_valuation
 */
export const S3_AWARD: FlightOption = buildOption({
  id: 'AWARD-BA183',
  carrier: 'British Airways',
  cabin: 'business',
  paymentKind: 'award',
  pointsRequired: 120000,
  pointsProgram: 'Example Airline Club',
  awardCashCoPayment: 1150,
  taxesAndFees: 1150,
  legs: S3_SCHEDULE,
});

/** Variant (a): an award in a different cabin is not a comparable redemption. */
export const S3_AWARD_WRONG_CABIN: FlightOption = buildOption({
  id: 'AWARD-ECONOMY',
  carrier: 'British Airways',
  cabin: 'economy',
  paymentKind: 'award',
  pointsRequired: 60000,
  pointsProgram: 'Example Airline Club',
  awardCashCoPayment: 400,
  legs: S3_SCHEDULE,
});

const rewardsProfile = {
  rewardsPermitted: true,
  pointsValuationCpp: 1.5,
  loyaltyProgramNames: ['Example Airline Club'],
};

export const s3: Scenario = {
  id: 'S3',
  title: 'A points redemption whose fees destroy its value (optional module)',
  expectation:
    'With the module active and the comparability checks satisfied, effective cents-per-point is ' +
    'computed as (comparableCashTicketTotal - awardCashCoPayment) / pointsRequired and reported ' +
    'as below the user’s own valuation, with all three inputs visible. cashPayable for the ' +
    'award is the co-payment ALONE -- never the co-payment plus the cash ticket.',
  state: buildTripState({
    options: [S3_CASH, S3_AWARD],
    constraints: [DISCRIMINATION_DEADLINE],
    priorityRule: 'lowest_cash_outlay',
    profileOverrides: rewardsProfile,
    rewardsModuleEnabled: true,
  }),
  usesRewardsModule: true,
};

/** Variant: cabin mismatch -> not_comparable, no number shown. */
export function s3NotComparableState(): TripState {
  return buildTripState({
    options: [S3_CASH, S3_AWARD_WRONG_CABIN],
    constraints: [DISCRIMINATION_DEADLINE],
    priorityRule: 'lowest_cash_outlay',
    profileOverrides: rewardsProfile,
    rewardsModuleEnabled: true,
  });
}

/** Variant: no cash counterpart at all -> no_cash_counterpart. */
export function s3NoCounterpartState(): TripState {
  return buildTripState({
    options: [S3_AWARD],
    constraints: [DISCRIMINATION_DEADLINE],
    priorityRule: 'lowest_cash_outlay',
    profileOverrides: rewardsProfile,
    rewardsModuleEnabled: true,
  });
}

/** Variant: the same data with the module OFF -> module_disabled, product intact. */
export function s3ModuleOffState(): TripState {
  return buildTripState({
    options: [S3_CASH, S3_AWARD],
    constraints: [DISCRIMINATION_DEADLINE],
    priorityRule: 'lowest_cash_outlay',
    profileOverrides: rewardsProfile,
    rewardsModuleEnabled: false,
  });
}

/* ---------------------------- S4 --------------------------------------- */

export const s4: Scenario = {
  id: 'S4',
  title: 'The user changes a key preference mid-conversation',
  expectation:
    'Changing the priority rule re-ranks and produces a different recommendation, and the prior ' +
    'trace remains separately inspectable rather than being mutated. Tightening a constraint to ' +
    'hard re-runs the feasibility gate and can newly exclude an option.',
  state: discriminationState('arrival_buffer_first'),
  usesRewardsModule: false,
};

/** The "after" state: same options, the user has switched what matters. */
export function s4AfterPriorityChange(): TripState {
  return discriminationState('lowest_cash_outlay');
}

/**
 * The "after" state for a constraint change: the minimum connection becomes a
 * firm requirement of 90 minutes, which newly eliminates option A (55 min).
 */
export function s4AfterConstraintTightened(): TripState {
  const tightened: Constraint = {
    key: 'min_connection_minutes',
    value: 90,
    kind: 'hard',
    source: 'user-edited',
  };
  return buildTripState({
    options: DISCRIMINATION_OPTIONS,
    constraints: [DISCRIMINATION_DEADLINE, tightened],
    priorityRule: 'arrival_buffer_first',
  });
}

/* ---------------------------- S5 --------------------------------------- */

/** A cash option the user has not finished entering: no ticket total yet. */
export const S5_INCOMPLETE: FlightOption = buildOption({
  id: 'INCOMPLETE',
  carrier: 'British Airways',
  comparableCashTicketTotal: null,
  legs: [
    {
      flightNumber: 'BA185',
      origin: 'LHR',
      destination: 'JFK',
      departure: '2026-11-04T09:00:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T14:00:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

/**
 * A genuinely useful edge case: the itinerary crosses midnight in the departure
 * zone and crosses several time zones.
 *
 * Departs 23:40 on 3 Nov in London, arrives 03:05 on 4 Nov in New York local
 * time. Elapsed time is 8h25 (505 min) and the arrival margin against an 18:00
 * New York deadline is 895 minutes. A naive clock-time subtraction would
 * compute 03:05 - 23:40 and get a NEGATIVE duration -- which is exactly the
 * bug class this fixture exists to catch.
 */
export const S5_CROSS_MIDNIGHT: FlightOption = buildOption({
  id: 'CROSS-MIDNIGHT',
  carrier: 'Virgin Atlantic',
  comparableCashTicketTotal: 1020,
  legs: [
    {
      flightNumber: 'VS045',
      origin: 'LHR',
      destination: 'JFK',
      departure: '2026-11-03T23:40:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T03:05:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

export const s5: Scenario = {
  id: 'S5',
  title: 'Missing or ambiguous information',
  expectation:
    'The engine does not guess. It returns missing_required with a needs list naming the option ' +
    'and field, and produces no recommendation while a required value is unknown.',
  state: buildTripState({
    options: [S5_INCOMPLETE, S2_NONSTOP],
    constraints: [DISCRIMINATION_DEADLINE],
  }),
  usesRewardsModule: false,
};

export function s5CrossMidnightState(): TripState {
  return buildTripState({
    options: [S5_CROSS_MIDNIGHT, S2_NONSTOP],
    constraints: [DISCRIMINATION_DEADLINE],
  });
}

/**
 * A deadline carrying an unrecognised timezone.
 *
 * Constructed with a type assertion deliberately: the constraint schema would
 * reject this, which is correct for user input, but the value could still reach
 * the engine from corrupt localStorage or a future import path. The engine must
 * report it rather than fall back to "no deadline", because silently dropping a
 * deadline would turn an infeasible option into a recommended one.
 */
export function s5UnresolvableDeadlineState(): TripState {
  const broken = {
    key: 'arrival_deadline',
    value: { localDateTime: '2026-11-04T18:00', tz: 'Mars/Olympus_Mons' },
    kind: 'hard',
    source: 'stated',
  } as unknown as Constraint;
  return buildTripState({ options: [S2_NONSTOP], constraints: [broken] });
}

/* ---------------------------- S6 --------------------------------------- */

export const s6: Scenario = {
  id: 'S6',
  title: 'Contradictory information',
  expectation:
    'Two different values for the same requirement are surfaced side by side with their sources, ' +
    'and the engine refuses to pick one. No recommendation is produced.',
  state: buildTripState({
    options: [S2_NONSTOP, ...DISCRIMINATION_OPTIONS.slice(0, 2)],
    constraints: [
      deadline('2026-11-04T18:00', 'America/New_York'),
      { ...deadline('2026-11-04T11:00', 'America/New_York'), source: 'inferred' },
    ],
  }),
  usesRewardsModule: false,
};

/* ---------------------------- S7 --------------------------------------- */

/** Captured four days before evaluation, well past the staleness threshold. */
export const S7_STALE: FlightOption = buildOption({
  id: 'STALE',
  carrier: 'British Airways',
  comparableCashTicketTotal: 1150,
  asOf: '2026-10-28T09:00:00Z',
  legs: [
    {
      flightNumber: 'BA187',
      origin: 'LHR',
      destination: 'JFK',
      departure: '2026-11-04T09:30:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T13:30:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

export const s7: Scenario = {
  id: 'S7',
  title: 'Unavailable or stale option data',
  expectation:
    'The stale option is marked stale, the recommendation is downgraded to provisional, and the ' +
    'brief carries the warning.',
  state: buildTripState({
    options: [S7_STALE, S2_NONSTOP],
    constraints: [DISCRIMINATION_DEADLINE],
    stalenessThresholdMinutes: 720,
  }),
  usesRewardsModule: false,
};

/* ---------------------------- S8 --------------------------------------- */

/** Late by 20 minutes and nothing else wrong -> relaxation is computable. */
export const S8_LATE: FlightOption = buildOption({
  id: 'LATE-ONLY',
  carrier: 'Virgin Atlantic',
  comparableCashTicketTotal: 820,
  legs: [
    {
      flightNumber: 'VS027',
      origin: 'LHR',
      destination: 'JFK',
      departure: '2026-11-04T14:25:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T18:20:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

/** Over budget by 300 and nothing else wrong -> relaxation is computable. */
export const S8_PRICEY: FlightOption = buildOption({
  id: 'OVER-BUDGET',
  carrier: 'British Airways',
  comparableCashTicketTotal: 1300,
  legs: [
    {
      flightNumber: 'BA189',
      origin: 'LHR',
      destination: 'JFK',
      departure: '2026-11-04T09:00:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T14:00:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

/** Late AND over budget -> two violations, so no single-constraint figure. */
export const S8_BOTH: FlightOption = buildOption({
  id: 'LATE-AND-PRICEY',
  carrier: 'American Airlines',
  comparableCashTicketTotal: 1500,
  legs: [
    {
      flightNumber: 'AA101',
      origin: 'LHR',
      destination: 'JFK',
      departure: '2026-11-04T15:00:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T19:10:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

export const s8: Scenario = {
  id: 'S8',
  title: 'No option satisfies all hard constraints',
  expectation:
    'Returns no_feasible_option. Reports a single-constraint relaxation only for options that ' +
    'violate exactly one relaxable constraint, naming which constraint moves and holding the ' +
    'others constant. Options violating two constraints appear in the candidate list instead. ' +
    'No global optimum is claimed and no winner is fabricated.',
  state: buildTripState({
    options: [S8_LATE, S8_PRICEY, S8_BOTH],
    constraints: [
      DISCRIMINATION_DEADLINE,
      { key: 'budget_ceiling', value: 1000, kind: 'hard', source: 'stated' },
    ],
  }),
  usesRewardsModule: false,
};

/* ---------------------------- S9 --------------------------------------- */

export const s9: Scenario = {
  id: 'S9',
  title: 'The reasoning and data source must be explainable',
  expectation:
    'For any ranked option, "why is this ranked here?" is answerable purely from the stored ' +
    'trace -- priority rule, deciding comparator, both values -- with no second pass and no ' +
    'model call. Provenance and asOf travel with every option.',
  state: discriminationState('fewest_connection_risks'),
  usesRewardsModule: false,
};

/* ----------------------------------------------------------------------- */

export const ALL_SCENARIOS: Scenario[] = [s1, s2, s3, s4, s5, s6, s7, s8, s9];

/** The eight that must pass with the rewards module switched off. */
export const CORE_SCENARIOS: Scenario[] = ALL_SCENARIOS.filter((s) => !s.usesRewardsModule);
