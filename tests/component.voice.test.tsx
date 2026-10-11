// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NaturalLanguageInput } from '@/app/components/NaturalLanguageInput';
import { applyProposedConstraint } from '@/lib/ai/applyProposal';
import { buildTripState } from '@/lib/data/build';
import { S2_NONSTOP } from '@/lib/data/scenarios';
import type { Constraint } from '@/lib/schema/constraint';
import type { TripState } from '@/lib/schema/tripState';
import { FakeSpeechRecognition, fakeSpeechCtor } from './helpers/fakeSpeechRecognition';
import { CABIN_PATCH, stubSuccessfulPatch } from './helpers/mockInterpretFetch';

/**
 * Voice input, driven through the REAL component with a fake
 * SpeechRecognition injected. No microphone, no network, no real recognition
 * service is involved at any point.
 *
 * The behaviours under test are the ones a user would notice: does the button
 * change state, does the transcript land somewhere editable, and does a denied
 * permission leave them able to carry on by typing.
 */

function Harness({
  initialConstraints = [],
  onStateChange,
  ctor = fakeSpeechCtor,
}: {
  initialConstraints?: Constraint[];
  onStateChange?: (s: TripState) => void;
  ctor?: typeof fakeSpeechCtor | null;
}) {
  let state = buildTripState({ options: [S2_NONSTOP], constraints: initialConstraints });
  const accept: React.ComponentProps<typeof NaturalLanguageInput>['onAccept'] = (
    constraint,
    asKind,
    options,
  ) => {
    const outcome = applyProposedConstraint(state, constraint, asKind, options);
    if (outcome.outcome !== 'conflict') {
      state = outcome.state;
      onStateChange?.(state);
    }
    return outcome;
  };
  return (
    <NaturalLanguageInput
      constraints={initialConstraints}
      onAccept={accept}
      speechRecognitionCtor={ctor}
    />
  );
}

async function acceptAiDisclosure(user: ReturnType<typeof userEvent.setup>) {
  const b = screen.queryByRole('button', { name: /enable AI interpretation/i });
  if (b !== null) await user.click(b);
}

async function acceptVoiceDisclosure(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Speak/i }));
  await user.click(screen.getByRole('button', { name: /start listening/i }));
}

const transcript = () =>
  screen.getByLabelText(/Describe the trip in your own words/i) as HTMLTextAreaElement;

beforeEach(() => {
  FakeSpeechRecognition.reset();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the voice disclosure is separate from the AI one', () => {
  it('appears before the first capture and explains the audio goes to the browser vendor', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);

    await user.click(screen.getByRole('button', { name: /Speak/i }));

    expect(screen.getByText(/Before using the microphone/i)).toBeDefined();
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/audio of what you say is sent to the browser/i);
    expect(body).toMatch(/does not pass through this application/i);
    // Explicitly states the two disclosures are independent.
    expect(body).toMatch(/accepting one does not accept the other/i);

    // Nothing started: the disclosure gates the capture.
    expect(FakeSpeechRecognition.instances).toHaveLength(0);
  });

  it('declining leaves typing fully available and starts nothing', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);
    await user.click(screen.getByRole('button', { name: /Speak/i }));

    await user.click(screen.getByRole('button', { name: /No thanks, I.ll type/i }));

    expect(screen.queryByText(/Before using the microphone/i)).toBeNull();
    expect(FakeSpeechRecognition.instances).toHaveLength(0);

    // The deterministic typed path works untouched.
    await user.type(transcript(), 'New York by Wednesday');
    expect(transcript().value).toBe('New York by Wednesday');
    expect(screen.getByRole('button', { name: /Interpret with AI/i })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('accepting the AI disclosure does not imply the voice one', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);

    // AI accepted, yet the microphone still asks first.
    await user.click(screen.getByRole('button', { name: /Speak/i }));
    expect(screen.getByText(/Before using the microphone/i)).toBeDefined();
  });
});

