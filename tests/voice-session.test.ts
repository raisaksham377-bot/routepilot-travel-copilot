import { describe, expect, it } from 'vitest';
import {
  canStartListening,
  initialVoiceState,
  isListening,
  typingAvailable,
  VOICE_PHASE_LABELS,
  voiceReducer,
  type VoiceAction,
  type VoiceState,
} from '@/lib/voice/voiceSession';
import {
  DEFAULT_SPEECH_LANGUAGE,
  isSpeechRecognitionSupported,
  mapSpeechError,
  resolveSpeechRecognition,
  SPEECH_ACCURACY_CAVEAT,
  SPEECH_ERROR_MESSAGES,
  SPEECH_LANGUAGES,
  speechLanguageLabel,
  speechLanguageNote,
  startSpeechSession,
  type SpeechErrorKind,
} from '@/lib/voice/speechRecognition';
import { FakeSpeechRecognition, fakeSpeechCtor } from './helpers/fakeSpeechRecognition';

/** Pure-logic coverage for voice input. No DOM, no microphone, no network. */

function run(actions: VoiceAction[], from = initialVoiceState(true)): VoiceState {
  return actions.reduce(voiceReducer, from);
}

describe('feature detection', () => {
  it('finds the standard name', () => {
    expect(resolveSpeechRecognition({ SpeechRecognition: function () {} })).toBeTypeOf('function');
  });

  it('finds the webkit-prefixed name, which is what Chrome and Edge expose', () => {
    expect(resolveSpeechRecognition({ webkitSpeechRecognition: function () {} })).toBeTypeOf(
      'function',
    );
  });

  it('prefers the standard name when both exist', () => {
    const std = function std() {};
    const prefixed = function prefixed() {};
    expect(resolveSpeechRecognition({ SpeechRecognition: std, webkitSpeechRecognition: prefixed })).toBe(
      std,
    );
  });

  it('reports unsupported for a browser without either (Firefox, Safari PWA)', () => {
    expect(resolveSpeechRecognition({})).toBeNull();
    expect(isSpeechRecognitionSupported({})).toBe(false);
  });

  it('survives being called with no window at all (server render)', () => {
    expect(resolveSpeechRecognition(undefined)).toBeNull();
    expect(isSpeechRecognitionSupported(undefined)).toBe(false);
  });

  it('ignores a non-function value sitting on the property', () => {
    expect(resolveSpeechRecognition({ SpeechRecognition: 'not a constructor' })).toBeNull();
  });
});

describe('error code mapping', () => {
  it.each([
    ['not-allowed', 'permission_denied'],
    ['service-not-allowed', 'permission_denied'],
    ['audio-capture', 'no_microphone'],
    ['no-speech', 'no_speech'],
    ['network', 'network'],
    ['aborted', 'aborted'],
    ['something-new-from-a-future-spec', 'unknown'],
  ] as const)('%s maps to %s', (code, kind) => {
    expect(mapSpeechError(code)).toBe(kind);
  });

  it('every kind has a message that keeps typing available', () => {
    const kinds: SpeechErrorKind[] = [
      'permission_denied',
      'no_microphone',
      'no_speech',
      'network',
      'aborted',
      'unknown',
    ];
    for (const kind of kinds) {
      const message = SPEECH_ERROR_MESSAGES[kind];
      expect(message.length).toBeGreaterThan(20);
      // Each must either point at typing or state nothing was lost.
      expect(message.toLowerCase()).toMatch(/type|unchanged/);
    }
  });

  it('no message implies anything was recorded or kept', () => {
    for (const message of Object.values(SPEECH_ERROR_MESSAGES)) {
      expect(message.toLowerCase()).not.toMatch(/saved|uploaded|stored/);
    }
  });
});

