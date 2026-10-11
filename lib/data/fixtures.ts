import { buildOption, buildTripState, deadline } from './build';
import type { FlightOption } from '../schema/flightOption';
import type { TripState } from '../schema/tripState';

/**
 * THE RANKING-DISCRIMINATION FIXTURE.
 *
 * Designed so that all four priority rules produce FOUR DIFFERENT orders, and
 * so that the option eliminated at the feasibility gate is simultaneously the
 * cheapest and the fastest.
 *
 * Target measures (deadline 18:00 on 2026-11-04 in America/New_York = 23:00Z):
 *
 *   id | arrivalMargin | risks | cashPayable | travelDuration
 *   ---|---------------|-------|-------------|----------------
 *   A  |  240 min      |   2   |   $1,240    |  670 min
 *   B  |   95 min      |   0   |   $1,105    |  580 min
 *   C  |  150 min      |   1   |   $  980    |  750 min
 *   D  |  -20 min      |   0   |   $  610    |  535 min   <- eliminated
 *
 * Expected orders:
 *   arrival_buffer_first    -> A, C, B
 *   fewest_connection_risks -> B, C, A
 *   lowest_cash_outlay      -> C, B, A
 *   shortest_travel_time    -> B, A, C
 *
 * An earlier draft priced A at $980 and B at $1,240, which made
 * lowest_cash_outlay collapse onto arrival_buffer_first (both A, C, B) and
 * silently reduced this fixture to three distinct orders while every individual
 * assertion still passed. `tests/priority.test.ts` therefore also asserts that
 * the four orders are distinct -- it tests the fixture, not just the code.
 *
 * Risk counts are produced structurally, not stipulated:
 *   A: one connection, 55 min buffer  -> buffer_below_minimum + tight_single_connection = 2
 *   B: nonstop                        -> 0
 *   C: one connection, 90 min buffer  -> tight_single_connection only = 1
 *   D: nonstop                        -> 0
 * (profile.minConnectionMinutes = 75; tight threshold = 1.5 x 75 = 112.5)
 */

export const DISCRIMINATION_DEADLINE = deadline('2026-11-04T18:00', 'America/New_York');

