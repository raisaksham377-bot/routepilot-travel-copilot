import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT, buildUserMessage } from '@/lib/ai/anthropicCaller';
import { interpretUtterance, type ModelCaller } from '@/lib/ai/interpret';
import { getAiConfig, type EnvSource } from '@/lib/ai/config';
import { buildInterpretPayload, findDisallowedKeys } from '@/lib/ai/payload';
import { redactForModel } from '@/lib/ai/redact';
import type { ConstraintPatch } from '@/lib/ai/constraintPatch';
import { applyProposedConstraint } from '@/lib/ai/applyProposal';
import { buildTripState } from '@/lib/data/build';
import { S2_NONSTOP } from '@/lib/data/scenarios';
import type { Constraint } from '@/lib/schema/constraint';

/**
 * Multilingual constraint extraction.
 *
 * WHAT THESE TESTS PROVE: the prompt carries the right instructions; a
 * Devanagari, Hinglish or mixed-script utterance reaches the model
 * byte-for-byte unaltered; a well-formed patch converts correctly whatever the
 * input language was; and the no-invention and confirmation safeguards hold
 * identically across languages.
 *
 * WHAT THEY DO NOT PROVE: that a live model actually reads Hindi or Hinglish
 * well. Every model response here is a fixture. No claim about live
 * multilingual accuracy can be made from any of this, and none is made.
 */

const enabled = () =>
  getAiConfig({ AI_FEATURES_ENABLED: 'true', ANTHROPIC_API_KEY: 'placeholder' } as EnvSource);

const ENGLISH = 'I need to be in New York by midday on 4 November, business class from London.';
const HINDI = 'मुझे 4 नवंबर को दोपहर 12 बजे तक न्यूयॉर्क पहुंचना है, बिजनेस क्लास, लंदन से।';
const HINGLISH = 'mujhe 4 November ko dopahar 12 baje tak New York pahunchna hai, business class, London se';
const MIXED = 'Need to reach न्यूयॉर्क by 12:00 on 2026-11-04, business class';

function callerCapturing(raw: unknown): { caller: ModelCaller; seen: () => string } {
  let captured = '';
  const caller: ModelCaller = async (req) => {
    captured = req.payload.utterance;
    return { ok: true, raw };
  };
  return { caller, seen: () => captured };
}

/** A well-formed patch whose evidence quotes the original script. */
function patchQuoting(evidence: string): ConstraintPatch {
  return {
    proposals: [
      {
        key: 'arrival_deadline',
        rawValue: '2026-11-04T12:00',
        timezone: 'America/New_York',
        suggestedKind: 'hard',
        confidence: 0.9,
        evidence,
      },
      {
        key: 'cabin_floor',
        rawValue: 'business',
        timezone: null,
        suggestedKind: 'soft',
        confidence: 0.8,
        evidence,
      },
    ],
    clarifyingQuestions: [],
    unmapped: [],
  };
}