describe('the unsupported state is terminal', () => {
  it('starts unsupported when detection fails', () => {
    expect(initialVoiceState(false).phase).toBe('unsupported');
  });

  it('no action can move it out of unsupported', () => {
    const start = initialVoiceState(false);
    const everyAction: VoiceAction[] = [
      { type: 'listening_started' },
      { type: 'interim_transcript', text: 'hello' },
      { type: 'final_transcript' },
      { type: 'recognition_error', kind: 'permission_denied' },
      { type: 'recognition_ended' },
      { type: 'user_stopped' },
      { type: 'dismiss_error' },
    ];
    for (const action of everyAction) {
      expect(voiceReducer(start, action), `${action.type} must not change it`).toEqual(start);
    }
  });

  it('typing is still available when unsupported', () => {
    expect(typingAvailable(initialVoiceState(false))).toBe(true);
    expect(canStartListening(initialVoiceState(false))).toBe(false);
  });
});

describe('the listening lifecycle', () => {
  it('idle to listening to stopped, once a phrase completes', () => {
    let state = run([{ type: 'listening_started' }]);
    expect(isListening(state)).toBe(true);

    state = voiceReducer(state, { type: 'interim_transcript', text: 'New York by' });
    expect(state.interim).toBe('New York by');
    expect(state.producedFinalText).toBe(false);

    state = voiceReducer(state, { type: 'final_transcript' });
    // Interim is cleared once committed, so it cannot be shown twice.
    expect(state.interim).toBe('');
    expect(state.producedFinalText).toBe(true);

    state = voiceReducer(state, { type: 'recognition_ended' });
    expect(state.phase).toBe('stopped');
  });

  it('a session that produced nothing returns to idle, not stopped', () => {
    const state = run([{ type: 'listening_started' }, { type: 'recognition_ended' }]);
    expect(state.phase).toBe('idle');
    expect(state.producedFinalText).toBe(false);
  });

  it('interim text is never treated as committed', () => {
    const state = run([
      { type: 'listening_started' },
      { type: 'interim_transcript', text: 'half a sentence' },
      { type: 'recognition_ended' },
    ]);
    // Ended without a final segment: interim discarded, nothing produced.
    expect(state.interim).toBe('');
    expect(state.producedFinalText).toBe(false);
    expect(state.phase).toBe('idle');
  });

  it('the user stopping mid-phrase discards the interim', () => {
    const state = run([
      { type: 'listening_started' },
      { type: 'interim_transcript', text: 'partial' },
      { type: 'user_stopped' },
    ]);
    expect(state.interim).toBe('');
    expect(state.phase).toBe('idle');
  });
});

describe('error handling', () => {
  it.each([
    'permission_denied',
    'no_microphone',
    'no_speech',
    'network',
    'unknown',
  ] as SpeechErrorKind[])('%s moves to error with a message', (kind) => {
    const state = run([{ type: 'listening_started' }, { type: 'recognition_error', kind }]);
    expect(state.phase).toBe('error');
    expect(state.error).toEqual({ kind, message: SPEECH_ERROR_MESSAGES[kind] });
    expect(state.interim).toBe('');
    // Recoverable: the user can try again.
    expect(canStartListening(state)).toBe(true);
    expect(typingAvailable(state)).toBe(true);
  });

  /**
   * Chrome fires 'aborted' on a normal stop() in some versions. Reporting a
   * failure after a SUCCESSFUL capture would be actively misleading, so it is
   * treated as a clean stop when a phrase already landed.
   */
  it('aborted after a successful phrase is a clean stop, not an error', () => {
    const state = run([
      { type: 'listening_started' },
      { type: 'final_transcript' },
      { type: 'recognition_error', kind: 'aborted' },
    ]);
    expect(state.phase).toBe('stopped');
    expect(state.error).toBeNull();
  });

  it('aborted with nothing captured IS surfaced', () => {
    const state = run([{ type: 'listening_started' }, { type: 'recognition_error', kind: 'aborted' }]);
    expect(state.phase).toBe('error');
    expect(state.error?.kind).toBe('aborted');
  });

  it('a later recognition_ended does not clobber the error', () => {
    const state = run([
      { type: 'listening_started' },
      { type: 'recognition_error', kind: 'permission_denied' },
      { type: 'recognition_ended' },
    ]);
    expect(state.phase).toBe('error');
    expect(state.error?.kind).toBe('permission_denied');
  });

  it('dismissing returns to idle and clears the error', () => {
    const state = run([
      { type: 'listening_started' },
      { type: 'recognition_error', kind: 'network' },
      { type: 'dismiss_error' },
    ]);
    expect(state.phase).toBe('idle');
    expect(state.error).toBeNull();
  });
});

