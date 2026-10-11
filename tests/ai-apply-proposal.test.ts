import { describe, expect, it } from 'vitest';
import { applyProposedConstraint, isHumanAuthored, needsToQuestions } from '@/lib/ai/applyProposal';
import { interpretUtterance, type ModelCaller } from '@/lib/ai/interpret';
import { getAiConfig, type EnvSource } from '@/lib/ai/config';
import type { ConstraintPatch } from '@/lib/ai/constraintPatch';
import { decide } from '@/lib/decision';
import { buildTripState, deadline } from '@/lib/data/build';
import { S2_NONSTOP } from '@/lib/data/scenarios';
import type { Constraint } from '@/lib/schema/constraint';

/**
 * Explicit confirmation, and what happens when a proposal meets the engine.
 *
 * The central property: a model suggestion must never become a trip decision
 * without a human action, and must never quietly overwrite something the human
 * already said.
 */

const enabled = () =>
  getAiConfig({ AI_FEATURES_ENABLED: 'true', ANTHROPIC_API_KEY: 'placeholder' } as EnvSource);

const inferredCabin: Constraint = {
  key: 'cabin_floor',
  value: 'business',
  kind: 'soft',
  source: 'inferred',
  confidence: 0.9,
};

const statedDeadline: Constraint = {
  key: 'arrival_deadline',
  value: { localDateTime: '2026-11-04T12:00', tz: 'America/New_York' },
  kind: 'hard',
  source: 'stated',
};

const inferredDeadline: Constraint = {
  key: 'arrival_deadline',
  value: { localDateTime: '2026-11-04T18:00', tz: 'America/New_York' },
  kind: 'soft',
  source: 'inferred',
  confidence: 0.6,
};

const emptyState = () => buildTripState({ options: [S2_NONSTOP], constraints: [] });

describe('nothing is applied without an explicit action', () => {
  it('a successful interpretation leaves the trip state untouched until applied', async () => {
    const patch: ConstraintPatch = {
      proposals: [
        {
          key: 'cabin_floor',
          rawValue: 'business',
          timezone: null,
          suggestedKind: 'hard',
          confidence: 0.95,
          evidence: 'needs to work onboard',
        },
      ],
      clarifyingQuestions: [],
      unmapped: [],
    };
    const caller: ModelCaller = async () => ({ ok: true, raw: patch });

    const state = emptyState();
    const before = JSON.stringify(state.constraints);

    const result = await interpretUtterance(
      { utterance: 'business class please', constraints: state.constraints, config: enabled() },
      caller,
    );

    expect(result.status).toBe('ok');
    // The proposal exists, but the state is unchanged. Interpreting is not applying.
    expect(JSON.stringify(state.constraints)).toBe(before);
    if (result.status === 'ok') expect(result.patch.accepted).toHaveLength(1);
  });

  it('applying is what changes the state, and it records user ownership', () => {
    const outcome = applyProposedConstraint(emptyState(), inferredCabin, 'soft');
    expect(outcome.outcome).toBe('applied');
    if (outcome.outcome !== 'applied') return;

    const added = outcome.state.constraints.find((c) => c.key === 'cabin_floor')!;
    expect(added.value).toBe('business');
    // Ownership transfers on acceptance: no longer 'inferred'.
    expect(added.source).toBe('user-edited');
  });

  it('promoting to a firm requirement is a separate, explicit choice', () => {
    const asSoft = applyProposedConstraint(emptyState(), inferredCabin, 'soft');
    const asHard = applyProposedConstraint(emptyState(), inferredCabin, 'hard');

    expect(asSoft.outcome).toBe('applied');
    expect(asHard.outcome).toBe('applied');
    if (asSoft.outcome !== 'applied' || asHard.outcome !== 'applied') return;

    expect(asSoft.state.constraints[0]!.kind).toBe('soft');
    expect(asHard.state.constraints[0]!.kind).toBe('hard');
    // The proposal itself carried kind 'soft'; only the user can make it hard.
    expect(inferredCabin.kind).toBe('soft');
  });
});