/** A — most spare time, two connection findings, dearest. */
export const OPTION_A: FlightOption = buildOption({
  id: 'A',
  carrier: 'Aer Lingus',
  comparableCashTicketTotal: 1240,
  taxesAndFees: 190,
  legs: [
    {
      flightNumber: 'EI151',
      origin: 'LHR',
      destination: 'DUB',
      departure: '2026-11-04T07:50:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T09:05:00+00:00',
      arrivalTz: 'Europe/Dublin',
    },
    {
      flightNumber: 'EI105',
      origin: 'DUB',
      destination: 'JFK',
      departure: '2026-11-04T10:00:00+00:00',
      departureTz: 'Europe/Dublin',
      arrival: '2026-11-04T14:00:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

/** B — nonstop, no findings, fastest of the feasible three. */
export const OPTION_B: FlightOption = buildOption({
  id: 'B',
  carrier: 'British Airways',
  comparableCashTicketTotal: 1105,
  taxesAndFees: 240,
  legs: [
    {
      flightNumber: 'BA117',
      origin: 'LHR',
      destination: 'JFK',
      departure: '2026-11-04T11:45:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T16:25:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

/** C — cheapest of the feasible three, one connection finding, slowest. */
export const OPTION_C: FlightOption = buildOption({
  id: 'C',
  carrier: 'KLM',
  comparableCashTicketTotal: 980,
  taxesAndFees: 155,
  legs: [
    {
      flightNumber: 'KL1008',
      origin: 'LHR',
      destination: 'AMS',
      departure: '2026-11-04T08:00:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T11:20:00+01:00',
      arrivalTz: 'Europe/Amsterdam',
    },
    {
      flightNumber: 'KL641',
      origin: 'AMS',
      destination: 'JFK',
      departure: '2026-11-04T12:50:00+01:00',
      departureTz: 'Europe/Amsterdam',
      arrival: '2026-11-04T15:30:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

/**
 * D — CHEAPEST AND FASTEST, and arrives 20 minutes after the commitment.
 * The entire point of the fixture: the feasibility gate must beat both price
 * and speed, so this option can never appear in any ranked set.
 */
export const OPTION_D: FlightOption = buildOption({
  id: 'D',
  carrier: 'Virgin Atlantic',
  comparableCashTicketTotal: 610,
  taxesAndFees: 180,
  legs: [
    {
      flightNumber: 'VS025',
      origin: 'LHR',
      destination: 'JFK',
      departure: '2026-11-04T14:25:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T18:20:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

export const DISCRIMINATION_OPTIONS: FlightOption[] = [OPTION_A, OPTION_B, OPTION_C, OPTION_D];

export function discriminationState(
  priorityRule: TripState['priorityRule'] = 'arrival_buffer_first',
): TripState {
  return buildTripState({
    options: DISCRIMINATION_OPTIONS,
    constraints: [DISCRIMINATION_DEADLINE],
    priorityRule,
  });
}

export const EXPECTED_DISCRIMINATION_ORDERS: Record<TripState['priorityRule'], string[]> = {
  arrival_buffer_first: ['A', 'C', 'B'],
  fewest_connection_risks: ['B', 'C', 'A'],
  lowest_cash_outlay: ['C', 'B', 'A'],
  shortest_travel_time: ['B', 'A', 'C'],
};

/* ------------------------------------------------------------------------- */
/* TIE-BREAKER FIXTURES                                                       */
/*                                                                            */
/* No rule in the discrimination fixture has a tie on its LEAD comparator, so  */
/* that fixture never exercises comparator fall-through. These do.             */
/* ------------------------------------------------------------------------- */

/**
 * Tie on the lead comparator only.
 *
 * Under arrival_buffer_first both arrive with exactly 180 minutes to spare, so
 * the decision must fall through to connectionRiskCount ASC. T2 is nonstop
 * (0 findings) and T1 has a tight connection (2 findings), so T2 must win -- on
 * the SECOND comparator, and the trace must say so.
 */
export const TIE_LEAD_T1: FlightOption = buildOption({
  id: 'T1',
  carrier: 'Aer Lingus',
  comparableCashTicketTotal: 900,
  legs: [
    {
      flightNumber: 'EI151',
      origin: 'LHR',
      destination: 'DUB',
      departure: '2026-11-04T08:00:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T09:15:00+00:00',
      arrivalTz: 'Europe/Dublin',
    },
    {
      flightNumber: 'EI105',
      origin: 'DUB',
      destination: 'JFK',
      departure: '2026-11-04T10:05:00+00:00',
      departureTz: 'Europe/Dublin',
      arrival: '2026-11-04T15:00:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

export const TIE_LEAD_T2: FlightOption = buildOption({
  id: 'T2',
  carrier: 'British Airways',
  comparableCashTicketTotal: 1300,
  legs: [
    {
      flightNumber: 'BA115',
      origin: 'LHR',
      destination: 'JFK',
      departure: '2026-11-04T10:30:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T15:00:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

export function tieOnLeadState(): TripState {
  return buildTripState({
    options: [TIE_LEAD_T1, TIE_LEAD_T2],
    constraints: [DISCRIMINATION_DEADLINE],
    priorityRule: 'arrival_buffer_first',
  });
}

/**
 * Tie on the first TWO comparators.
 *
 * Both arrive with 180 minutes to spare and both are nonstop (0 findings), so
 * arrival_buffer_first must fall through to its THIRD comparator, cashPayable
 * ASC. U1 is cheaper and must win.
 */
export const TIE_TWO_U1: FlightOption = buildOption({
  id: 'U1',
  carrier: 'British Airways',
  comparableCashTicketTotal: 940,
  legs: [
    {
      flightNumber: 'BA175',
      origin: 'LHR',
      destination: 'JFK',
      departure: '2026-11-04T10:30:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T15:00:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

export const TIE_TWO_U2: FlightOption = buildOption({
  id: 'U2',
  carrier: 'Virgin Atlantic',
  comparableCashTicketTotal: 1420,
  legs: [
    {
      flightNumber: 'VS003',
      origin: 'LHR',
      destination: 'JFK',
      departure: '2026-11-04T10:20:00+00:00',
      departureTz: 'Europe/London',
      arrival: '2026-11-04T15:00:00-05:00',
      arrivalTz: 'America/New_York',
    },
  ],
});

export function tieOnTwoState(): TripState {
  return buildTripState({
    options: [TIE_TWO_U1, TIE_TWO_U2],
    constraints: [DISCRIMINATION_DEADLINE],
    priorityRule: 'arrival_buffer_first',
  });
}