describe('the prompt instructs multilingual reading', () => {
  it('names English, Hindi in Devanagari, and Hinglish explicitly', () => {
    expect(SYSTEM_PROMPT).toMatch(/English/);
    expect(SYSTEM_PROMPT).toMatch(/Devanagari/);
    expect(SYSTEM_PROMPT).toMatch(/Hinglish/);
    expect(SYSTEM_PROMPT).toMatch(/mixture of scripts/i);
  });

  it('carries a real Devanagari example, not just the word "Hindi"', () => {
    // Devanagari block U+0900-U+097F must actually appear in the prompt.
    expect(SYSTEM_PROMPT).toMatch(/[ऀ-ॿ]/);
    expect(SYSTEM_PROMPT).toContain('न्यूयॉर्क');
  });

  it('forbids translation, transliteration and rewriting', () => {
    expect(SYSTEM_PROMPT).toMatch(/Do NOT translate, transliterate, summarise or rewrite/);
    expect(SYSTEM_PROMPT).toMatch(/ORIGINAL script/);
    expect(SYSTEM_PROMPT).toMatch(/Do not render Devanagari into Latin letters/);
  });

  it('still requires normalised machine values regardless of input language', () => {
    expect(SYSTEM_PROMPT).toMatch(/three uppercase Latin letters/);
    expect(SYSTEM_PROMPT).toMatch(/IANA identifiers/);
    expect(SYSTEM_PROMPT).toMatch(/YYYY-MM-DDTHH:MM/);
  });

  /**
   * The substantive multilingual hazard. "kal" means tomorrow AND yesterday;
   * "parso" means the day after tomorrow AND the day before yesterday. A model
   * that resolves either has invented a date a human will approve without
   * noticing it was guessed.
   */
  it('names the genuinely ambiguous Hindi relative-day words', () => {
    expect(SYSTEM_PROMPT).toMatch(/"kal" \/ "कल" means both tomorrow AND yesterday/);
    expect(SYSTEM_PROMPT).toMatch(/"parso" \/ "परसों"/);
    expect(SYSTEM_PROMPT).toMatch(/Never resolve it to a date/);
  });

  it('names part-of-day words as not giving a clock time', () => {
    for (const word of ['subah', 'dopahar', 'shaam', 'raat']) {
      expect(SYSTEM_PROMPT).toContain(word);
    }
    expect(SYSTEM_PROMPT).toMatch(/part of the day, not a clock time/);
  });

  it('keeps the no-invention rule, and says why a guess is worse than a gap', () => {
    expect(SYSTEM_PROMPT).toMatch(/Leave a value out rather than guessing it/);
    expect(SYSTEM_PROMPT).toMatch(/Absent means absent/);
    expect(SYSTEM_PROMPT).toMatch(/worse than an admitted gap/);
  });

  it('still frames the output as a proposal, not a decision', () => {
    expect(SYSTEM_PROMPT).toMatch(/You are proposing, not deciding/);
    expect(SYSTEM_PROMPT).toMatch(/A human reviews everything you return/);
  });
});

describe('the utterance reaches the model unchanged, in every script', () => {
  it.each([
    ['English', ENGLISH],
    ['Hindi (Devanagari)', HINDI],
    ['Hinglish', HINGLISH],
    ['mixed script', MIXED],
  ])('%s is passed through byte-for-byte', async (_label, utterance) => {
    const { caller, seen } = callerCapturing(patchQuoting(utterance));
    await interpretUtterance({ utterance, constraints: [], config: enabled() }, caller);
    expect(seen()).toBe(utterance);
  });

  it('redaction leaves Devanagari and Hinglish untouched', () => {
    for (const text of [HINDI, HINGLISH, MIXED]) {
      const result = redactForModel(text);
      expect(result.text).toBe(text);
      expect(result.removed).toEqual([]);
    }
  });

  it('redaction still strips an email from a Hindi sentence', () => {
    const withEmail = `${HINDI} ceo@example.com`;
    const result = redactForModel(withEmail);
    expect(result.text).not.toContain('ceo@example.com');
    // ...without disturbing the Devanagari around it.
    expect(result.text).toContain('न्यूयॉर्क');
    expect(result.removed).toContain('email address');
  });

  it('the user message interpolates the utterance verbatim', () => {
    for (const utterance of [HINDI, HINGLISH, MIXED]) {
      const payload = buildInterpretPayload({ redactedUtterance: utterance, constraints: [] });
      const message = buildUserMessage({
        payload,
        model: 'test-model',
        maxOutputTokens: 100,
        effort: 'low',
        timeoutMs: 1000,
      });
      expect(message).toContain(utterance);
    }
  });

  it('a non-Latin utterance does not widen the payload', () => {
    const payload = buildInterpretPayload({ redactedUtterance: HINDI, constraints: [] });
    expect(findDisallowedKeys(payload)).toEqual([]);
    expect(Object.keys(payload).sort()).toEqual(['constraintContext', 'utterance']);
  });
});

