import { describe, expect, it, vi } from 'vitest';
import { getAiConfig, aiAvailability, type EnvSource } from '@/lib/ai/config';
import {
  interpretUtterance,
  type ModelCaller,
  type ModelFailureKind,
} from '@/lib/ai/interpret';
import { ALLOWED_PAYLOAD_KEYS, findDisallowedKeys } from '@/lib/ai/payload';
import type { Constraint } from '@/lib/schema/constraint';
import type { ConstraintPatch } from '@/lib/ai/constraintPatch';

/**
 * Every branch of the AI path, exercised with NO API key and NO network.
 *
 * The injectable ModelCaller is what makes this possible. Testing refusal,
 * timeout and malformed output against a live model would be slow, costly and
 * largely impossible to trigger on demand -- so in practice those branches
 * would go uncovered, which is exactly where the bad failures live.
 */

const ENABLED_ENV = {
  AI_FEATURES_ENABLED: 'true',
  ANTHROPIC_API_KEY: 'test-placeholder-not-a-real-key',
} satisfies EnvSource;

const enabledConfig = () => getAiConfig(ENABLED_ENV);

const EXISTING_CONSTRAINTS: Constraint[] = [
  {
    key: 'arrival_deadline',
    value: { localDateTime: '2026-11-04T18:00', tz: 'America/New_York' },
    kind: 'hard',
    source: 'stated',
  },
  { key: 'budget_ceiling', value: 1500, kind: 'soft', source: 'profile' },
];

const goodPatch: ConstraintPatch = {
  proposals: [
    {
      key: 'cabin_floor',
      rawValue: 'business',
      timezone: null,
      suggestedKind: 'hard',
      confidence: 0.9,
      evidence: 'needs to work on the flight',
    },
  ],
  clarifyingQuestions: [],
  unmapped: [],
};

const callerReturning = (raw: unknown): ModelCaller => async () => ({ ok: true, raw });
const callerFailing = (kind: ModelFailureKind): ModelCaller => async () => ({
  ok: false,
  kind,
  detail: 'test',
});

describe('gating', () => {
  it('refuses when AI_FEATURES_ENABLED is not exactly "true"', async () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      const config = getAiConfig({ ...ENABLED_ENV, AI_FEATURES_ENABLED: value } as EnvSource);
      const caller = vi.fn<ModelCaller>();
      const result = await interpretUtterance(
        { utterance: 'fly me to New York', constraints: [], config },
        caller,
      );
      expect(result.status).toBe('unavailable');
      if (result.status === 'unavailable') expect(result.reason).toBe('feature_disabled');
      // The decisive assertion: the model is never called when gated off.
      expect(caller).not.toHaveBeenCalled();
    }
  });

  it('refuses when enabled but no credential is configured', async () => {
    const config = getAiConfig({ AI_FEATURES_ENABLED: 'true' } as EnvSource);
    const caller = vi.fn<ModelCaller>();
    const result = await interpretUtterance(
      { utterance: 'fly me to New York', constraints: [], config },
      caller,
    );
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.reason).toBe('no_credentials');
    expect(caller).not.toHaveBeenCalled();
  });

  it('recognises an auth token as a credential, not only an API key', () => {
    const config = getAiConfig({
      AI_FEATURES_ENABLED: 'true',
      ANTHROPIC_AUTH_TOKEN: 'placeholder',
    } as EnvSource);
    expect(config.hasCredentials).toBe(true);
    expect(aiAvailability(config).available).toBe(true);
  });
});

describe('input validation happens before any model call', () => {
  it('rejects empty input without calling the model', async () => {
    const caller = vi.fn<ModelCaller>();
    const result = await interpretUtterance(
      { utterance: '   ', constraints: [], config: enabledConfig() },
      caller,
    );
    expect(result.status).toBe('input_rejected');
    expect(caller).not.toHaveBeenCalled();
  });

  it('rejects oversized input without calling the model', async () => {
    const caller = vi.fn<ModelCaller>();
    const config = getAiConfig({ ...ENABLED_ENV, AI_MAX_INPUT_CHARS: '50' } as EnvSource);
    const result = await interpretUtterance(
      { utterance: 'x'.repeat(200), constraints: [], config },
      caller,
    );
    expect(result.status).toBe('input_rejected');
    if (result.status === 'input_rejected') expect(result.reason).toBe('too_long');
    expect(caller).not.toHaveBeenCalled();
  });
});

