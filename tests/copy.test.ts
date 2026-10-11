import { describe, expect, it } from 'vitest';
import { decide } from '@/lib/decision';
import { renderBrief } from '@/lib/brief/render';
import {
  PRIORITY_RULE_EXPLANATIONS,
  PRIORITY_RULE_LABELS,
  priorityRuleSchema,
} from '@/lib/schema/tripState';
import { CONSTRAINT_LABELS } from '@/lib/schema/constraint';
import { discriminationState } from '@/lib/data/fixtures';
import { s2, s7, s8 } from '@/lib/data/scenarios';

/**
 * Vocabulary discipline.
 *
 * The engine inspects itinerary characteristics -- buffer sizes, connection
 * counts, overnight legs. It has NO historical on-time performance data, so it
 * cannot estimate any probability of arriving on time and must not imply that
 * it can. Reinstating this vocabulary would require introducing real
 * reliability data first.
 *
 * This scans the user-facing strings rather than the source files, because the
 * source legitimately discusses the forbidden words in comments explaining why
 * they are forbidden.
 */

/**
 * Matched on WORD BOUNDARIES rather than as substrings.
 *
 * A naive `includes('on time')` check flagged the legitimate label "minimum
 * connecti-on time" -- the forbidden phrase appeared inside an innocent word.
 * The rule being enforced is "makes no punctuality or probability claim", not
 * "contains this letter sequence", so the patterns have to respect word
 * boundaries or the check generates false positives and gets switched off.
 */
const FORBIDDEN: Array<{ claim: string; pattern: RegExp }> = [
  { claim: 'on-time / on time', pattern: /\bon[\s-]time\b/ },
  { claim: 'punctual', pattern: /\bpunctual/ },
  { claim: 'probability', pattern: /\bprobabilit/ },
  { claim: 'likelihood', pattern: /\blikelihood\b/ },
  { claim: 'reliable / reliability', pattern: /\breliab/ },
  { claim: 'chance of', pattern: /\bchance of\b/ },
  { claim: 'guarantee', pattern: /\bguarantee/ },
  { claim: 'will arrive', pattern: /\bwill (?:arrive|make it)\b/ },
];

function assertCleanCopy(label: string, text: string): void {
  const lower = text.toLowerCase();
  for (const { claim, pattern } of FORBIDDEN) {
    expect(pattern.test(lower), `${label} must make no "${claim}" claim`).toBe(false);
  }
}

describe('the forbidden-vocabulary check itself', () => {
  it('matches a real claim', () => {
    expect(() => assertCleanCopy('probe', 'Ranked by on-time reliability')).toThrow();
  });

  it('does not fire on an innocent word that merely contains the phrase', () => {
    expect(() => assertCleanCopy('probe', 'Minimum connection time')).not.toThrow();
  });
});

describe('priority rule names and explanations', () => {
  it('uses names that describe what is measured, not what is predicted', () => {
    expect(priorityRuleSchema.options).toEqual([
      'arrival_buffer_first',
      'fewest_connection_risks',
      'lowest_cash_outlay',
      'shortest_travel_time',
    ]);
  });

  it('withdrew the names that implied a probability estimate', () => {
    const names = priorityRuleSchema.options as readonly string[];
    expect(names).not.toContain('arrival_certainty');
    expect(names).not.toContain('reliability');
  });

  it.each(Object.entries(PRIORITY_RULE_LABELS))('label for %s is free of claims', (rule, label) => {
    assertCleanCopy(`label for ${rule}`, label);
  });

  it.each(Object.entries(PRIORITY_RULE_EXPLANATIONS))(
    'explanation for %s is free of claims',
    (rule, text) => {
      assertCleanCopy(`explanation for ${rule}`, text);
    },
  );
});

describe('constraint labels', () => {
  it.each(Object.entries(CONSTRAINT_LABELS))('label for %s is free of claims', (key, label) => {
    assertCleanCopy(`label for ${key}`, label);
  });
});

describe('rendered briefs', () => {
  const states = [
    ['discrimination/arrival_buffer_first', discriminationState('arrival_buffer_first')] as const,
    ['discrimination/fewest_connection_risks', discriminationState('fewest_connection_risks')] as const,
    ['discrimination/lowest_cash_outlay', discriminationState('lowest_cash_outlay')] as const,
    ['discrimination/shortest_travel_time', discriminationState('shortest_travel_time')] as const,
    ['S2 overnight', s2.state] as const,
    ['S7 stale', s7.state] as const,
    ['S8 no feasible option', s8.state] as const,
  ];

  it.each(states)('%s renders copy free of probability claims', (label, state) => {
    const brief = renderBrief(state, decide(state));
    assertCleanCopy(`brief for ${label}`, brief);
  });

  it('describes connection findings structurally', () => {
    const brief = renderBrief(s2.state, decide(s2.state));
    // States what the schedule does, not how likely anything is.
    expect(brief).toContain('spans the local small hours');
  });
});
