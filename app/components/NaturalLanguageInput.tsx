'use client';

import { useCallback, useReducer, useRef, useState } from 'react';
import type { Constraint } from '@/lib/schema/constraint';
import { CONSTRAINT_LABELS } from '@/lib/schema/constraint';
import type { InterpretResult } from '@/lib/ai/interpret';
import type { ApplyOutcome } from '@/lib/ai/applyProposal';
import { canSubmit, initialSessionState, sessionReducer } from '@/lib/ai/interpretSession';
import {
  isSpeechRecognitionSupported,
  SPEECH_ACCURACY_CAVEAT,
  SPEECH_LANGUAGES,
  speechLanguageNote,
  startSpeechSession,
  type SpeechLanguageCode,
  type SpeechRecognitionConstructor,
  type SpeechSession,
} from '@/lib/voice/speechRecognition';
import {
  canStartListening,
  initialVoiceState,
  isListening,
  VOICE_PHASE_LABELS,
  voiceReducer,
} from '@/lib/voice/voiceSession';

/**
 * Typed natural-language input.
 *
 * Three properties this component exists to guarantee:
 *
 *  1. Nothing is sent without an explicit button press, after an explicit
 *     disclosure. No call on mount, on keystroke, or on blur.
 *  2. Nothing reaches TripState without the user accepting it. The model
 *     returns proposals; this renders them for confirmation.
 *  3. The text survives every failure. A timeout or refusal must never lose
 *     what the user typed.
 *
 * The manual-entry form remains fully functional and is never gated behind this.
 */

const AI_DISCLOSURE_KEY = 'routepilot.disclosure.ai.v1';
/**
 * The voice disclosure is a SEPARATE key, deliberately.
 *
 * They are different recipients and different data: AI interpretation sends
 * text to Anthropic through this app's own server, while speech recognition
 * sends raw AUDIO to the browser's own provider without passing through this
 * app at all. A user may reasonably accept one and refuse the other, so
 * accepting either must never imply the other.
 */
const VOICE_DISCLOSURE_KEY = 'routepilot.disclosure.voice.v1';

function readDisclosureFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'accepted';
  } catch {
    // Private windows and blocked site data both throw. Treat as not accepted.
    return false;
  }
}

function writeDisclosureFlag(key: string): void {
  try {
    localStorage.setItem(key, 'accepted');
  } catch {
    // Non-fatal: the disclosure simply shows again next time.
  }
}

function readDisclosure(): boolean {
  return readDisclosureFlag(AI_DISCLOSURE_KEY);
}

function writeDisclosure(): void {
  writeDisclosureFlag(AI_DISCLOSURE_KEY);
}

