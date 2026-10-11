import { describe, expect, it } from 'vitest';
import { decide } from '@/lib/decision';
import { PRIORITY_RULES } from '@/lib/decision/priority';
import {
  DISCRIMINATION_OPTIONS,
  EXPECTED_DISCRIMINATION_ORDERS,
  discriminationState,
  tieOnLeadState,
  tieOnTwoState,
} from '@/lib/data/fixtures';
import type { PriorityRuleName } from '@/lib/schema/tripState';

const RULES = Object.keys(PRIORITY_RULES) as PriorityRuleName[];

function rankedIds(rule: PriorityRuleName): string[] {
  const result = decide(discriminationState(rule));
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
  return result.ranked.map((r) => r.option.id);
}

describe('the discrimination fixture produces the documented measures', () => {
  it('computes the exact target measures for every option', () => {
    const result = decide(discriminationState('arrival_buffer_first'));
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    const m = result.trace.measures;

    expect(m['A']).toMatchObject({
      arrivalMarginMinutes: 240,
      connectionRiskCount: 2,
      cashPayable: 1240,
      travelDurationMinutes: 670,
    });
    expect(m['B']).toMatchObject({
      arrivalMarginMinutes: 95,
      connectionRiskCount: 0,
      cashPayable: 1105,
      travelDurationMinutes: 580,
    });
    expect(m['C']).toMatchObject({
      arrivalMarginMinutes: 150,
      connectionRiskCount: 1,
      cashPayable: 980,
      travelDurationMinutes: 750,
    });
    expect(m['D']).toMatchObject({
      arrivalMarginMinutes: -20,
      connectionRiskCount: 0,
      cashPayable: 610,
      travelDurationMinutes: 535,
    });
  });
});

describe('the four priority rules', () => {
  it.each(RULES)('%s produces its documented order', (rule) => {
    expect(rankedIds(rule)).toEqual(EXPECTED_DISCRIMINATION_ORDERS[rule]);
  });

  /**
   * This asserts a property of the FIXTURE, not of the code -- and that is the
   * point. An earlier draft priced A at $980 and B at $1,240, which made
   * lowest_cash_outlay return the same order as arrival_buffer_first. Every
   * individual order assertion still passed, so the suite stayed green while
   * silently testing three behaviours instead of four.
   *
   * Without this check, any future edit to a cash, margin, risk or duration
   * value could re-collapse two rules unnoticed.
   */
  it('discriminates between all four rules -- four distinct orders', () => {
    const orders = RULES.map((r) => rankedIds(r).join(','));
    expect(new Set(orders).size).toBe(4);
  });

  it('records the deciding comparator and both values for every adjacent pair', () => {
    const result = decide(discriminationState('arrival_buffer_first'));
    if (result.status !== 'ok') throw new Error('expected ok');

    // A, C, B -- both gaps decided on the lead comparator, arrival margin DESC.
    expect(result.trace.rankingDecisions).toEqual([
      {
        higherId: 'A',
        lowerId: 'C',
        decidedBy: 'arrivalMarginMinutes',
        direction: 'DESC',
        higherValue: 240,
        lowerValue: 150,
      },
      {
        higherId: 'C',
        lowerId: 'B',
        decidedBy: 'arrivalMarginMinutes',
        direction: 'DESC',
        higherValue: 150,
        lowerValue: 95,
      },
    ]);
  });
});

describe('the feasibility gate beats price and speed', () => {
  it('never ranks a hard-constraint violator, under any rule', () => {
    for (const rule of RULES) {
      const result = decide(discriminationState(rule));
      if (result.status !== 'ok') throw new Error('expected ok');
      expect(result.ranked.map((r) => r.option.id)).not.toContain('D');
      expect(result.excluded.map((e) => e.option.id)).toContain('D');
      expect(result.recommendation.chosenOptionId).not.toBe('D');
    }
  });

  /**
   * Guards against the assertion above passing for an uninteresting reason. If
   * D were simply the worst option on every measure, excluding it would prove
   * nothing about the gate's priority over cost and speed.
   */
  it('and the excluded option really is the cheapest and the fastest', () => {
    const cash = DISCRIMINATION_OPTIONS.map((o) => o.comparableCashTicketTotal ?? Infinity);
    const result = decide(discriminationState('arrival_buffer_first'));
    if (result.status !== 'ok') throw new Error('expected ok');
    const durations = DISCRIMINATION_OPTIONS.map(
      (o) => result.trace.measures[o.id]!.travelDurationMinutes,
    );

    expect(Math.min(...cash)).toBe(610); // option D
    expect(Math.min(...durations)).toBe(535); // option D
  });

  it('names the constraint and the failed comparison when eliminating', () => {
    const result = decide(discriminationState('lowest_cash_outlay'));
    if (result.status !== 'ok') throw new Error('expected ok');
    const d = result.excluded.find((e) => e.option.id === 'D')!;
    expect(d.reasons).toHaveLength(1);
    expect(d.reasons[0]!.constraintKey).toBe('arrival_deadline');
    expect(d.reasons[0]!.exceededBy).toBe(20);
    expect(d.reasons[0]!.exceededByUnit).toBe('minutes');
    expect(d.reasons[0]!.comparison).toContain('after the deadline');
  });
});

describe('comparator fall-through', () => {
  it('falls through to the SECOND comparator when the lead ties', () => {
    const result = decide(tieOnLeadState());
    if (result.status !== 'ok') throw new Error('expected ok');

    // Both arrive with 180 minutes to spare.
    expect(result.trace.measures['T1']!.arrivalMarginMinutes).toBe(180);
    expect(result.trace.measures['T2']!.arrivalMarginMinutes).toBe(180);

    // T2 is nonstop, T1 has a tight connection, so risk count decides.
    expect(result.ranked.map((r) => r.option.id)).toEqual(['T2', 'T1']);
    expect(result.trace.rankingDecisions[0]).toMatchObject({
      higherId: 'T2',
      lowerId: 'T1',
      decidedBy: 'connectionRiskCount',
      direction: 'ASC',
      higherValue: 0,
      lowerValue: 2,
    });
  });

  it('falls through to the THIRD comparator when the first two tie', () => {
    const result = decide(tieOnTwoState());
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(result.trace.measures['U1']!.arrivalMarginMinutes).toBe(180);
    expect(result.trace.measures['U2']!.arrivalMarginMinutes).toBe(180);
    expect(result.trace.measures['U1']!.connectionRiskCount).toBe(0);
    expect(result.trace.measures['U2']!.connectionRiskCount).toBe(0);

    // Cheaper cash outlay decides.
    expect(result.ranked.map((r) => r.option.id)).toEqual(['U1', 'U2']);
    expect(result.trace.rankingDecisions[0]).toMatchObject({
      decidedBy: 'cashPayable',
      direction: 'ASC',
      higherValue: 940,
      lowerValue: 1420,
    });
  });
});
