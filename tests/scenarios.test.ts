import { describe, expect, it } from 'vitest';
import { decide } from '@/lib/decision';
import { renderBrief, SAMPLE_DATA_NOTICE } from '@/lib/brief/render';
import {
  ALL_SCENARIOS,
  CORE_SCENARIOS,
  s1,
  s2,
  s4,
  s4AfterConstraintTightened,
  s4AfterPriorityChange,
  s5,
  s5UnresolvableDeadlineState,
  s6,
  s7,
  s8,
  s9,
} from '@/lib/data/scenarios';

/** The nine seeded scenarios, as golden tests. */

describe('all nine scenarios are seeded and evaluable', () => {
  it('has nine scenarios, eight of which never touch the rewards module', () => {
    expect(ALL_SCENARIOS).toHaveLength(9);
    expect(CORE_SCENARIOS).toHaveLength(8);
  });

  it.each(ALL_SCENARIOS)('$id produces a structured result, never a throw', (scenario) => {
    const result = decide(scenario.state);
    expect(['ok', 'no_feasible_option', 'missing_required', 'contradiction']).toContain(
      result.status,
    );
    // Every result carries a trace, including the refusals.
    expect(result.trace.schemaVersion).toBe(1);
    expect(result.trace.evaluatedAt).toBe(scenario.state.asOf);
  });

  it('labels every seeded option as SAMPLE and never as LIVE_VERIFIED', () => {
    for (const scenario of ALL_SCENARIOS) {
      for (const option of scenario.state.options) {
        expect(option.provenance).toBe('SAMPLE');
      }
    }
  });
});

describe('S1 — the cheapest option misses the arrival deadline', () => {
  it('eliminates it at the gate rather than down-ranking it', () => {
    const result = decide(s1.state);
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.excluded.map((e) => e.option.id)).toEqual(['D']);
    expect(result.ranked.map((r) => r.option.id)).not.toContain('D');
  });

  it('shows the instant comparison in the trace, not a clock-time one', () => {
    const result = decide(s1.state);
    if (result.status !== 'ok') throw new Error('expected ok');
    const reason = result.excluded[0]!.reasons[0]!;
    expect(reason.comparison).toContain('2026-11-04T18:20:00-05:00');
    expect(reason.comparison).toContain('after the deadline');
  });

  it('addresses the exclusion in the brief', () => {
    const result = decide(s1.state);
    const brief = renderBrief(s1.state, result);
    expect(brief).toContain('Excluded, and why');
    expect(brief).toContain('D');
  });
});

describe('S2 — a low fare with an impractical overnight connection', () => {
  it('keeps it feasible but raises a named overnight finding', () => {
    const result = decide(s2.state);
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(result.ranked.map((r) => r.option.id)).toContain('OVERNIGHT');
    const risks = result.trace.measures['OVERNIGHT']!.connectionRisks;
    expect(risks.map((r) => r.code)).toContain('overnight_connection');
    expect(risks[0]!.detail).toContain('DUB');
  });

  it('does not rank it first under arrival_buffer_first', () => {
    const result = decide({ ...s2.state, priorityRule: 'arrival_buffer_first' });
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.recommendation.chosenOptionId).toBe('NONSTOP');
  });

  it('does not rank it first under fewest_connection_risks', () => {
    const result = decide({ ...s2.state, priorityRule: 'fewest_connection_risks' });
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.recommendation.chosenOptionId).toBe('NONSTOP');
  });

  it('may legitimately rank it first under lowest_cash_outlay', () => {
    const result = decide({ ...s2.state, priorityRule: 'lowest_cash_outlay' });
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.recommendation.chosenOptionId).toBe('OVERNIGHT');
    // ...but the finding still travels with it into the risks section.
    expect(result.recommendation.risks.join(' ')).toContain('small hours');
  });
});