export function NaturalLanguageInput({
  constraints,
  onAccept,
  /**
   * Injectable SpeechRecognition constructor. Production leaves it undefined
   * so the real browser API is resolved; tests pass a fake, which is the only
   * way the permission-denied, no-speech and recognition-error paths can be
   * covered without a real microphone.
   */
  speechRecognitionCtor,
}: {
  constraints: Constraint[];
  onAccept: (
    constraint: Constraint,
    asKind: 'hard' | 'soft',
    options?: { overrideHumanValue?: boolean },
  ) => ApplyOutcome;
  speechRecognitionCtor?: SpeechRecognitionConstructor | null;
}) {
  /*
   * State lives in `sessionReducer`, not in this component.
   *
   * The guarantee "a failure never loses what you typed" is behavioural, and a
   * guarantee that lives inside a component body is one nobody tests. As a
   * reducer it is asserted directly against every action in the union -- see
   * tests/ai-failure-recovery.test.ts.
   */
  const [session, dispatch] = useReducer(sessionReducer, initialSessionState);
  const [disclosureAccepted, setDisclosureAccepted] = useState<boolean | null>(null);

  const { text, result, transportError, appliedIndices, pendingConflict } = session;

  // Resolved lazily so the first paint does not depend on localStorage.
  const accepted = disclosureAccepted ?? readDisclosure();

  /* ---------------------------- voice input ---------------------------- */

  /**
   * Feature detection decides the initial phase. A browser without the API
   * starts (and stays) `unsupported`, and the microphone control renders as a
   * disabled explanation rather than a button that cannot work.
   */
  const injected = speechRecognitionCtor !== undefined;
  const supported = injected ? speechRecognitionCtor !== null : isSpeechRecognitionSupported();

  const [voice, voiceDispatch] = useReducer(voiceReducer, initialVoiceState(supported));
  const [voiceDisclosureAccepted, setVoiceDisclosureAccepted] = useState<boolean | null>(null);
  const [voiceDisclosurePending, setVoiceDisclosurePending] = useState(false);
  const sessionRef = useRef<SpeechSession | null>(null);

  const voiceAccepted = voiceDisclosureAccepted ?? readDisclosureFlag(VOICE_DISCLOSURE_KEY);
  const { language } = voice;

  const beginListening = useCallback(() => {
    const speech = startSpeechSession(
      {
        onStart: () => voiceDispatch({ type: 'listening_started' }),
        onTranscript: (transcript, isFinal) => {
          if (!isFinal) {
            voiceDispatch({ type: 'interim_transcript', text: transcript });
            return;
          }
          /*
           * A FINAL segment goes into the existing editable text via the
           * session reducer -- the same state the keyboard writes to. That is
           * what makes the textarea the transcript editor, and what guarantees
           * a transcript can never reach a constraint without passing through
           * Interpret and explicit confirmation.
           *
           * `append_transcript` rather than computing the new text here: these
           * handlers are registered once per session, so a closure over `text`
           * would be stale by the second phrase and would replace instead of
           * append. The reducer reads current state, so it cannot be.
           */
          voiceDispatch({ type: 'final_transcript' });
          dispatch({ type: 'append_transcript', text: transcript });
        },
        onError: (kind) => voiceDispatch({ type: 'recognition_error', kind }),
        onEnd: () => {
          sessionRef.current = null;
          voiceDispatch({ type: 'recognition_ended' });
        },
      },
      // Injected ctor wins; otherwise let the adapter resolve the real API.
      injected ? speechRecognitionCtor : undefined,
      // The selected recognition language, read at session start. The Web
      // Speech API takes one language per session and cannot be changed
      // mid-recording, which is why the selector is disabled while listening.
      language,
    );
    sessionRef.current = speech;
    // `text` is deliberately NOT a dependency: nothing in here reads it any
    // more, which is precisely what removes the stale-closure hazard.
  }, [injected, speechRecognitionCtor, language]);

  const onMicrophoneClick = () => {
    if (isListening(voice)) {
      sessionRef.current?.stop();
      voiceDispatch({ type: 'user_stopped' });
      return;
    }
    // The voice disclosure gates the FIRST capture, separately from the AI one.
    if (!voiceAccepted) {
      setVoiceDisclosurePending(true);
      return;
    }
    beginListening();
  };

  const interpret = async () => {
    dispatch({ type: 'submit' });
    try {
      const response = await fetch('/api/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ utterance: text, constraints }),
      });
      const body = (await response.json()) as InterpretResult;
      dispatch({ type: 'settle', result: body });
    } catch {
      // The text is deliberately NOT cleared -- the reducer has no action that
      // would, except the explicit user-triggered one.
      dispatch({
        type: 'transport_failed',
        message:
          'Could not reach the interpretation endpoint. Your text is preserved. The form below works regardless.',
      });
    }
  };

  const acceptProposal = (
    index: number,
    constraint: Constraint,
    asKind: 'hard' | 'soft',
    override = false,
  ) => {
    const outcome = onAccept(constraint, asKind, { overrideHumanValue: override });
    if (outcome.outcome === 'conflict') {
      dispatch({ type: 'conflict_raised', index, message: outcome.message });
      return;
    }
    dispatch({ type: 'proposal_applied', index });
  };

  if (!accepted) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <h3 className="font-medium">Before using AI interpretation</h3>
        <div
          className="rounded-md px-3 py-2"
          style={{ background: 'var(--rp-warn-bg)', border: '1px solid var(--rp-warn-border)' }}
        >
          <p>
            Interpreting a description sends <strong>the text you type</strong> to Anthropic&rsquo;s
            API through this app&rsquo;s own server.
          </p>
          <p className="mt-1">
            <strong>Not sent:</strong> the traveller profile, the trip state, the flight options,
            the measures, the ranking, or the decision trace. Only your text and the{' '}
            <em>names</em> of constraints already recorded &mdash; never their values.
          </p>
          <p className="mt-1">
            Email addresses, phone numbers, long card-like numbers and booking references are
            stripped before sending. That reduces what is transmitted; it is not a guarantee of
            anonymity. Use non-sensitive or synthetic details.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rp-btn"
            onClick={() => {
              writeDisclosure();
              setDisclosureAccepted(true);
            }}
          >
            I understand &mdash; enable AI interpretation
          </button>
          <span className="self-center text-[12px]" style={{ color: 'var(--rp-muted)' }}>
            Or decline and keep using the form below &mdash; everything still works.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      {/* ------------------------- voice disclosure ------------------------- */}
      {voiceDisclosurePending && !voiceAccepted && (
        <div
          className="flex flex-col gap-2 rounded-md px-3 py-2"
          style={{ background: 'var(--rp-warn-bg)', border: '1px solid var(--rp-warn-border)' }}
        >
          <h4 className="font-medium">Before using the microphone</h4>
          <p>
            Speech recognition is provided by <strong>your browser</strong>, not by this app. In
            Chrome and Edge the <strong>audio of what you say is sent to the browser&rsquo;s speech
            service</strong> (Google&rsquo;s) to be transcribed.
          </p>
          <p>
            That audio does not pass through this application, so it cannot be redacted or
            restricted here. This is separate from AI interpretation, which sends text to
            Anthropic &mdash; accepting one does not accept the other.
          </p>
          <p>Only the resulting text is used, and you can edit it before anything is sent.</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rp-btn"
              onClick={() => {
                writeDisclosureFlag(VOICE_DISCLOSURE_KEY);
                setVoiceDisclosureAccepted(true);
                setVoiceDisclosurePending(false);
                beginListening();
              }}
            >
              I understand &mdash; start listening
            </button>
            <button
              type="button"
              className="rp-btn-secondary"
              onClick={() => setVoiceDisclosurePending(false)}
            >
              No thanks, I&rsquo;ll type
            </button>
          </div>
        </div>
      )}

      {/* ------------------------ microphone control ------------------------ */}
      <div className="flex flex-wrap items-center gap-2">
        {voice.phase === 'unsupported' ? (
          <p className="text-[12px]" style={{ color: 'var(--rp-muted)' }}>
            <strong>Voice input is not available in this browser.</strong> Chrome or Edge support
            it; Firefox does not, and Safari blocks it inside an installed web app. Type the
            description instead &mdash; nothing else changes.
          </p>
        ) : (
          <>
            <button
              type="button"
              className="rp-btn-secondary"
              aria-pressed={isListening(voice)}
              onClick={onMicrophoneClick}
              disabled={!isListening(voice) && !canStartListening(voice)}
            >
              {isListening(voice) ? '■ Stop listening' : '● Speak'}
            </button>
            <span
              className="text-[11px]"
              style={{ color: isListening(voice) ? 'var(--rp-accent)' : 'var(--rp-muted)' }}
              role="status"
            >
              {VOICE_PHASE_LABELS[voice.phase]}
            </span>

            <label className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--rp-muted)' }}>
              <span>Speak in</span>
              <select
                className="rp-input"
                style={{ width: 'auto', padding: '0.2rem 0.35rem' }}
                value={language}
                aria-label="Speech recognition language"
                /* One language per recording: the API cannot switch mid-session. */
                disabled={isListening(voice)}
                onChange={(e) =>
                  voiceDispatch({
                    type: 'language_changed',
                    language: e.target.value as SpeechLanguageCode,
                  })
                }
              >
                {SPEECH_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>

      {voice.phase !== 'unsupported' && (
        <p className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
          {speechLanguageNote(language)} {SPEECH_ACCURACY_CAVEAT}
        </p>
      )}

      {/* Live interim words. Display only -- never merged into the text. */}
      {voice.interim !== '' && (
        <p className="text-[12px] italic" style={{ color: 'var(--rp-muted)' }}>
          hearing: &ldquo;{voice.interim}&rdquo;{' '}
          <span className="not-italic">(not added until the phrase completes)</span>
        </p>
      )}

      {voice.error !== null && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5"
          style={{
            background: 'var(--rp-excluded-bg)',
            border: '1px solid var(--rp-excluded-border)',
          }}
        >
          <p className="text-[12px]">{voice.error.message}</p>
          <button
            type="button"
            className="rp-btn-secondary"
            onClick={() => voiceDispatch({ type: 'dismiss_error' })}
          >
            Dismiss
          </button>
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
          Describe the trip in your own words
          {voice.phase === 'stopped' && ' — edit the transcript below before interpreting'}
        </span>
        <textarea
          className="rp-input"
          rows={3}
          value={text}
          onChange={(e) => dispatch({ type: 'edit_text', text: e.target.value })}
          placeholder="Needs to be in New York by midday Wednesday the 4th, business class, from London. Budget around £1,200."
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rp-btn"
          onClick={interpret}
          disabled={!canSubmit(session)}
          style={!canSubmit(session) ? { opacity: 0.55 } : undefined}
        >
          {session.phase === 'pending' ? 'Interpreting…' : 'Interpret with AI'}
        </button>
        <span className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
          Sends only this text. Nothing is applied until you accept it below.
        </span>
      </div>

      {transportError && (
        <p
          className="rounded-md px-2 py-1.5"
          style={{
            background: 'var(--rp-excluded-bg)',
            border: '1px solid var(--rp-excluded-border)',
          }}
        >
          {transportError}
        </p>
      )}

      {result && result.status !== 'ok' && (
        <div
          className="rounded-md px-2 py-1.5"
          style={{
            background: 'var(--rp-excluded-bg)',
            border: '1px solid var(--rp-excluded-border)',
          }}
        >
          <p>{result.message}</p>
          {result.status === 'unavailable' && (
            <p className="mt-1 text-[11px]" style={{ color: 'var(--rp-muted)' }}>
              The deterministic engine, the seeded scenarios and manual entry are all unaffected.
            </p>
          )}
        </div>
      )}

      {result?.status === 'ok' && (
        <div className="flex flex-col gap-3">
          {result.redactedCategories.length > 0 && (
            <p className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
              Removed before sending: {result.redactedCategories.join(', ')}.
            </p>
          )}

          {result.patch.accepted.length > 0 && (
            <div>
              <h4 className="font-medium">
                Proposed constraints &mdash; nothing applied until you choose
              </h4>
              <ul className="mt-1 flex flex-col gap-2">
                {result.patch.accepted.map((p, i) => {
                  const isApplied = appliedIndices.has(i);
                  const conflict = pendingConflict?.index === i ? pendingConflict : null;
                  const value =
                    p.constraint.key === 'arrival_deadline'
                      ? `${p.constraint.value.localDateTime.replace('T', ' ')} (${p.constraint.value.tz})`
                      : String(p.constraint.value);
                  return (
                    <li
                      key={`${p.constraint.key}-${i}`}
                      className="rounded-md px-2 py-1.5"
                      style={{ border: '1px dashed var(--rp-border)' }}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{CONSTRAINT_LABELS[p.constraint.key]}</span>
                        <span className="rp-mono">{value}</span>
                        <span className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
                          inferred · confidence{' '}
                          {p.constraint.confidence === undefined
                            ? 'n/a'
                            : p.constraint.confidence.toFixed(2)}
                          {p.suggestedKind === 'hard' && ' · model suggested firm'}
                        </span>
                      </div>
                      <p className="text-[11px] italic" style={{ color: 'var(--rp-muted)' }}>
                        from your words: “{p.evidence}”
                      </p>
                      {isApplied ? (
                        <p className="mt-1 text-[12px]" style={{ color: 'var(--rp-accent)' }}>
                          Added to the ledger.
                        </p>
                      ) : conflict ? (
                        /*
                         * A second, explicit decision. The suggestion would
                         * overwrite a value you supplied yourself, so neither
                         * is chosen automatically.
                         */
                        <div
                          className="mt-1 rounded-md px-2 py-1.5"
                          style={{
                            background: 'var(--rp-warn-bg)',
                            border: '1px solid var(--rp-warn-border)',
                          }}
                        >
                          <p className="text-[12px]">{conflict.message}</p>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              className="rp-btn-secondary"
                              onClick={() => dispatch({ type: 'conflict_resolved' })}
                            >
                              Keep mine
                            </button>
                            <button
                              type="button"
                              className="rp-btn-secondary"
                              onClick={() => acceptProposal(i, p.constraint, 'soft', true)}
                            >
                              Replace with the suggestion
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            className="rp-btn-secondary"
                            onClick={() => acceptProposal(i, p.constraint, 'soft')}
                          >
                            Add as preference
                          </button>
                          <button
                            type="button"
                            className="rp-btn-secondary"
                            onClick={() => acceptProposal(i, p.constraint, 'hard')}
                            title="Firm requirements exclude options. Only you can make one firm."
                          >
                            Add as firm requirement
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {result.patch.rejected.length > 0 && (
            <div>
              <h4 className="font-medium">Could not be used</h4>
              <ul className="list-disc pl-5 text-[12px]">
                {result.patch.rejected.map((r, i) => (
                  <li key={`${r.key}-${i}`}>
                    <span className="font-medium">{CONSTRAINT_LABELS[r.key]}</span>{' '}
                    (&ldquo;{r.rawValue}&rdquo;) &mdash; {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.patch.clarifyingQuestions.length > 0 && (
            <div>
              <h4 className="font-medium">Needs clarification</h4>
              <ul className="list-disc pl-5 text-[12px]">
                {result.patch.clarifyingQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}

          {result.patch.unmapped.length > 0 && (
            <div>
              <h4 className="font-medium">Mentioned, but not something this engine models</h4>
              <ul className="list-disc pl-5 text-[12px]">
                {result.patch.unmapped.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          )}

          {result.patch.accepted.length === 0 &&
            result.patch.rejected.length === 0 &&
            result.patch.clarifyingQuestions.length === 0 && (
              <p style={{ color: 'var(--rp-muted)' }}>
                Nothing usable was extracted. Try being more specific, or use the form below.
              </p>
            )}
        </div>
      )}
    </div>
  );
}
