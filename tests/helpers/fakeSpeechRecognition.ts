import type {
  SpeechRecognitionConstructor,
  SpeechRecognitionLike,
} from '@/lib/voice/speechRecognition';

/**
 * A controllable fake SpeechRecognition.
 *
 * No automated test may require a real microphone -- and more importantly, the
 * states that matter most cannot be produced on demand with real hardware:
 * permission denial, no speech detected, a network failure in the recognition
 * service, an aborted session. With a fake they are one method call each.
 *
 * It implements only the surface `lib/voice/speechRecognition.ts` actually
 * uses, so it cannot drift into testing capabilities the adapter never touches.
 */
export class FakeSpeechRecognition implements SpeechRecognitionLike {
  static instances: FakeSpeechRecognition[] = [];

  continuous = false;
  interimResults = false;
  lang = '';

  onresult: SpeechRecognitionLike['onresult'] = null;
  onerror: SpeechRecognitionLike['onerror'] = null;
  onend: SpeechRecognitionLike['onend'] = null;
  onstart: SpeechRecognitionLike['onstart'] = null;

  started = false;
  stopCalls = 0;
  abortCalls = 0;

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  static reset(): void {
    FakeSpeechRecognition.instances = [];
  }

  /** The most recently constructed instance -- what the component just started. */
  static latest(): FakeSpeechRecognition {
    const last = FakeSpeechRecognition.instances.at(-1);
    if (last === undefined) throw new Error('No FakeSpeechRecognition was constructed');
    return last;
  }

  start(): void {
    this.started = true;
    // The real API fires onstart asynchronously; firing it here keeps the
    // component's state machine on the same path it takes in a browser.
    this.onstart?.();
  }

  stop(): void {
    this.stopCalls += 1;
  }

  abort(): void {
    this.abortCalls += 1;
  }

  /* ----------------------- test-driven emissions ----------------------- */

  /** Emits words still being heard. The component must NOT commit these. */
  emitInterim(transcript: string): void {
    this.onresult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript }], { isFinal: false })],
    });
  }

  /** Emits a completed phrase, which the component appends to the text. */
  emitFinal(transcript: string): void {
    this.onresult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript }], { isFinal: true })],
    });
  }

  /** Emits a spec error code, e.g. 'not-allowed', 'no-speech', 'network'. */
  emitError(code: string): void {
    this.onerror?.({ error: code });
  }

  /** The session finishing, which the real API always fires last. */
  emitEnd(): void {
    this.onend?.();
  }
}

/** Constructor to inject into the component. */
export const fakeSpeechCtor = FakeSpeechRecognition as unknown as SpeechRecognitionConstructor;

/** Signals an unsupported browser: feature detection must find nothing. */
export const unsupportedSpeechCtor = null;