describe('typing is available in every single voice state', () => {
  it('holds for all five phases', () => {
    const states: VoiceState[] = [
      initialVoiceState(false),
      initialVoiceState(true),
      run([{ type: 'listening_started' }]),
      run([{ type: 'listening_started' }, { type: 'final_transcript' }, { type: 'recognition_ended' }]),
      run([{ type: 'listening_started' }, { type: 'recognition_error', kind: 'permission_denied' }]),
    ];
    const phases = states.map((s) => s.phase);
    expect(new Set(phases).size).toBe(5); // all five distinct phases covered
    for (const s of states) expect(typingAvailable(s)).toBe(true);
  });

  it('every phase has a label', () => {
    for (const phase of ['unsupported', 'idle', 'listening', 'stopped', 'error'] as const) {
      expect(VOICE_PHASE_LABELS[phase].length).toBeGreaterThan(5);
    }
  });
});

describe('recognition language', () => {
  it('offers at least the three required languages', () => {
    const codes = SPEECH_LANGUAGES.map((l) => l.code);
    expect(codes).toContain('en-GB');
    expect(codes).toContain('en-IN');
    expect(codes).toContain('hi-IN');
  });

  it('defaults to English (UK)', () => {
    expect(DEFAULT_SPEECH_LANGUAGE).toBe('en-GB');
    expect(initialVoiceState(true).language).toBe('en-GB');
  });

  it('every language has a human label and an accuracy note', () => {
    for (const l of SPEECH_LANGUAGES) {
      expect(speechLanguageLabel(l.code).length).toBeGreaterThan(3);
      expect(speechLanguageNote(l.code).length).toBeGreaterThan(10);
    }
    expect(speechLanguageLabel('hi-IN')).toMatch(/Hindi/);
  });

  it('changing language updates only the language', () => {
    const before = run([
      { type: 'listening_started' },
      { type: 'interim_transcript', text: 'partial words' },
    ]);
    const after = voiceReducer(before, { type: 'language_changed', language: 'hi-IN' });

    expect(after.language).toBe('hi-IN');
    // Nothing else moves.
    expect(after.phase).toBe(before.phase);
    expect(after.interim).toBe(before.interim);
    expect(after.error).toBe(before.error);
    expect(after.producedFinalText).toBe(before.producedFinalText);
  });

  it('works even in an unsupported browser, so the control is not mysteriously dead', () => {
    const state = voiceReducer(initialVoiceState(false), {
      type: 'language_changed',
      language: 'en-IN',
    });
    expect(state.language).toBe('en-IN');
    expect(state.phase).toBe('unsupported');
  });

  it('survives an error state without clearing the error', () => {
    const state = run([
      { type: 'listening_started' },
      { type: 'recognition_error', kind: 'permission_denied' },
      { type: 'language_changed', language: 'hi-IN' },
    ]);
    expect(state.language).toBe('hi-IN');
    expect(state.error?.kind).toBe('permission_denied');
  });

  it.each(['en-GB', 'en-IN', 'hi-IN'] as const)(
    'the adapter passes %s through to the recognition instance',
    (code) => {
      FakeSpeechRecognition.reset();
      startSpeechSession(
        { onStart: () => {}, onTranscript: () => {}, onError: () => {}, onEnd: () => {} },
        fakeSpeechCtor,
        code,
      );
      expect(FakeSpeechRecognition.latest().lang).toBe(code);
    },
  );

  it('defaults the instance to en-GB when no language is given', () => {
    FakeSpeechRecognition.reset();
    startSpeechSession(
      { onStart: () => {}, onTranscript: () => {}, onError: () => {}, onEnd: () => {} },
      fakeSpeechCtor,
    );
    expect(FakeSpeechRecognition.latest().lang).toBe('en-GB');
  });
});

