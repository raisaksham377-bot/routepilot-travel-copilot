/**
 * A thin, injectable adapter over the browser's Web Speech API.
 *
 * Two reasons it exists rather than calling the API from the component:
 *
 *  1. Testability. A real microphone cannot be part of an automated suite, and
 *     the failure states that matter most -- permission denied, no speech,
 *     recognition error, interrupted session -- are exactly the ones you cannot
 *     trigger on demand with real hardware. Injecting a constructor makes all
 *     of them ordinary test cases.
 *
 *  2. Honesty about scope. This adapter does speech-to-TEXT and nothing else.
 *     There is no speech synthesis, no continuous conversation, no turn-taking.
 *     Checkpoint B3 is voice input, not a voice agent, and the shape of this
 *     module reflects that boundary.
 *
 * Browser reality this is designed around:
 *   - Chrome/Edge expose it as `webkitSpeechRecognition` (prefixed).
 *   - Firefox does not ship it enabled.
 *   - Safari supports it but with unreliable continuous mode, and refuses it
 *     entirely inside an installed PWA.
 *   - Chrome streams audio to a Google cloud service, so recognition needs a
 *     network connection and is NOT local. The disclosure says so.
 */

/**
 * Recognition languages offered.
 *
 * `accuracyNote` is per-language and deliberately hedged. Support is the
 * BROWSER's, not this application's: Chrome and Edge send the audio to
 * Google's speech service, so which languages work well, and how well, is
 * entirely outside this project's control and varies by browser and version.
 * Nothing here has been measured, so nothing here claims a quality level.
 */
export const SPEECH_LANGUAGES = [
  {
    code: 'en-GB',
    label: 'English (UK)',
    accuracyNote: 'Generally the best-supported option in Chrome and Edge.',
  },
  {
    code: 'en-IN',
    label: 'English (India)',
    accuracyNote: 'Indian-accented English. Support varies by browser and version.',
  },
  {
    code: 'hi-IN',
    label: 'हिन्दी — Hindi (India)',
    accuracyNote:
      'Recognises Hindi. Expect place names, airline names and airport codes to need correcting.',
  },
] as const;

export type SpeechLanguageCode = (typeof SPEECH_LANGUAGES)[number]['code'];

export const DEFAULT_SPEECH_LANGUAGE: SpeechLanguageCode = 'en-GB';

export function speechLanguageLabel(code: SpeechLanguageCode): string {
  return SPEECH_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

export function speechLanguageNote(code: SpeechLanguageCode): string {
  return SPEECH_LANGUAGES.find((l) => l.code === code)?.accuracyNote ?? '';
}

/**
 * The standing caveat shown next to the selector.
 *
 * Note what it explicitly does NOT promise: mixed-language speech. Hindi-English
 * code-switching ("Hinglish") is common in Indian travel conversation and is
 * supported by some commercial travel assistants, but the Web Speech API takes
 * ONE language per session, and this project has not verified code-switching
 * behaviour. Claiming it would be an unverified promise, so the copy says
 * plainly that it is unsupported rather than staying silent and letting a user
 * assume.
 */
export const SPEECH_ACCURACY_CAVEAT =
  'Recognition is performed by your browser, so accuracy varies by browser, version and language — ' +
  'it is not something this app controls or has measured. One language is recognised per recording: ' +
  'mixing Hindi and English in the same sentence is not supported here and has not been tested. ' +
  'Always read the transcript before interpreting it; airport codes and airline names are often misheard.';

/** The subset of SpeechRecognition this project uses. */
export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: SpeechErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

export interface SpeechResultEventLike {
  resultIndex: number;
  results: ArrayLike<
    ArrayLike<{ transcript: string }> & { isFinal: boolean }
  >;
}

export interface SpeechErrorEventLike {
  error: string;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/** Failure kinds, mapped from the spec's error codes to something actionable. */
export type SpeechErrorKind =
  | 'permission_denied'
  | 'no_microphone'
  | 'no_speech'
  | 'network'
  | 'aborted'
  | 'unknown';

/**
 * Maps a `SpeechRecognitionErrorEvent.error` code onto our kinds.
 *
 * `service-not-allowed` is grouped with `not-allowed` deliberately: from the
 * user's point of view both mean "the browser will not let this happen", and
 * splitting them would produce two messages with the same remedy.
 */
export function mapSpeechError(code: string): SpeechErrorKind {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'permission_denied';
    case 'audio-capture':
      return 'no_microphone';
    case 'no-speech':
      return 'no_speech';
    case 'network':
      return 'network';
    case 'aborted':
      return 'aborted';
    default:
      return 'unknown';
  }
}

/** Plain-language copy per failure. Every one keeps typing available. */
export const SPEECH_ERROR_MESSAGES: Record<SpeechErrorKind, string> = {
  permission_denied:
    'Microphone access was refused, so nothing was recorded. Type the description instead — everything works without the microphone.',
  no_microphone:
    'No microphone was available, so nothing was recorded. Type the description instead.',
  no_speech:
    'No speech was detected, so the transcript is empty. Try again, or type the description instead.',
  network:
    'Speech recognition needs a network connection and could not reach its service. Nothing was recorded. Type the description instead.',
  aborted: 'Listening stopped before anything was transcribed. Your existing text is unchanged.',
  unknown:
    'Speech recognition failed, so nothing was recorded. Type the description instead.',
};

/** Resolves the constructor, preferring the standard name over the prefix. */
export function resolveSpeechRecognition(
  win: unknown = typeof window === 'undefined' ? undefined : window,
): SpeechRecognitionConstructor | null {
  if (win === undefined || win === null || typeof win !== 'object') return null;
  const w = win as Record<string, unknown>;
  const candidate = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof candidate === 'function' ? (candidate as SpeechRecognitionConstructor) : null;
}

export function isSpeechRecognitionSupported(win?: unknown): boolean {
  return resolveSpeechRecognition(win) !== null;
}

export interface SpeechHandlers {
  /** Called as words arrive. `isFinal` marks a committed segment. */
  onTranscript: (text: string, isFinal: boolean) => void;
  onError: (kind: SpeechErrorKind) => void;
  /** Fires whether the session ended normally, was stopped, or errored. */
  onEnd: () => void;
  onStart: () => void;
}

export interface SpeechSession {
  stop(): void;
  abort(): void;
}

/**
 * Starts a single recognition session.
 *
 * `continuous: false` is deliberate. A continuous session is the first step
 * towards a always-listening voice agent, which is explicitly out of scope --
 * and on iOS continuous mode is unreliable anyway. One press, one utterance.
 */
export function startSpeechSession(
  handlers: SpeechHandlers,
  ctor: SpeechRecognitionConstructor | null = resolveSpeechRecognition(),
  lang: string = DEFAULT_SPEECH_LANGUAGE,
): SpeechSession | null {
  if (ctor === null) return null;

  const recognition = new ctor();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = lang;

  recognition.onstart = () => handlers.onStart();

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result === undefined) continue;
      const alternative = result[0];
      if (alternative === undefined) continue;
      handlers.onTranscript(alternative.transcript, result.isFinal);
    }
  };

  recognition.onerror = (event) => handlers.onError(mapSpeechError(event.error));
  recognition.onend = () => handlers.onEnd();

  recognition.start();

  return {
    stop: () => recognition.stop(),
    abort: () => recognition.abort(),
  };
}
