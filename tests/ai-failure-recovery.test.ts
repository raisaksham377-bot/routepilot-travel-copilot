import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canSubmit,
  deterministicPathAvailable,
  initialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionState,
} from '@/lib/ai/interpretSession';
import { interpretUtterance, type ModelCaller, type ModelFailureKind } from '@/lib/ai/interpret';
import { getAiConfig, type EnvSource } from '@/lib/ai/config';
import { decide } from '@/lib/decision';
import { discriminationState } from '@/lib/data/fixtures';

/**
 * Failure recovery.
 *
 * The question these tests answer is not "does the error message appear" but
 * "what does the user lose when the model fails". The answer must be: nothing.
 */

const TYPED = 'Needs to be in New York by midday Wednesday, business class, from London.';

function run(actions: SessionAction[], from: SessionState = initialSessionState): SessionState {
  return actions.reduce(sessionReducer, from);
}

const enabled = () =>
  getAiConfig({ AI_FEATURES_ENABLED: 'true', ANTHROPIC_API_KEY: 'placeholder' } as EnvSource);

const ALL_FAILURE_KINDS: ModelFailureKind[] = [
  'refusal',
  'malformed_output',
  'timeout',
  'model_unavailable',
  'authentication_failed',
  'rate_limited',
  'transport_error',
];

describe('the typed text survives every failure', () => {
  it.each(ALL_FAILURE_KINDS)('%s leaves the text intact', async (kind) => {
    const caller: ModelCaller = async () => ({ ok: false, kind, detail: 'test' });
    const result = await interpretUtterance(
      { utterance: TYPED, constraints: [], config: enabled() },
      caller,
    );

    const state = run([{ type: 'edit_text', text: TYPED }, { type: 'submit' }, { type: 'settle', result }]);

    expect(state.text).toBe(TYPED);
    expect(state.phase).toBe('settled');
    expect(state.result?.status).toBe('model_failed');
  });

  it('a transport failure that never returns a result still keeps the text', () => {
    const state = run([
      { type: 'edit_text', text: TYPED },
      { type: 'submit' },
      { type: 'transport_failed', message: 'could not reach endpoint' },
    ]);

    expect(state.text).toBe(TYPED);
    expect(state.transportError).toContain('could not reach');
    expect(state.result).toBeNull();
  });

  /**
   * Exhaustive rather than illustrative: every action in the union is applied
   * to a populated state, and only the one explicitly meant to clear text may
   * do so. A new action added later without thought will fail this.
   */
  it('NO action except clear_text ever empties the text', () => {
    const populated = run([{ type: 'edit_text', text: TYPED }]);

    const everyAction: SessionAction[] = [
      { type: 'submit' },
      { type: 'settle', result: { status: 'model_failed', kind: 'timeout', message: 'x' } },
      { type: 'transport_failed', message: 'x' },
      { type: 'proposal_applied', index: 0 },
      { type: 'conflict_raised', index: 0, message: 'x' },
      { type: 'conflict_resolved' },
      { type: 'edit_text', text: TYPED },
      // Added with Checkpoint B3. Enumerating every action is the point of
      // this test, so a new one must be listed here or the exhaustiveness
      // claim quietly becomes false.
      { type: 'append_transcript', text: 'dictated words' },
    ];

    for (const action of everyAction) {
      const next = sessionReducer(populated, action).text;
      // The invariant is that nothing is LOST. Most actions leave the text
      // untouched; `append_transcript` grows it, which is still not losing it.
      expect(next, `${action.type} must not clear text`).not.toBe('');
      expect(next, `${action.type} must not discard what was typed`).toContain(TYPED);
    }

    // Everything except append leaves it byte-identical.
    for (const action of everyAction.filter((a) => a.type !== 'append_transcript')) {
      expect(sessionReducer(populated, action).text, `${action.type} must not alter text`).toBe(
        TYPED,
      );
    }

    expect(sessionReducer(populated, { type: 'clear_text' }).text).toBe('');
  });

  /**
   * Regression guard for a real bug found by the DOM tests in B3.
   *
   * The component originally computed the new text in the speech handler,
   * which closed over `text`. Those handlers are registered once per
   * recognition session, so by the second phrase the closure was stale and
   * saw `text === ''` -- appending to nothing, which silently REPLACED the
   * first phrase. Computing it in the reducer reads current state, so the
   * class of bug cannot recur.
   */
  it('appends successive transcript segments instead of replacing them', () => {
    let state = run([{ type: 'append_transcript', text: 'New York by Wednesday' }]);
    expect(state.text).toBe('New York by Wednesday');

    state = sessionReducer(state, { type: 'append_transcript', text: 'business class' });
    expect(state.text).toBe('New York by Wednesday business class');

    state = sessionReducer(state, { type: 'append_transcript', text: 'from London' });
    expect(state.text).toBe('New York by Wednesday business class from London');
  });

  it('appends to text the user typed, without disturbing it', () => {
    const state = run([
      { type: 'edit_text', text: 'typed first' },
      { type: 'append_transcript', text: 'then dictated' },
    ]);
    expect(state.text).toBe('typed first then dictated');
  });

  it('an empty or whitespace-only transcript changes nothing', () => {
    const populated = run([{ type: 'edit_text', text: TYPED }]);
    for (const empty of ['', '   ', '\n\t ']) {
      expect(sessionReducer(populated, { type: 'append_transcript', text: empty })).toEqual(
        populated,
      );
    }
  });

  it('trims each segment so appending cannot produce ragged spacing', () => {
    const state = run([
      { type: 'append_transcript', text: '  New York  ' },
      { type: 'append_transcript', text: '  Wednesday  ' },
    ]);
    expect(state.text).toBe('New York Wednesday');
  });

  it('resubmitting clears stale proposals but not the text', () => {
    const state = run([
      { type: 'edit_text', text: TYPED },
      { type: 'submit' },
      { type: 'proposal_applied', index: 0 },
      { type: 'submit' },
    ]);
    expect(state.text).toBe(TYPED);
    expect(state.appliedIndices.size).toBe(0);
    expect(state.result).toBeNull();
  });
});

