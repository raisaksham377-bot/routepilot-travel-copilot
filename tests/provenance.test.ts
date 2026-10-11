import { describe, expect, it } from 'vitest';
import { decide } from '@/lib/decision';
import { flightOptionSchema } from '@/lib/schema/flightOption';
import { REACHABLE_PROVENANCE } from '@/lib/schema/provenance';
import { assertNotLiveVerified } from '@/lib/sources/FareSource';
import { DISCRIMINATION_OPTIONS, discriminationState } from '@/lib/data/fixtures';
import { buildTripState, deadline } from '@/lib/data/build';
import { ALL_SCENARIOS } from '@/lib/data/scenarios';

/**
 * Provenance affects labelling and staleness messaging ONLY. The moment it
 * reaches the scoring code the engine stops being a pure function of the
 * option data, the golden tests stop proving anything about real-world
 * behaviour, and "sample data" quietly becomes a different product from "real
 * data".
 */

describe('provenance parity', () => {
  it('produces a byte-identical trace whether options are SAMPLE or USER_ENTERED', () => {
    const asSample = discriminationState('arrival_buffer_first');

    const reTagged = DISCRIMINATION_OPTIONS.map((o) =>
      flightOptionSchema.parse({ ...o, provenance: 'USER_ENTERED' }),
    );
    const asUserEntered = buildTripState({
      options: reTagged,
      constraints: [deadline('2026-11-04T18:00', 'America/New_York')],
      priorityRule: 'arrival_buffer_first',
    });

    const a = decide(asSample);
    const b = decide(asUserEntered);

    expect(JSON.stringify(a.trace)).toBe(JSON.stringify(b.trace));
  });

  it('reaches the same recommendation and exclusions either way', () => {
    const reTagged = DISCRIMINATION_OPTIONS.map((o) =>
      flightOptionSchema.parse({ ...o, provenance: 'USER_ENTERED', capturedFrom: 'a browser tab' }),
    );
    const a = decide(discriminationState('lowest_cash_outlay'));
    const b = decide(
      buildTripState({
        options: reTagged,
        constraints: [deadline('2026-11-04T18:00', 'America/New_York')],
        priorityRule: 'lowest_cash_outlay',
      }),
    );
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('expected ok');

    expect(b.recommendation.chosenOptionId).toBe(a.recommendation.chosenOptionId);
    expect(b.excluded.map((e) => e.option.id)).toEqual(a.excluded.map((e) => e.option.id));
  });
});

describe('LIVE_VERIFIED is reserved and unreachable in P0', () => {
  it('no seeded option claims verified live data', () => {
    for (const scenario of ALL_SCENARIOS) {
      for (const option of scenario.state.options) {
        expect(REACHABLE_PROVENANCE).toContain(option.provenance);
        expect(option.provenance).not.toBe('LIVE_VERIFIED');
      }
    }
  });

  it('the fare-source guard rejects any source claiming it', () => {
    expect(() => assertNotLiveVerified('LIVE_VERIFIED')).toThrow(/reserved and unreachable/);
    expect(() => assertNotLiveVerified('SAMPLE')).not.toThrow();
    expect(() => assertNotLiveVerified('USER_ENTERED')).not.toThrow();
  });
});