describe('the microphone control and its states', () => {
  it('shows listening after accepting, and stops on a second click', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);
    await acceptVoiceDisclosure(user);

    const mic = screen.getByRole('button', { name: /Stop listening/i });
    expect(mic.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('status').textContent).toMatch(/Listening/i);
    expect(FakeSpeechRecognition.latest().started).toBe(true);

    await user.click(mic);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Speak/i }).getAttribute('aria-pressed')).toBe(
        'false',
      ),
    );
    expect(FakeSpeechRecognition.latest().stopCalls).toBe(1);
  });

  it('shows an unsupported message and no microphone button when the API is absent', async () => {
    const user = userEvent.setup();
    render(<Harness ctor={null} />);
    await acceptAiDisclosure(user);

    expect(screen.getByText(/Voice input is not available in this browser/i)).toBeDefined();
    expect(screen.getByText(/Firefox does not/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /Speak/i })).toBeNull();

    // Typed input is completely unaffected.
    await user.type(transcript(), 'typed instead');
    expect(transcript().value).toBe('typed instead');
  });
});

describe('the transcript is editable before anything is sent', () => {
  it('a completed phrase lands in the editable textarea', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);
    await acceptVoiceDisclosure(user);

    await act(async () => {
      FakeSpeechRecognition.latest().emitFinal('New York by midday Wednesday');
    });

    await waitFor(() => expect(transcript().value).toBe('New York by midday Wednesday'));
  });

  it('interim words are shown live but NOT put into the text', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);
    await acceptVoiceDisclosure(user);

    await act(async () => {
      FakeSpeechRecognition.latest().emitInterim('New York by');
    });

    // Visible as provisional...
    await waitFor(() => expect(screen.getByText(/hearing:/i)).toBeDefined());
    expect(screen.getByText(/not added until the phrase completes/i)).toBeDefined();
    // ...but the editable text is still empty.
    expect(transcript().value).toBe('');
  });

  it('the user can correct the transcript, and the correction is what gets sent', async () => {
    const user = userEvent.setup();
    const spy = stubSuccessfulPatch(CABIN_PATCH);
    render(<Harness />);
    await acceptAiDisclosure(user);
    await acceptVoiceDisclosure(user);

    await act(async () => {
      FakeSpeechRecognition.latest().emitFinal('New York by midday Wendsday');
    });
    await waitFor(() => expect(transcript().value).toContain('Wendsday'));

    // Fix the misheard word.
    await user.clear(transcript());
    await user.type(transcript(), 'New York by midday Wednesday');
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    expect(body.utterance).toBe('New York by midday Wednesday');
    expect(body.utterance).not.toContain('Wendsday');
  });

  it('a second phrase appends rather than replacing the first', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);
    await acceptVoiceDisclosure(user);

    await act(async () => {
      FakeSpeechRecognition.latest().emitFinal('New York by Wednesday');
    });
    await waitFor(() => expect(transcript().value).toBe('New York by Wednesday'));

    await act(async () => {
      FakeSpeechRecognition.latest().emitFinal('business class');
    });
    await waitFor(() => expect(transcript().value).toBe('New York by Wednesday business class'));
  });

  it('dictation does not auto-submit -- interpreting is still an explicit click', async () => {
    const user = userEvent.setup();
    const spy = stubSuccessfulPatch(CABIN_PATCH);
    render(<Harness />);
    await acceptAiDisclosure(user);
    await acceptVoiceDisclosure(user);

    await act(async () => {
      FakeSpeechRecognition.latest().emitFinal('business class to New York');
      FakeSpeechRecognition.latest().emitEnd();
    });
    await waitFor(() => expect(transcript().value).toContain('business class'));

    // THE ASSERTION: a transcript exists, and nothing has been sent.
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByText(/Proposed constraints/i)).toBeNull();
  });
});