describe('the existing trip state survives every failure', () => {
  it.each(ALL_FAILURE_KINDS)('%s does not alter the trip state or its decision', async (kind) => {
    const before = discriminationState('arrival_buffer_first');
    const decisionBefore = JSON.stringify(decide(before).trace);

    const caller: ModelCaller = async () => ({ ok: false, kind, detail: 'test' });
    const result = await interpretUtterance(
      { utterance: TYPED, constraints: before.constraints, config: enabled() },
      caller,
    );

    expect(result.status).toBe('model_failed');
    // A failed interpretation returns no patch, so there is nothing that
    // could be applied even accidentally.
    expect(result).not.toHaveProperty('patch');

    // The engine's output is byte-identical afterwards.
    expect(JSON.stringify(decide(before).trace)).toBe(decisionBefore);
  });

  it('an unavailable feature leaves the deterministic decision untouched', async () => {
    const before = discriminationState('lowest_cash_outlay');
    const traceBefore = JSON.stringify(decide(before).trace);

    const caller: ModelCaller = async () => ({ ok: true, raw: {} });
    const result = await interpretUtterance(
      {
        utterance: TYPED,
        constraints: before.constraints,
        config: getAiConfig({} as EnvSource), // nothing configured at all
      },
      caller,
    );

    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(decide(before).trace)).toBe(traceBefore);
  });
});

describe('the deterministic path stays available in every session state', () => {
  it('is available from idle, pending, settled-ok and settled-failed', () => {
    const states: SessionState[] = [
      initialSessionState,
      run([{ type: 'edit_text', text: TYPED }, { type: 'submit' }]),
      run([
        { type: 'edit_text', text: TYPED },
        { type: 'submit' },
        { type: 'settle', result: { status: 'model_failed', kind: 'refusal', message: 'x' } },
      ]),
      run([{ type: 'transport_failed', message: 'x' }]),
    ];
    for (const s of states) {
      expect(deterministicPathAvailable(s)).toBe(true);
    }
  });

  it('a full deterministic workflow runs with no credentials configured', () => {
    // No AI involvement at all: the engine ranks, excludes and recommends.
    const state = discriminationState('arrival_buffer_first');
    const result = decide(state);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.ranked.map((r) => r.option.id)).toEqual(['A', 'C', 'B']);
    expect(result.excluded.map((e) => e.option.id)).toEqual(['D']);
    expect(result.recommendation.chosenOptionId).toBe('A');
  });
});

describe('the UI actually runs the logic these tests cover', () => {
  /**
   * Guards against the most insidious outcome of extracting logic for
   * testability: a thoroughly tested module sitting beside a component that
   * reimplements the same behaviour inline. Every assertion above would pass
   * while the shipped UI did something else entirely.
   *
   * These are source-level checks, which is admittedly crude -- but a crude
   * check on the real risk beats none.
   */
  const PROJECT_ROOT = join(import.meta.dirname, '..');
  const component = readFileSync(
    join(PROJECT_ROOT, 'app', 'components', 'NaturalLanguageInput.tsx'),
    'utf8',
  );
  const page = readFileSync(join(PROJECT_ROOT, 'app', 'page.tsx'), 'utf8');

  it('the input component drives state through sessionReducer', () => {
    expect(component).toContain('sessionReducer');
    expect(component).toContain('useReducer(sessionReducer');
  });

  it('the component holds no competing text state of its own', () => {
    // A stray useState for the text would reintroduce the untested path.
    expect(component).not.toMatch(/useState[<(][^)]*\)?\s*;?\s*\/\/\s*text/i);
    expect(component).not.toMatch(/const \[text, setText\]/);
  });

  it('the page commits proposals through applyProposedConstraint', () => {
    expect(page).toContain('applyProposedConstraint');
    // And must not hand-roll the ownership transfer inline any more.
    expect(page).not.toMatch(/source:\s*'user-edited'\s*}\s*as Constraint/);
  });

  it('the component surfaces a conflict rather than applying it', () => {
    expect(component).toContain("outcome === 'conflict'");
    expect(component).toContain('conflict_raised');
  });
});

describe('submission guard', () => {
  it('cannot submit empty or whitespace-only text', () => {
    expect(canSubmit(initialSessionState)).toBe(false);
    expect(canSubmit(run([{ type: 'edit_text', text: '    ' }]))).toBe(false);
  });

  it('cannot submit while a request is already pending', () => {
    expect(canSubmit(run([{ type: 'edit_text', text: TYPED }, { type: 'submit' }]))).toBe(false);
  });

  it('can submit once text exists and nothing is in flight', () => {
    expect(canSubmit(run([{ type: 'edit_text', text: TYPED }]))).toBe(true);
  });
});