describe('S4 — the user changes a key preference mid-conversation', () => {
  it('re-ranks and changes the recommendation when the priority changes', () => {
    const before = decide(s4.state);
    const after = decide(s4AfterPriorityChange());
    if (before.status !== 'ok' || after.status !== 'ok') throw new Error('expected ok');

    expect(before.recommendation.chosenOptionId).toBe('A');
    expect(after.recommendation.chosenOptionId).toBe('C');
  });

  it('leaves the prior trace separately inspectable rather than mutating it', () => {
    const before = decide(s4.state);
    const after = decide(s4AfterPriorityChange());
    if (before.status !== 'ok' || after.status !== 'ok') throw new Error('expected ok');

    expect(before.trace.priorityRule).toBe('arrival_buffer_first');
    expect(after.trace.priorityRule).toBe('lowest_cash_outlay');
    expect(before.trace.rankedOrder).not.toEqual(after.trace.rankedOrder);
    // The earlier object is untouched by the later evaluation.
    expect(before.trace.rankedOrder).toEqual(['A', 'C', 'B']);
  });

  it('re-runs the feasibility gate when a constraint is tightened to hard', () => {
    const after = decide(s4AfterConstraintTightened());
    if (after.status !== 'ok') throw new Error('expected ok');

    // A's 55-minute connection now breaks a firm 90-minute requirement.
    expect(after.excluded.map((e) => e.option.id).sort()).toEqual(['A', 'D']);
    expect(after.recommendation.chosenOptionId).toBe('C');
  });
});

describe('S5 — missing or ambiguous information', () => {
  it('returns missing_required and names the option and field', () => {
    const result = decide(s5.state);
    expect(result.status).toBe('missing_required');
    if (result.status !== 'missing_required') return;

    const need = result.needs.find((n) => n.optionId === 'INCOMPLETE');
    expect(need).toBeDefined();
    expect(need!.field).toBe('comparableCashTicketTotal');
  });

  it('produces no recommendation while a required value is unknown', () => {
    const result = decide(s5.state);
    expect(result.status).toBe('missing_required');
    expect(result).not.toHaveProperty('recommendation');
  });

  it('says so in the brief rather than rendering a half-decision', () => {
    const result = decide(s5.state);
    const brief = renderBrief(s5.state, result);
    expect(brief).toContain('No recommendation yet');
    expect(brief).toContain('Nothing was guessed');
  });

  /**
   * An unresolvable deadline must NOT degrade into "no deadline" -- that would
   * silently promote an infeasible option into a recommendation.
   */
  it('reports an unresolvable deadline instead of ignoring it', () => {
    const result = decide(s5UnresolvableDeadlineState());
    expect(result.status).toBe('missing_required');
    if (result.status !== 'missing_required') return;
    expect(result.needs.some((n) => n.constraintKey === 'arrival_deadline')).toBe(true);
    expect(result.trace.deadline.resolvedInstant).toBeNull();
  });
});

describe('S6 — contradictory information', () => {
  it('surfaces both values with their sources and refuses to choose', () => {
    const result = decide(s6.state);
    expect(result.status).toBe('contradiction');
    if (result.status !== 'contradiction') return;

    const conflict = result.conflicts.find((c) => c.constraintKey === 'arrival_deadline');
    expect(conflict).toBeDefined();
    expect(conflict!.values).toHaveLength(2);
    expect(conflict!.values.map((v) => v.source).sort()).toEqual(['inferred', 'stated']);
  });

  it('shows both in the brief without picking one', () => {
    const result = decide(s6.state);
    const brief = renderBrief(s6.state, result);
    expect(brief).toContain('more than one value');
    expect(brief).toContain('will not pick one for you');
  });
});

describe('S7 — stale option data', () => {
  it('marks the option stale and downgrades the recommendation to provisional', () => {
    const result = decide(s7.state);
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(result.trace.measures['STALE']!.isStale).toBe(true);
    expect(result.trace.measures['NONSTOP']!.isStale).toBe(false);
    expect(result.recommendation.provisional).toBe(true);
    expect(result.recommendation.provisionalReason).toContain('staleness threshold');
  });

  it('carries the warning into the brief', () => {
    const result = decide(s7.state);
    const brief = renderBrief(s7.state, result);
    expect(brief).toContain('Provisional');
  });
});