describe('the outbound payload', () => {
  it('carries only the utterance and constraint keys/kinds', async () => {
    let captured: unknown = null;
    const caller: ModelCaller = async (req) => {
      captured = req.payload;
      return { ok: true, raw: goodPatch };
    };

    await interpretUtterance(
      {
        utterance: 'I need to be in New York by Wednesday lunchtime',
        constraints: EXISTING_CONSTRAINTS,
        config: enabledConfig(),
      },
      caller,
    );

    expect(captured).toEqual({
      utterance: 'I need to be in New York by Wednesday lunchtime',
      constraintContext: [
        { key: 'arrival_deadline', kind: 'hard' },
        { key: 'budget_ceiling', kind: 'soft' },
      ],
    });
  });

  it('never transmits constraint VALUES', async () => {
    let serialised = '';
    const caller: ModelCaller = async (req) => {
      serialised = JSON.stringify(req.payload);
      return { ok: true, raw: goodPatch };
    };

    await interpretUtterance(
      { utterance: 'keep it cheap', constraints: EXISTING_CONSTRAINTS, config: enabledConfig() },
      caller,
    );

    // The deadline value and the budget figure must appear nowhere.
    expect(serialised).not.toContain('2026-11-04T18:00');
    expect(serialised).not.toContain('America/New_York');
    expect(serialised).not.toContain('1500');
    expect(serialised).not.toContain('profile');
  });

  it('allowlists every key in the serialised body', async () => {
    let payload: unknown = null;
    const caller: ModelCaller = async (req) => {
      payload = req.payload;
      return { ok: true, raw: goodPatch };
    };
    await interpretUtterance(
      { utterance: 'anything', constraints: EXISTING_CONSTRAINTS, config: enabledConfig() },
      caller,
    );
    expect(findDisallowedKeys(payload)).toEqual([]);
    expect(ALLOWED_PAYLOAD_KEYS).toEqual(['utterance', 'constraintContext', 'key', 'kind']);
  });

  it('redacts an email address before transmission', async () => {
    let serialised = '';
    const caller: ModelCaller = async (req) => {
      serialised = JSON.stringify(req.payload);
      return { ok: true, raw: goodPatch };
    };
    const result = await interpretUtterance(
      {
        utterance: 'Send the brief to ceo@example.com once booked',
        constraints: [],
        config: enabledConfig(),
      },
      caller,
    );
    expect(serialised).not.toContain('ceo@example.com');
    expect(serialised).toContain('[email removed]');
    if (result.status === 'ok') expect(result.redactedCategories).toContain('email address');
  });
});

describe('model failure recovery', () => {
  const kinds: ModelFailureKind[] = [
    'refusal',
    'malformed_output',
    'timeout',
    'model_unavailable',
    'authentication_failed',
    'rate_limited',
    'transport_error',
  ];

  it.each(kinds)('%s degrades to a usable message, applying nothing', async (kind) => {
    const result = await interpretUtterance(
      { utterance: 'get me to New York', constraints: [], config: enabledConfig() },
      callerFailing(kind),
    );
    expect(result.status).toBe('model_failed');
    if (result.status !== 'model_failed') return;
    expect(result.kind).toBe(kind);
    expect(result.message.length).toBeGreaterThan(20);
    // Every failure must point the user at the path that always works.
    expect(result.message.toLowerCase()).toMatch(/form|try again/);
    expect(result).not.toHaveProperty('patch');
  });

  it('treats output that does not match our schema as malformed', async () => {
    for (const bad of [null, {}, { proposals: 'not-an-array' }, { foo: 'bar' }, 42]) {
      const result = await interpretUtterance(
        { utterance: 'get me to New York', constraints: [], config: enabledConfig() },
        callerReturning(bad),
      );
      expect(result.status).toBe('model_failed');
      if (result.status === 'model_failed') expect(result.kind).toBe('malformed_output');
    }
  });
});