describe('the recognition language selector', () => {
  const selector = () =>
    screen.getByLabelText(/Speech recognition language/i) as HTMLSelectElement;

  it('defaults to English (UK) and passes it to the recognition instance', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);

    expect(selector().value).toBe('en-GB');

    await acceptVoiceDisclosure(user);
    expect(FakeSpeechRecognition.latest().lang).toBe('en-GB');
  });

  it('offers English (UK), English (India) and Hindi', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);

    const values = Array.from(selector().options).map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(['en-GB', 'en-IN', 'hi-IN']));
    expect(screen.getByRole('option', { name: /Hindi/ })).toBeDefined();
  });

  it.each(['en-IN', 'hi-IN'] as const)(
    'passes %s to the recognition instance when selected',
    async (code) => {
      const user = userEvent.setup();
      render(<Harness />);
      await acceptAiDisclosure(user);

      await user.selectOptions(selector(), code);
      expect(selector().value).toBe(code);

      await acceptVoiceDisclosure(user);
      // THE ASSERTION: the selected language reached the actual instance.
      expect(FakeSpeechRecognition.latest().lang).toBe(code);
    },
  );

  it('a later language change applies to the NEXT recording', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);
    await acceptVoiceDisclosure(user);
    expect(FakeSpeechRecognition.latest().lang).toBe('en-GB');

    await act(async () => {
      FakeSpeechRecognition.latest().emitEnd();
    });

    await user.selectOptions(selector(), 'hi-IN');
    await user.click(screen.getByRole('button', { name: /Speak/i }));

    expect(FakeSpeechRecognition.instances).toHaveLength(2);
    expect(FakeSpeechRecognition.latest().lang).toBe('hi-IN');
  });

  /** The behaviour the task specifically asks to be proven. */
  it('changing the language does NOT erase the current transcript', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);
    await acceptVoiceDisclosure(user);

    await act(async () => {
      FakeSpeechRecognition.latest().emitFinal('New York by Wednesday');
      FakeSpeechRecognition.latest().emitEnd();
    });
    await waitFor(() => expect(transcript().value).toBe('New York by Wednesday'));

    await user.selectOptions(selector(), 'hi-IN');

    // THE ASSERTION: byte-identical transcript after the language change.
    expect(transcript().value).toBe('New York by Wednesday');
    expect(selector().value).toBe('hi-IN');
  });

  it('changing the language does not erase text the user TYPED either', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);
    await user.type(transcript(), 'typed by hand');

    await user.selectOptions(screen.getByLabelText(/Speech recognition language/i), 'en-IN');
    expect(transcript().value).toBe('typed by hand');
  });

  it('is disabled while listening, because the API takes one language per recording', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);
    await acceptVoiceDisclosure(user);

    expect(selector()).toHaveProperty('disabled', true);

    await user.click(screen.getByRole('button', { name: /Stop listening/i }));
    await waitFor(() => expect(selector()).toHaveProperty('disabled', false));
  });

  it('is absent in an unsupported browser, alongside the mic button', async () => {
    const user = userEvent.setup();
    render(<Harness ctor={null} />);
    await acceptAiDisclosure(user);
    expect(screen.queryByLabelText(/Speech recognition language/i)).toBeNull();
  });

  it('shows the accuracy caveat and promises no code-switching', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/accuracy varies by browser/i);
    expect(body).toMatch(/one language is recognised per recording/i);
    expect(body).toMatch(/mixing Hindi and English.*not supported/i);
    expect(body).toMatch(/read the transcript/i);
  });

  it('shows a per-language note that changes with the selection', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);

    expect(document.body.textContent).toMatch(/best-supported option/i);

    await user.selectOptions(screen.getByLabelText(/Speech recognition language/i), 'hi-IN');
    expect(document.body.textContent).toMatch(/Recognises Hindi/i);
    expect(document.body.textContent).toMatch(/need correcting/i);
  });
});

