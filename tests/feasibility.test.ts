import { describe, expect, it } from 'vitest';
import { decide } from '@/lib/decision';
import { cashPayable, connectionRisks } from '@/lib/decision';
import { buildOption, buildTripState, deadline } from '@/lib/data/build';
import { OPTION_A, OPTION_B, OPTION_C, discriminationState } from '@/lib/data/fixtures';
import { S3_AWARD, S3_CASH } from '@/lib/data/scenarios';
import type { Constraint } from '@/lib/schema/constraint';

/** Stage 1 and stage 2 in isolation. */

describe('hard versus soft constraints', () => {
  it('a hard constraint eliminates', () => {
    const hard: Constraint = {
      key: 'min_connection_minutes',
      value: 90,
      kind: 'hard',
      source: 'stated',
    };
    const state = buildTripState({
      options: [OPTION_A, OPTION_B],
      constraints: [deadline('2026-11-04T18:00', 'America/New_York'), hard],
    });
    const result = decide(state);
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.excluded.map((e) => e.option.id)).toEqual(['A']);
  });

  it('the soft version of the same constraint raises a finding instead', () => {
    const soft: Constraint = {
      key: 'min_connection_minutes',
      value: 90,
      kind: 'soft',
      source: 'stated',
    };
    const state = buildTripState({
      options: [OPTION_A, OPTION_B],
      constraints: [deadline('2026-11-04T18:00', 'America/New_York'), soft],
    });
    const result = decide(state);
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(result.excluded).toHaveLength(0);
    expect(result.ranked.map((r) => r.option.id)).toContain('A');
    expect(
      result.trace.measures['A']!.connectionRisks.map((r) => r.code),
    ).toContain('buffer_below_minimum');
  });
});

describe('each hard constraint type', () => {
  const base = deadline('2026-11-04T18:00', 'America/New_York');

  it('cabin_floor eliminates a cabin below the floor', () => {
    const economy = buildOption({
      id: 'ECON',
      carrier: 'British Airways',
      cabin: 'economy',
      comparableCashTicketTotal: 500,
      legs: OPTION_B.legs,
    });
    const state = buildTripState({
      options: [economy, OPTION_B],
      constraints: [base, { key: 'cabin_floor', value: 'business', kind: 'hard', source: 'stated' }],
    });
    const result = decide(state);
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.excluded.map((e) => e.option.id)).toEqual(['ECON']);
    expect(result.excluded[0]!.reasons[0]!.exceededByUnit).toBe('cabin_steps');
  });

  it('budget_ceiling eliminates on cash payable, naming the overshoot', () => {
    const state = buildTripState({
      options: [OPTION_A, OPTION_C],
      constraints: [base, { key: 'budget_ceiling', value: 1000, kind: 'hard', source: 'stated' }],
    });
    const result = decide(state);
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.excluded.map((e) => e.option.id)).toEqual(['A']);
    expect(result.excluded[0]!.reasons[0]!.exceededBy).toBe(240); // 1240 - 1000
  });

  it('origin and destination eliminate a mismatched route', () => {
    const state = buildTripState({
      options: [OPTION_B],
      constraints: [base, { key: 'origin', value: 'LGW', kind: 'hard', source: 'stated' }],
    });
    const result = decide(state);
    expect(result.status).toBe('no_feasible_option');
  });

  it('avoid_overnight_connection eliminates only when set to true', () => {
    const overnightState = (value: boolean) =>
      buildTripState({
        options: [OPTION_A],
        constraints: [
          base,
          { key: 'avoid_overnight_connection', value, kind: 'hard', source: 'stated' },
        ],
      });
    // Option A's connection is in the morning, so the rule does not bite.
    const result = decide(overnightState(true));
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.excluded).toHaveLength(0);
  });
});

describe('connection findings', () => {
  it('a tight single connection yields both buffer and tight findings', () => {
    // Option A: one connection, 55 minutes, against a 75-minute minimum.
    const risks = connectionRisks(OPTION_A, 75);
    expect(risks.map((r) => r.code).sort()).toEqual([
      'buffer_below_minimum',
      'tight_single_connection',
    ]);
  });

  it('a comfortable single connection yields only the tight finding below 1.5x', () => {
    // Option C: one connection, 90 minutes. 75 <= 90 < 112.5.
    const risks = connectionRisks(OPTION_C, 75);
    expect(risks.map((r) => r.code)).toEqual(['tight_single_connection']);
  });

  it('a nonstop itinerary yields none', () => {
    expect(connectionRisks(OPTION_B, 75)).toEqual([]);
  });

  it('findings state what the schedule does, with the airport and the buffer', () => {
    const risks = connectionRisks(OPTION_A, 75);
    for (const r of risks) {
      expect(r.airport).toBe('DUB');
      expect(r.bufferMinutes).toBe(55);
      expect(r.detail).toContain('DUB');
    }
  });
});

describe('cash payable selects exactly one source', () => {
  it('uses the ticket total for a cash option', () => {
    expect(cashPayable(S3_CASH)).toBe(2400);
  });

  it('uses the co-payment alone for an award option', () => {
    expect(cashPayable(S3_AWARD)).toBe(1150);
  });

  it('never sums the two figures', () => {
    expect(cashPayable(S3_AWARD)).not.toBe(2400 + 1150);
  });
});

describe('the gate runs before ranking', () => {
  it('eliminated options never appear in the ranked set', () => {
    const result = decide(discriminationState('lowest_cash_outlay'));
    if (result.status !== 'ok') throw new Error('expected ok');
    const rankedIds = new Set(result.ranked.map((r) => r.option.id));
    for (const ex of result.excluded) {
      expect(rankedIds.has(ex.option.id)).toBe(false);
    }
  });

  it('records a pass or eliminate outcome for every option', () => {
    const result = decide(discriminationState('arrival_buffer_first'));
    expect(result.trace.feasibility).toHaveLength(4);
    expect(result.trace.feasibility.filter((f) => f.outcome === 'eliminated')).toHaveLength(1);
  });
});