describe('conversion works identically whatever the input language was', () => {
  it.each([
    ['English', ENGLISH],
    ['Hindi (Devanagari)', HINDI],
    ['Hinglish', HINGLISH],
  ])('%s yields the same normalised constraints', async (_label, utterance) => {
    const { caller } = callerCapturing(patchQuoting(utterance));
    const result = await interpretUtterance(
      { utterance, constraints: [], config: enabled() },
      caller,
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.patch.accepted).toHaveLength(2);
    const deadline = result.patch.accepted.find((a) => a.constraint.key === 'arrival_deadline')!;
    expect(deadline.constraint.value).toEqual({
      localDateTime: '2026-11-04T12:00',
      tz: 'America/New_York',
    });
    const cabin = result.patch.accepted.find((a) => a.constraint.key === 'cabin_floor')!;
    expect(cabin.constraint.value).toBe('business');

    // The safeguards are language-independent.
    for (const a of result.patch.accepted) {
      expect(a.constraint.kind).toBe('soft');
      expect(a.constraint.source).toBe('inferred');
    }
  });

  it('evidence quoting the original script survives conversion intact', async () => {
    const { caller } = callerCapturing(patchQuoting(HINDI));
    const result = await interpretUtterance(
      { utterance: HINDI, constraints: [], config: enabled() },
      caller,
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    for (const a of result.patch.accepted) {
      expect(a.evidence).toBe(HINDI);
      expect(a.evidence).toMatch(/[ऀ-ॿ]/);
    }
    // And it is carried into the constraint's note, so the ledger can show it.
    expect(result.patch.accepted[0]!.constraint.note).toBe(HINDI);
  });
});

describe('the model cannot invent what was not said, in any language', () => {
  it('a deadline with no timezone is REJECTED, not defaulted', async () => {
    // "dopahar 12 baje" gives a time but names no zone.
    const patch: ConstraintPatch = {
      proposals: [
        {
          key: 'arrival_deadline',
          rawValue: '2026-11-04T12:00',
          timezone: null,
          suggestedKind: 'hard',
          confidence: 0.8,
          evidence: 'dopahar 12 baje tak',
        },
      ],
      clarifyingQuestions: ['Which timezone is midday in — London or New York?'],
      unmapped: [],
    };
    const { caller } = callerCapturing(patch);
    const result = await interpretUtterance(
      { utterance: HINGLISH, constraints: [], config: enabled() },
      caller,
    );
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(result.patch.accepted).toHaveLength(0);
    expect(result.patch.rejected).toHaveLength(1);
    expect(result.patch.rejected[0]!.reason).toMatch(/timezone/i);
    expect(result.patch.rejected[0]!.reason).toMatch(/will not assume/i);
    expect(result.patch.clarifyingQuestions).toHaveLength(1);
  });

  it('an ambiguous relative day produces a question and NO date', async () => {
    // "kal" -- tomorrow or yesterday. A compliant model proposes nothing.
    const patch: ConstraintPatch = {
      proposals: [],
      clarifyingQuestions: [
        '"kal" can mean tomorrow or yesterday — which date do you mean?',
        'Which timezone should the deadline be read in?',
      ],
      unmapped: [],
    };
    const { caller } = callerCapturing(patch);
    const result = await interpretUtterance(
      { utterance: 'mujhe kal New York pahunchna hai', constraints: [], config: enabled() },
      caller,
    );
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(result.patch.accepted).toHaveLength(0);
    expect(result.patch.rejected).toHaveLength(0);
    expect(result.patch.clarifyingQuestions).toHaveLength(2);
  });

  it('a malformed Devanagari date string is rejected rather than coerced', async () => {
    const patch: ConstraintPatch = {
      proposals: [
        {
          key: 'arrival_deadline',
          // Devanagari numerals -- not the required machine format.
          rawValue: '२०२६-११-०४T१२:००',
          timezone: 'Asia/Kolkata',
          suggestedKind: 'hard',
          confidence: 0.7,
          evidence: HINDI,
        },
      ],
      clarifyingQuestions: [],
      unmapped: [],
    };
    const { caller } = callerCapturing(patch);
    const result = await interpretUtterance(
      { utterance: HINDI, constraints: [], config: enabled() },
      caller,
    );
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(result.patch.accepted).toHaveLength(0);
    expect(result.patch.rejected).toHaveLength(1);
    expect(result.patch.rejected[0]!.key).toBe('arrival_deadline');
  });

  it('a cabin name given in Hindi is rejected unless normalised', async () => {
    const patch: ConstraintPatch = {
      proposals: [
        {
          key: 'cabin_floor',
          rawValue: 'बिजनेस क्लास',
          timezone: null,
          suggestedKind: 'soft',
          confidence: 0.6,
          evidence: HINDI,
        },
      ],
      clarifyingQuestions: [],
      unmapped: [],
    };
    const { caller } = callerCapturing(patch);
    const result = await interpretUtterance(
      { utterance: HINDI, constraints: [], config: enabled() },
      caller,
    );
    if (result.status !== 'ok') throw new Error('expected ok');

    // The engine only accepts its own enum. An un-normalised value is named
    // and refused, not silently mapped by guesswork.
    expect(result.patch.accepted).toHaveLength(0);
    expect(result.patch.rejected[0]!.reason).toMatch(/not a cabin this engine knows/);
  });

  it('an airport name in Devanagari is rejected unless given as a code', async () => {
    const patch: ConstraintPatch = {
      proposals: [
        {
          key: 'destination',
          rawValue: 'न्यूयॉर्क',
          timezone: null,
          suggestedKind: 'soft',
          confidence: 0.5,
          evidence: HINDI,
        },
      ],
      clarifyingQuestions: [],
      unmapped: [],
    };
    const { caller } = callerCapturing(patch);
    const result = await interpretUtterance(
      { utterance: HINDI, constraints: [], config: enabled() },
      caller,
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.patch.accepted).toHaveLength(0);
    expect(result.patch.rejected[0]!.reason).toMatch(/3-letter airport code/);
  });
});

describe('confirmation and conflict safeguards are unchanged across languages', () => {
  it('a Hindi-sourced proposal still requires explicit confirmation', async () => {
    const { caller } = callerCapturing(patchQuoting(HINDI));
    const state = buildTripState({ options: [S2_NONSTOP], constraints: [] });
    const before = JSON.stringify(state.constraints);

    const result = await interpretUtterance(
      { utterance: HINDI, constraints: state.constraints, config: enabled() },
      caller,
    );
    if (result.status !== 'ok') throw new Error('expected ok');

    // Interpreting changed nothing.
    expect(JSON.stringify(state.constraints)).toBe(before);

    // Applying is a separate, explicit act -- and transfers ownership.
    const outcome = applyProposedConstraint(
      state,
      result.patch.accepted[0]!.constraint,
      'hard',
    );
    expect(outcome.outcome).toBe('applied');
    if (outcome.outcome !== 'applied') return;
    expect(outcome.state.constraints[0]!.source).toBe('user-edited');
  });

  it('a Hindi-sourced proposal still CONFLICTS with a human-authored value', async () => {
    const stated: Constraint = {
      key: 'arrival_deadline',
      value: { localDateTime: '2026-11-04T09:00', tz: 'America/New_York' },
      kind: 'hard',
      source: 'stated',
    };
    const state = buildTripState({ options: [S2_NONSTOP], constraints: [stated] });

    const { caller } = callerCapturing(patchQuoting(HINDI));
    const result = await interpretUtterance(
      { utterance: HINDI, constraints: state.constraints, config: enabled() },
      caller,
    );
    if (result.status !== 'ok') throw new Error('expected ok');

    const proposed = result.patch.accepted.find((a) => a.constraint.key === 'arrival_deadline')!;
    const outcome = applyProposedConstraint(state, proposed.constraint, 'hard');

    expect(outcome.outcome).toBe('conflict');
    if (outcome.outcome !== 'conflict') return;
    expect(outcome.message).toContain('2026-11-04T09:00');
    expect(outcome.message).toContain('2026-11-04T12:00');
    expect(outcome).not.toHaveProperty('state');
  });

  it('a malformed model response is still malformed, whatever the utterance', async () => {
    const { caller } = callerCapturing({ proposals: 'not-an-array' });
    const result = await interpretUtterance(
      { utterance: HINDI, constraints: [], config: enabled() },
      caller,
    );
    expect(result.status).toBe('model_failed');
    if (result.status === 'model_failed') expect(result.kind).toBe('malformed_output');
  });
});