describe('a transcript never becomes a constraint on its own', () => {
  it('requires interpret AND explicit confirmation, exactly as typing does', async () => {
    const user = userEvent.setup();
    stubSuccessfulPatch(CABIN_PATCH);
    const changes: TripState[] = [];
    render(<Harness onStateChange={(s) => changes.push(s)} />);
    await acceptAiDisclosure(user);
    await acceptVoiceDisclosure(user);

    await act(async () => {
      FakeSpeechRecognition.latest().emitFinal('business class please');
    });
    await waitFor(() => expect(transcript().value).toContain('business class'));

    // Dictating alone changes nothing.
    expect(changes).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));
    await waitFor(() => expect(screen.getByText(/Proposed constraints/i)).toBeDefined());

    // Still nothing applied: proposals await confirmation.
    expect(changes).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /Add as preference/i }));
    await waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]!.constraints[0]!.source).toBe('user-edited');
  });
});

describe('failures never break the deterministic workflow', () => {
  it.each([
    ['not-allowed', /Microphone access was refused/i],
    ['audio-capture', /No microphone was available/i],
    ['no-speech', /No speech was detected/i],
    ['network', /needs a network connection/i],
    ['some-future-code', /Speech recognition failed/i],
  ] as const)('%s shows a clear message and keeps typing working', async (code, expected) => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);
    await acceptVoiceDisclosure(user);

    await act(async () => {
      FakeSpeechRecognition.latest().emitError(code);
      FakeSpeechRecognition.latest().emitEnd();
    });

    await waitFor(() => expect(screen.getByText(expected)).toBeDefined());

    // Typing still works, and the microphone can be retried.
    await user.type(transcript(), 'typed after the failure');
    expect(transcript().value).toBe('typed after the failure');
    expect(screen.getByRole('button', { name: /Speak|Try voice input again/i })).toBeDefined();
  });

  it('a permission denial does not lose text already typed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);
    await user.type(transcript(), 'typed before trying the microphone');
    await acceptVoiceDisclosure(user);

    await act(async () => {
      FakeSpeechRecognition.latest().emitError('not-allowed');
      FakeSpeechRecognition.latest().emitEnd();
    });

    await waitFor(() => expect(screen.getByText(/Microphone access was refused/i)).toBeDefined());
    expect(transcript().value).toBe('typed before trying the microphone');
  });

  it('an error can be dismissed and voice retried', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);
    await acceptVoiceDisclosure(user);

    await act(async () => {
      FakeSpeechRecognition.latest().emitError('no-speech');
      FakeSpeechRecognition.latest().emitEnd();
    });
    await waitFor(() => expect(screen.getByText(/No speech was detected/i)).toBeDefined());

    await user.click(screen.getByRole('button', { name: /Dismiss/i }));
    await waitFor(() => expect(screen.queryByText(/No speech was detected/i)).toBeNull());

    // Second attempt starts a fresh session -- the disclosure is not re-asked.
    await user.click(screen.getByRole('button', { name: /Speak/i }));
    expect(FakeSpeechRecognition.instances.length).toBeGreaterThanOrEqual(2);
  });

  it('an interrupted session that produced text is not reported as a failure', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);
    await acceptVoiceDisclosure(user);

    await act(async () => {
      const r = FakeSpeechRecognition.latest();
      r.emitFinal('New York Wednesday');
      // Chrome fires 'aborted' on a normal stop in some versions.
      r.emitError('aborted');
      r.emitEnd();
    });

    await waitFor(() => expect(transcript().value).toBe('New York Wednesday'));
    // No misleading error after a successful capture.
    expect(screen.queryByText(/Speech recognition failed/i)).toBeNull();
    expect(screen.queryByText(/Listening stopped before/i)).toBeNull();
  });

  it('no speech recognition is ever started without an explicit click', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptAiDisclosure(user);
    await user.type(transcript(), 'typing should never trigger the microphone');
    expect(FakeSpeechRecognition.instances).toHaveLength(0);
  });
});