describe('the accuracy caveat makes no unverified promise', () => {
  it('states that accuracy varies and is the browser’s, not ours', () => {
    expect(SPEECH_ACCURACY_CAVEAT).toMatch(/accuracy varies/i);
    expect(SPEECH_ACCURACY_CAVEAT).toMatch(/performed by your browser/i);
    expect(SPEECH_ACCURACY_CAVEAT).toMatch(/not.*measured/i);
  });

  /**
   * Hindi-English code-switching ("Hinglish") is common in Indian travel
   * conversation and is advertised by some commercial assistants. It has NOT
   * been verified here, and the Web Speech API takes one language per session,
   * so the copy must say so rather than stay silent and let a user assume.
   */
  it('explicitly does NOT promise Hindi-English code-switching', () => {
    expect(SPEECH_ACCURACY_CAVEAT).toMatch(/one language is recognised per recording/i);
    expect(SPEECH_ACCURACY_CAVEAT).toMatch(/mixing hindi and english.*not supported/i);
    expect(SPEECH_ACCURACY_CAVEAT).toMatch(/not been tested/i);
  });

  it('claims no reliability anywhere in the language copy', () => {
    const allCopy = [
      SPEECH_ACCURACY_CAVEAT,
      ...SPEECH_LANGUAGES.map((l) => l.accuracyNote),
    ].join(' ');
    for (const forbidden of [
      /\baccurate\b/i,
      /\breliable\b/i,
      /\bseamless/i,
      /\bflawless/i,
      /\bworks perfectly/i,
      /\bfully supports\b/i,
    ]) {
      expect(allCopy, `must not promise: ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('tells the user to check the transcript', () => {
    expect(SPEECH_ACCURACY_CAVEAT).toMatch(/read the transcript/i);
    expect(SPEECH_ACCURACY_CAVEAT).toMatch(/airport codes.*misheard/i);
  });
});

describe('the adapter wires the browser API correctly', () => {
  it('returns null and starts nothing when unsupported', () => {
    FakeSpeechRecognition.reset();
    const session = startSpeechSession(
      { onStart: () => {}, onTranscript: () => {}, onError: () => {}, onEnd: () => {} },
      null,
    );
    expect(session).toBeNull();
    expect(FakeSpeechRecognition.instances).toHaveLength(0);
  });

  it('configures a single, non-continuous session', () => {
    FakeSpeechRecognition.reset();
    startSpeechSession(
      { onStart: () => {}, onTranscript: () => {}, onError: () => {}, onEnd: () => {} },
      fakeSpeechCtor,
    );
    const r = FakeSpeechRecognition.latest();
    // Non-continuous is deliberate: a continuous session is the first step
    // towards an always-listening agent, which is out of scope.
    expect(r.continuous).toBe(false);
    expect(r.interimResults).toBe(true);
    expect(r.started).toBe(true);
  });

  it('forwards interim and final transcripts with the right flag', () => {
    FakeSpeechRecognition.reset();
    const seen: Array<[string, boolean]> = [];
    startSpeechSession(
      {
        onStart: () => {},
        onTranscript: (t, f) => seen.push([t, f]),
        onError: () => {},
        onEnd: () => {},
      },
      fakeSpeechCtor,
    );
    const r = FakeSpeechRecognition.latest();
    r.emitInterim('New York by');
    r.emitFinal('New York by Wednesday');
    expect(seen).toEqual([
      ['New York by', false],
      ['New York by Wednesday', true],
    ]);
  });

  it('maps a raw error code before handing it on', () => {
    FakeSpeechRecognition.reset();
    const kinds: SpeechErrorKind[] = [];
    startSpeechSession(
      {
        onStart: () => {},
        onTranscript: () => {},
        onError: (k) => kinds.push(k),
        onEnd: () => {},
      },
      fakeSpeechCtor,
    );
    FakeSpeechRecognition.latest().emitError('not-allowed');
    expect(kinds).toEqual(['permission_denied']);
  });

  it('exposes stop and abort, and reports the end of the session', () => {
    FakeSpeechRecognition.reset();
    let ended = 0;
    const session = startSpeechSession(
      { onStart: () => {}, onTranscript: () => {}, onError: () => {}, onEnd: () => (ended += 1) },
      fakeSpeechCtor,
    );
    session?.stop();
    session?.abort();
    const r = FakeSpeechRecognition.latest();
    expect(r.stopCalls).toBe(1);
    expect(r.abortCalls).toBe(1);
    r.emitEnd();
    expect(ended).toBe(1);
  });
});