describe('S8 — no option satisfies all hard constraints', () => {
  it('returns no_feasible_option and fabricates no winner', () => {
    const result = decide(s8.state);
    expect(result.status).toBe('no_feasible_option');
    expect(result).not.toHaveProperty('recommendation');
    expect(result).not.toHaveProperty('ranked');
  });

  it('computes a single-constraint relaxation only where exactly one is violated', () => {
    const result = decide(s8.state);
    if (result.status !== 'no_feasible_option') throw new Error('expected no_feasible_option');

    const byOption = new Map(
      result.relaxation.singleConstraint.map((s) => [s.viaOptionId, s] as const),
    );

    // Late by 20 minutes, within budget -> deadline relaxation is arithmetic.
    expect(byOption.get('LATE-ONLY')).toMatchObject({
      constraint: 'arrival_deadline',
      amount: 20,
      unit: 'minutes',
    });

    // Over budget by 300, arrives in time -> budget relaxation is arithmetic.
    expect(byOption.get('OVER-BUDGET')).toMatchObject({
      constraint: 'budget_ceiling',
      amount: 300,
      unit: 'currency',
    });

    // Violates BOTH, so no single-constraint figure is offered for it.
    expect(byOption.has('LATE-AND-PRICEY')).toBe(false);
  });

  it('lists multi-violation options as candidates with what each breaks', () => {
    const result = decide(s8.state);
    if (result.status !== 'no_feasible_option') throw new Error('expected no_feasible_option');

    const candidate = result.relaxation.candidates.find((c) => c.optionId === 'LATE-AND-PRICEY');
    expect(candidate).toBeDefined();
    expect(candidate!.violates).toEqual(['arrival_deadline', 'budget_ceiling']);
  });

  /**
   * The engine must not imply it searched a multi-constraint space. It did not.
   */
  it('states that no global optimum is claimed', () => {
    const result = decide(s8.state);
    if (result.status !== 'no_feasible_option') throw new Error('expected no_feasible_option');
    expect(result.relaxation.disclaimer).toContain('holds every other constraint unchanged');
    expect(result.relaxation.disclaimer).toContain('not a search for the smallest overall change');

    const brief = renderBrief(s8.state, result);
    expect(brief).toContain('No winner has been invented');
  });
});

describe('S9 — the reasoning is explainable from the stored trace alone', () => {
  it('answers "why is this ranked here?" from the trace, with both values', () => {
    const result = decide(s9.state);
    if (result.status !== 'ok') throw new Error('expected ok');

    // fewest_connection_risks -> B, C, A
    expect(result.trace.rankedOrder).toEqual(['B', 'C', 'A']);
    for (const decision of result.trace.rankingDecisions) {
      expect(decision.decidedBy).toBeTruthy();
      expect(decision.higherValue).not.toBeUndefined();
      expect(decision.lowerValue).not.toBeUndefined();
    }
    expect(result.recommendation.decidingComparator).toMatchObject({
      decidedBy: 'connectionRiskCount',
      direction: 'ASC',
      higherValue: 0,
      lowerValue: 1,
    });
  });

  it('records the comparator sequence that was applied', () => {
    const result = decide(s9.state);
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.trace.comparators).toEqual([
      { measure: 'connectionRiskCount', direction: 'ASC' },
      { measure: 'arrivalMarginMinutes', direction: 'DESC' },
      { measure: 'cashPayable', direction: 'ASC' },
    ]);
  });

  it('keeps provenance and asOf with every option', () => {
    const result = decide(s9.state);
    if (result.status !== 'ok') throw new Error('expected ok');
    for (const r of result.ranked) {
      expect(r.option.provenance).toBe('SAMPLE');
      expect(r.option.asOf).toBeTruthy();
    }
  });

  it('states in the brief that nothing was fetched live', () => {
    const result = decide(s9.state);
    const brief = renderBrief(s9.state, result);
    expect(brief).toContain(SAMPLE_DATA_NOTICE);
    expect(brief).toContain('not bookable');
  });
});