describe('a proposal never silently overwrites a human decision', () => {
  it('conflicts when a STATED constraint has a different value', () => {
    const state = buildTripState({ options: [S2_NONSTOP], constraints: [statedDeadline] });
    const outcome = applyProposedConstraint(state, inferredDeadline, 'soft');

    expect(outcome.outcome).toBe('conflict');
    if (outcome.outcome !== 'conflict') return;

    // Both values are surfaced, neither is chosen.
    expect(outcome.message).toContain('2026-11-04T12:00');
    expect(outcome.message).toContain('2026-11-04T18:00');
    expect(outcome.existing.source).toBe('stated');
    // Critically: the state object is not returned, so nothing can be applied.
    expect(outcome).not.toHaveProperty('state');
  });

  it('conflicts when a USER-EDITED constraint has a different value', () => {
    const userEdited: Constraint = { ...statedDeadline, source: 'user-edited' };
    const state = buildTripState({ options: [S2_NONSTOP], constraints: [userEdited] });
    expect(applyProposedConstraint(state, inferredDeadline, 'soft').outcome).toBe('conflict');
  });

  it('replaces without conflict when the existing value was itself INFERRED', () => {
    const state = buildTripState({ options: [S2_NONSTOP], constraints: [inferredDeadline] });
    const stated: Constraint = { ...statedDeadline };
    const outcome = applyProposedConstraint(state, stated, 'hard');

    expect(outcome.outcome).toBe('replaced');
    if (outcome.outcome !== 'replaced') return;
    expect(outcome.previous.source).toBe('inferred');
    expect(outcome.state.constraints).toHaveLength(1);
  });

  it('replaces without conflict when the values are identical', () => {
    const state = buildTripState({ options: [S2_NONSTOP], constraints: [statedDeadline] });
    const sameValueProposal: Constraint = { ...statedDeadline, source: 'inferred', kind: 'soft' };
    expect(applyProposedConstraint(state, sameValueProposal, 'hard').outcome).toBe('replaced');
  });

  it('allows an override, but only when explicitly requested', () => {
    const state = buildTripState({ options: [S2_NONSTOP], constraints: [statedDeadline] });

    expect(applyProposedConstraint(state, inferredDeadline, 'soft').outcome).toBe('conflict');

    const forced = applyProposedConstraint(state, inferredDeadline, 'soft', {
      overrideHumanValue: true,
    });
    expect(forced.outcome).toBe('replaced');
    if (forced.outcome !== 'replaced') return;
    expect(forced.state.constraints).toHaveLength(1);
    expect(forced.state.constraints[0]!.source).toBe('user-edited');
  });

  it('classifies constraint sources correctly', () => {
    expect(isHumanAuthored(statedDeadline)).toBe(true);
    expect(isHumanAuthored({ ...statedDeadline, source: 'user-edited' })).toBe(true);
    expect(isHumanAuthored(inferredDeadline)).toBe(false);
    expect(isHumanAuthored({ ...statedDeadline, source: 'profile' })).toBe(false);
  });

  it('never leaves two constraints with the same key', () => {
    const state = buildTripState({ options: [S2_NONSTOP], constraints: [inferredDeadline] });
    const outcome = applyProposedConstraint(state, statedDeadline, 'hard');
    if (outcome.outcome === 'conflict') throw new Error('unexpected conflict');
    const keys = outcome.state.constraints.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('applied proposals meet the engine correctly', () => {
  it('an accepted hard deadline actually eliminates an infeasible option', () => {
    // NONSTOP arrives 14:00-05:00. A 13:00 deadline makes it infeasible.
    const tight: Constraint = {
      key: 'arrival_deadline',
      value: { localDateTime: '2026-11-04T13:00', tz: 'America/New_York' },
      kind: 'soft',
      source: 'inferred',
    };
    const outcome = applyProposedConstraint(emptyState(), tight, 'hard');
    if (outcome.outcome !== 'applied') throw new Error('expected applied');

    const result = decide(outcome.state);
    expect(result.status).toBe('no_feasible_option');
  });

  it('the same proposal accepted as a PREFERENCE does not eliminate it', () => {
    const tight: Constraint = {
      key: 'arrival_deadline',
      value: { localDateTime: '2026-11-04T13:00', tz: 'America/New_York' },
      kind: 'soft',
      source: 'inferred',
    };
    const outcome = applyProposedConstraint(emptyState(), tight, 'soft');
    if (outcome.outcome !== 'applied') throw new Error('expected applied');

    // Soft constraints inform, they do not exclude. The option survives.
    const result = decide(outcome.state);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.ranked.map((r) => r.option.id)).toContain('NONSTOP');
  });

  it('missing information still blocks a recommendation after a proposal is applied', () => {
    // An option with no cash figure: the engine must still refuse.
    const incomplete = buildTripState({
      options: [S2_NONSTOP, { ...S2_NONSTOP, id: 'NO-PRICE', comparableCashTicketTotal: null }],
      constraints: [],
    });
    const outcome = applyProposedConstraint(incomplete, inferredCabin, 'soft');
    if (outcome.outcome !== 'applied') throw new Error('expected applied');

    const result = decide(outcome.state);
    expect(result.status).toBe('missing_required');
    if (result.status !== 'missing_required') return;
    expect(result.needs.some((n) => n.optionId === 'NO-PRICE')).toBe(true);
  });

  it('turns engine needs into clarifying questions, engine-decided not model-decided', () => {
    const incomplete = buildTripState({
      options: [{ ...S2_NONSTOP, id: 'NO-PRICE', comparableCashTicketTotal: null }],
      constraints: [deadline('2026-11-04T18:00', 'America/New_York')],
    });
    const result = decide(incomplete);
    expect(result.status).toBe('missing_required');
    if (result.status !== 'missing_required') return;

    const questions = needsToQuestions(result.needs);
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.join(' ')).toContain('NO-PRICE');
  });

  it('a contradiction in the ledger blocks a recommendation regardless of AI involvement', () => {
    const contradictory = buildTripState({
      options: [S2_NONSTOP],
      constraints: [
        deadline('2026-11-04T18:00', 'America/New_York'),
        { ...deadline('2026-11-04T11:00', 'America/New_York'), source: 'inferred' },
      ],
    });
    const result = decide(contradictory);
    expect(result.status).toBe('contradiction');
    if (result.status !== 'contradiction') return;
    expect(result.conflicts[0]!.values).toHaveLength(2);
  });
});