describe('successful interpretation produces proposals, not decisions', () => {
  it('returns converted constraints as soft and inferred', async () => {
    const result = await interpretUtterance(
      { utterance: 'business class, I need to work onboard', constraints: [], config: enabledConfig() },
      callerReturning(goodPatch),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.patch.accepted).toHaveLength(1);
    const accepted = result.patch.accepted[0]!;
    expect(accepted.constraint.key).toBe('cabin_floor');
    expect(accepted.constraint.value).toBe('business');

    // The two invariants that make this a proposal.
    expect(accepted.constraint.kind).toBe('soft');
    expect(accepted.constraint.source).toBe('inferred');
    // The model's opinion is preserved for display but not acted on.
    expect(accepted.suggestedKind).toBe('hard');
  });

  it('never produces a hard constraint, whatever the model suggests', async () => {
    const pushy: ConstraintPatch = {
      proposals: (
        [
          ['arrival_deadline', '2026-11-04T18:00', 'America/New_York'],
          ['budget_ceiling', '1200', null],
          ['cabin_floor', 'first', null],
          ['origin', 'lhr', null],
          ['destination', 'jfk', null],
          ['min_connection_minutes', '90', null],
          ['avoid_overnight_connection', 'true', null],
        ] as const
      ).map(([key, rawValue, timezone]) => ({
        key,
        rawValue,
        timezone,
        suggestedKind: 'hard' as const,
        confidence: 1,
        evidence: 'model insists',
      })),
      clarifyingQuestions: [],
      unmapped: [],
    };

    const result = await interpretUtterance(
      { utterance: 'everything is mandatory', constraints: [], config: enabledConfig() },
      callerReturning(pushy),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.patch.accepted).toHaveLength(7);
    for (const a of result.patch.accepted) {
      expect(a.constraint.kind).toBe('soft');
      expect(a.constraint.source).toBe('inferred');
    }
  });

  it('rejects an unusable value and explains why, instead of dropping it', async () => {
    const patch: ConstraintPatch = {
      proposals: [
        {
          key: 'cabin_floor',
          rawValue: 'super-duper',
          timezone: null,
          suggestedKind: 'soft',
          confidence: 0.4,
          evidence: 'invented',
        },
        {
          key: 'arrival_deadline',
          rawValue: '2026-11-04T18:00',
          timezone: null, // missing zone
          suggestedKind: 'hard',
          confidence: 0.8,
          evidence: 'by six',
        },
        {
          key: 'origin',
          rawValue: 'LONDON',
          timezone: null,
          suggestedKind: 'soft',
          confidence: 0.5,
          evidence: 'from London',
        },
      ],
      clarifyingQuestions: [],
      unmapped: [],
    };

    const result = await interpretUtterance(
      { utterance: 'nonsense', constraints: [], config: enabledConfig() },
      callerReturning(patch),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.patch.accepted).toHaveLength(0);
    expect(result.patch.rejected).toHaveLength(3);

    const byKey = Object.fromEntries(result.patch.rejected.map((r) => [r.key, r.reason]));
    expect(byKey['cabin_floor']).toContain('not a cabin');
    expect(byKey['arrival_deadline']).toContain('timezone');
    expect(byKey['destination']).toBeUndefined();
    expect(byKey['origin']).toContain('3-letter');
  });

  it('caps clarifying questions at two', async () => {
    const patch: ConstraintPatch = {
      proposals: [],
      clarifyingQuestions: ['q1', 'q2', 'q3', 'q4'],
      unmapped: ['wants a lounge'],
    };
    const result = await interpretUtterance(
      { utterance: 'vague', constraints: [], config: enabledConfig() },
      callerReturning(patch),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.patch.clarifyingQuestions).toEqual(['q1', 'q2']);
    expect(result.patch.unmapped).toEqual(['wants a lounge']);
  });

  it('passes the configured model and caps through to the caller', async () => {
    let seen: { model: string; maxOutputTokens: number; timeoutMs: number } | null = null;
    const caller: ModelCaller = async (req) => {
      seen = {
        model: req.model,
        maxOutputTokens: req.maxOutputTokens,
        timeoutMs: req.timeoutMs,
      };
      return { ok: true, raw: goodPatch };
    };
    const config = getAiConfig({
      ...ENABLED_ENV,
      ANTHROPIC_MODEL: 'some-other-model',
      AI_MAX_OUTPUT_TOKENS: '777',
      AI_TIMEOUT_MS: '4321',
    } as EnvSource);

    await interpretUtterance({ utterance: 'go', constraints: [], config }, caller);
    expect(seen).toEqual({ model: 'some-other-model', maxOutputTokens: 777, timeoutMs: 4321 });
  });
});
