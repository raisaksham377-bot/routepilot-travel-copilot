import { describe, expect, it } from 'vitest';
import { decide } from '@/lib/decision';
import { PRIORITY_RULES } from '@/lib/decision/priority';
import { DISCRIMINATION_OPTIONS, discriminationState } from '@/lib/data/fixtures';
import { buildOption, buildTripState, deadline } from '@/lib/data/build';
import type { PriorityRuleName } from '@/lib/schema/tripState';

const RULES = Object.keys(PRIORITY_RULES) as PriorityRuleName[];

/**
 * Reproducibility is what makes the decision record worth auditing. If the same
 * input could produce a different trace, the trace would be a story rather than
 * a record.
 *
 * This is why `decide()` takes `evaluatedAt` from the trip state instead of
 * reading `Date.now()`, and why ranking ends with an option-id tiebreak to
 * guarantee a total order.
 */

describe('byte-level reproducibility', () => {
  it.each(RULES)('%s produces a byte-identical trace on repeat evaluation', (rule) => {
    const state = discriminationState(rule);
    const first = decide(state);
    const second = decide(state);
    expect(JSON.stringify(first.trace)).toBe(JSON.stringify(second.trace));
  });

  it('does not read the clock -- evaluatedAt comes from the input', () => {
    const state = discriminationState('arrival_buffer_first');
    const result = decide(state);
    expect(result.trace.evaluatedAt).toBe(state.asOf);

    // A different stated evaluation time changes the trace, proving the value
    // is threaded through rather than sampled.
    const later = decide({ ...state, asOf: '2026-11-02T09:00:00Z' });
    expect(later.trace.evaluatedAt).toBe('2026-11-02T09:00:00Z');
  });
});

describe('order independence', () => {
  /**
   * Compares the ranking rather than the whole serialised trace, deliberately.
   * `trace.measures` is an object keyed by option id, so shuffling the input
   * changes key insertion order and therefore the JSON string -- without
   * changing any decision. The meaningful invariant is the ranking and the
   * decisions behind it.
   */
  it.each(RULES)('%s ranks identically however the input is ordered', (rule) => {
    const base = discriminationState(rule);
    const expected = decide(base);
    if (expected.status !== 'ok') throw new Error('expected ok');

    const permutations = [
      [3, 2, 1, 0],
      [1, 0, 3, 2],
      [2, 0, 3, 1],
      [0, 3, 1, 2],
    ];

    for (const perm of permutations) {
      const shuffled = buildTripState({
        options: perm.map((i) => DISCRIMINATION_OPTIONS[i]!),
        constraints: [deadline('2026-11-04T18:00', 'America/New_York')],
        priorityRule: rule,
      });
      const actual = decide(shuffled);
      if (actual.status !== 'ok') throw new Error('expected ok');

      expect(actual.trace.rankedOrder).toEqual(expected.trace.rankedOrder);
      expect(actual.trace.rankingDecisions).toEqual(expected.trace.rankingDecisions);
      expect(actual.recommendation.chosenOptionId).toBe(expected.recommendation.chosenOptionId);
    }
  });

  it('breaks a total tie by option id so the order cannot depend on input order', () => {
    // Two options identical on every comparator.
    const makeState = (order: 'forward' | 'reverse') => {
      const legs = (flightNumber: string) => [
        {
          flightNumber,
          origin: 'LHR',
          destination: 'JFK',
          departure: '2026-11-04T10:00:00+00:00',
          departureTz: 'Europe/London',
          arrival: '2026-11-04T15:00:00-05:00',
          arrivalTz: 'America/New_York',
        },
      ];
      const z = {
        id: 'Z-SECOND',
        carrier: 'Carrier Z',
        comparableCashTicketTotal: 1000,
        legs: legs('ZZ1'),
      };
      const a = {
        id: 'A-FIRST',
        carrier: 'Carrier A',
        comparableCashTicketTotal: 1000,
        legs: legs('AA1'),
      };
      const specs = order === 'forward' ? [a, z] : [z, a];
      return specs;
    };

    // Built through the real builder so schema validation stays in play.
    for (const order of ['forward', 'reverse'] as const) {
      const options = makeState(order).map(buildOption);
      const state = buildTripState({
        options,
        constraints: [deadline('2026-11-04T18:00', 'America/New_York')],
      });
      const result = decide(state);
      if (result.status !== 'ok') throw new Error('expected ok');
      expect(result.trace.rankedOrder).toEqual(['A-FIRST', 'Z-SECOND']);
      expect(result.trace.rankingDecisions[0]!.decidedBy).toBe('option_id_tiebreak');
    }
  });
});
