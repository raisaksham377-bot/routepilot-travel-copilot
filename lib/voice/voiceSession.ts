import {
  DEFAULT_SPEECH_LANGUAGE,
  SPEECH_ERROR_MESSAGES,
  type SpeechErrorKind,
  type SpeechLanguageCode,
} from './speechRecognition';

/**
 * The microphone interaction, as a pure state machine.
 *
 * Same reasoning as `interpretSession`: the guarantees worth having here are
 * behavioural -- "a denied permission never loses typed text", "an empty
 * transcript does not overwrite anything" -- and a guarantee living inside a
 * component body is one nobody tests.
 *
 * THE CENTRAL INVARIANT: this reducer holds no committed text at all. Final
 * transcript segments are handed to the caller, which dispatches them into the
 * existing `sessionReducer` as ordinary `edit_text`. That is what makes voice
 * an input method for the existing workflow rather than a parallel path, and
 * it is why a transcript can never reach a constraint without passing through
 * Interpret and explicit confirmation.
 */

/** The four states the UI must distinguish, plus a transient error state. */
export type VoicePhase =
  /** The API is absent (Firefox, or a Safari PWA). Typing only. */
  | 'unsupported'
  /** Supported and ready, never yet started, or stopped cleanly. */
  | 'idle'
  /** Actively capturing. */
  | 'listening'
  /** Finished a session that produced something. */
  | 'stopped'
  /** Failed. `error` carries the kind and message. */
  | 'error';

export interface VoiceState {
  phase: VoicePhase;
  /**
   * Words heard but not yet committed. Shown live so the user can see it is
   * working, but NEVER merged into the editable text -- only final segments
   * are, so a half-heard phrase cannot silently become part of the request.
   */
  interim: string;
  error: { kind: SpeechErrorKind; message: string } | null;
  /** True once any final segment has been produced in this session. */
  producedFinalText: boolean;
  /**
   * Recognition language for the NEXT session.
   *
   * Note what this state does NOT contain: the transcript. That lives in
   * `interpretSession`, so changing language here cannot touch it -- the
   * preservation guarantee is structural rather than something this reducer
   * has to remember to honour.
   */
  language: SpeechLanguageCode;
}

export function initialVoiceState(
  supported: boolean,
  language: SpeechLanguageCode = DEFAULT_SPEECH_LANGUAGE,
): VoiceState {
  return {
    phase: supported ? 'idle' : 'unsupported',
    interim: '',
    error: null,
    producedFinalText: false,
    language,
  };
}

export type VoiceAction =
  | { type: 'listening_started' }
  | { type: 'interim_transcript'; text: string }
  | { type: 'final_transcript' }
  | { type: 'recognition_error'; kind: SpeechErrorKind }
  | { type: 'recognition_ended' }
  | { type: 'user_stopped' }
  | { type: 'dismiss_error' }
  | { type: 'language_changed'; language: SpeechLanguageCode };

export function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
  /*
   * Language selection works even in an unsupported browser, so the control
   * is not mysteriously dead there -- it simply has nothing to drive yet. Kept
   * ahead of the unsupported short-circuit for that reason.
   *
   * It never touches `interim`, `phase` or `error`, and cannot touch the
   * transcript because this reducer does not hold it.
   */
  if (action.type === 'language_changed') {
    return { ...state, language: action.language };
  }

  // An unsupported browser can never leave that state. Nothing to recover to.
  if (state.phase === 'unsupported') return state;

  switch (action.type) {
    case 'listening_started':
      return { ...state, phase: 'listening', interim: '', error: null, producedFinalText: false };

    case 'interim_transcript':
      // Interim text is display-only; it is deliberately not committed.
      return { ...state, interim: action.text };

    case 'final_transcript':
      return { ...state, interim: '', producedFinalText: true };

    case 'recognition_error': {
      /*
       * 'aborted' is NOT surfaced as an error when the user already got text.
       * Chrome fires it on a normal stop() in some versions, and showing a
       * failure after a successful capture would be actively misleading.
       */
      if (action.kind === 'aborted' && state.producedFinalText) {
        return { ...state, phase: 'stopped', interim: '' };
      }
      return {
        ...state,
        phase: 'error',
        interim: '',
        error: { kind: action.kind, message: SPEECH_ERROR_MESSAGES[action.kind] },
      };
    }

    case 'recognition_ended':
      // Does not clobber an error that already landed.
      if (state.phase === 'error') return state;
      return { ...state, phase: state.producedFinalText ? 'stopped' : 'idle', interim: '' };

    case 'user_stopped':
      if (state.phase === 'error') return state;
      return { ...state, phase: state.producedFinalText ? 'stopped' : 'idle', interim: '' };

    case 'dismiss_error':
      return { ...state, phase: 'idle', error: null };
  }
}

/** Whether the microphone button should start a session. */
export function canStartListening(state: VoiceState): boolean {
  return state.phase === 'idle' || state.phase === 'stopped' || state.phase === 'error';
}

export function isListening(state: VoiceState): boolean {
  return state.phase === 'listening';
}

/**
 * Whether typing remains available.
 *
 * Always true, in every voice state including `unsupported` and
 * `permission_denied`. The function exists so that is asserted in tests rather
 * than assumed -- the whole point of feature detection is that the keyboard
 * path never depends on the microphone path.
 */
export function typingAvailable(_state: VoiceState): true {
  void _state;
  return true;
}

/** Short status label for the microphone control. */
export const VOICE_PHASE_LABELS: Record<VoicePhase, string> = {
  unsupported: 'Voice input not available in this browser',
  idle: 'Start voice input',
  listening: 'Listening — click to stop',
  stopped: 'Start voice input again',
  error: 'Try voice input again',
};
