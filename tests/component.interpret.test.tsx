// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NaturalLanguageInput } from '@/app/components/NaturalLanguageInput';
import { applyProposedConstraint } from '@/lib/ai/applyProposal';
import { buildTripState } from '@/lib/data/build';
import { S2_NONSTOP } from '@/lib/data/scenarios';
import type { Constraint } from '@/lib/schema/constraint';
import type { TripState } from '@/lib/schema/tripState';
import {
  CABIN_PATCH,
  stubModelFailure,
  stubSuccessfulPatch,
  stubTransportFailure,
  stubUnavailable,
} from './helpers/mockInterpretFetch';

/**
 * Component-level tests against the REAL NaturalLanguageInput.
 *
 * These complement, rather than replace, the pure-function tests: those prove
 * the reducer's invariants hold for every action; these prove the rendered
 * interface actually wires a user's clicks to them. A reducer can be perfect
 * while the button that should dispatch to it is disabled, mislabelled, or
 * wired to nothing.
 *
 * Everything is driven through user-visible affordances -- label text, button
 * names, rendered values -- not component internals.
 */

const TYPED = 'Needs to be in New York by midday Wednesday, business class, from London.';

/**
 * A harness that mirrors how page.tsx wires the component: it owns TripState
 * and commits through the real applyProposedConstraint, returning the outcome.
 * This is the integration under test, not a reimplementation of it.
 */
function Harness({
  initialConstraints = [],
  onStateChange,
}: {
  initialConstraints?: Constraint[];
  onStateChange?: (s: TripState) => void;
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
  return <NaturalLanguageInput constraints={initialConstraints} onAccept={accept} />;
}

/** Clicks through the one-time AI disclosure so the input is reachable. */
async function acceptDisclosure(user: ReturnType<typeof userEvent.setup>) {
  const button = screen.queryByRole('button', { name: /enable AI interpretation/i });
  if (button !== null) await user.click(button);
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* jsdom always provides it, but never assume */
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the AI disclosure gates the input', () => {
  it('shows the disclosure before any input is available', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /enable AI interpretation/i })).toBeDefined();
    // The textarea must not exist yet.
    expect(screen.queryByLabelText(/Describe the trip in your own words/i)).toBeNull();
  });

  it('states what is sent and what is not', () => {
    render(<Harness />);
    // Queried by visible text rather than by role: the disclosure block has no
    // ARIA role, and adding one purely to make this query work would be
    // changing production markup to satisfy a test.
    expect(screen.getByText(/Before using AI interpretation/i)).toBeDefined();
    expect(screen.getByText(/the text you type/i)).toBeDefined();
    expect(screen.getByText(/Not sent:/i)).toBeDefined();
    // Names the specific things withheld, so the claim is checkable.
    const body = document.body.textContent ?? '';
    for (const withheld of ['profile', 'trip state', 'flight options', 'decision trace']) {
      expect(body.toLowerCase()).toContain(withheld);
    }
    expect(body).toMatch(/never their values/i);
  });

  it('reveals the input only after the user accepts', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptDisclosure(user);
    expect(screen.getByLabelText(/Describe the trip in your own words/i)).toBeDefined();
  });

  it('declining leaves the deterministic path reachable (no input, no error)', () => {
    render(<Harness />);
    // Simply not clicking is declining. Nothing breaks, nothing is sent.
    expect(screen.queryByRole('button', { name: /Interpret with AI/i })).toBeNull();
    expect(screen.getByText(/keep using the form below/i)).toBeDefined();
  });
});

describe('entering a request and seeing proposals', () => {
  it('submits the typed text and renders the proposed constraint', async () => {
    const user = userEvent.setup();
    const spy = stubSuccessfulPatch(CABIN_PATCH);
    render(<Harness />);
    await acceptDisclosure(user);

    await user.type(screen.getByLabelText(/Describe the trip in your own words/i), TYPED);
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));

    await waitFor(() => expect(screen.getByText(/Proposed constraints/i)).toBeDefined());

    // The user-visible proposal: label, value, and the evidence from their words.
    expect(screen.getByText('Cabin at least')).toBeDefined();
    expect(screen.getByText('business')).toBeDefined();
    expect(screen.getByText(/needs to work on the flight/i)).toBeDefined();
    // And it is labelled as inferred, not as something the user said.
    expect(screen.getByText(/inferred/i)).toBeDefined();

    // The request carried the typed text to the route.
    expect(spy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    expect(body.utterance).toBe(TYPED);
  });

  it('cannot submit before anything is typed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await acceptDisclosure(user);
    expect(screen.getByRole('button', { name: /Interpret with AI/i })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('explicit confirmation is required before anything is applied', () => {
  it('renders proposals WITHOUT applying them', async () => {
    const user = userEvent.setup();
    stubSuccessfulPatch(CABIN_PATCH);
    const changes: TripState[] = [];
    render(<Harness onStateChange={(s) => changes.push(s)} />);
    await acceptDisclosure(user);

    await user.type(screen.getByLabelText(/Describe the trip in your own words/i), TYPED);
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));
    await waitFor(() => expect(screen.getByText(/Proposed constraints/i)).toBeDefined());

    // THE ASSERTION: a visible proposal, and zero state changes.
    expect(screen.getByText('Cabin at least')).toBeDefined();
    expect(changes).toHaveLength(0);
    expect(screen.queryByText(/Added to the ledger/i)).toBeNull();

    // Both confirmation choices are offered, neither taken.
    expect(screen.getByRole('button', { name: /Add as preference/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Add as firm requirement/i })).toBeDefined();
  });

  it('applies as a preference only when that button is clicked', async () => {
    const user = userEvent.setup();
    stubSuccessfulPatch(CABIN_PATCH);
    const changes: TripState[] = [];
    render(<Harness onStateChange={(s) => changes.push(s)} />);
    await acceptDisclosure(user);
    await user.type(screen.getByLabelText(/Describe the trip in your own words/i), TYPED);
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));
    await waitFor(() => expect(screen.getByText(/Proposed constraints/i)).toBeDefined());

    await user.click(screen.getByRole('button', { name: /Add as preference/i }));

    await waitFor(() => expect(screen.getByText(/Added to the ledger/i)).toBeDefined());
    expect(changes).toHaveLength(1);
    const added = changes[0]!.constraints.find((c) => c.key === 'cabin_floor')!;
    expect(added.kind).toBe('soft');
    // Ownership transfers to the user on acceptance.
    expect(added.source).toBe('user-edited');
  });

  it('applies as a firm requirement only when THAT button is clicked', async () => {
    const user = userEvent.setup();
    stubSuccessfulPatch(CABIN_PATCH);
    const changes: TripState[] = [];
    render(<Harness onStateChange={(s) => changes.push(s)} />);
    await acceptDisclosure(user);
    await user.type(screen.getByLabelText(/Describe the trip in your own words/i), TYPED);
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));
    await waitFor(() => expect(screen.getByText(/Proposed constraints/i)).toBeDefined());

    await user.click(screen.getByRole('button', { name: /Add as firm requirement/i }));

    await waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]!.constraints.find((c) => c.key === 'cabin_floor')!.kind).toBe('hard');
  });

  it('the confirmation buttons disappear once applied, so it cannot be double-applied', async () => {
    const user = userEvent.setup();
    stubSuccessfulPatch(CABIN_PATCH);
    render(<Harness />);
    await acceptDisclosure(user);
    await user.type(screen.getByLabelText(/Describe the trip in your own words/i), TYPED);
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));
    await waitFor(() => expect(screen.getByText(/Proposed constraints/i)).toBeDefined());
    await user.click(screen.getByRole('button', { name: /Add as preference/i }));

    await waitFor(() => expect(screen.getByText(/Added to the ledger/i)).toBeDefined());
    expect(screen.queryByRole('button', { name: /Add as preference/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add as firm requirement/i })).toBeNull();
  });
});

describe('failures preserve the typed text and change nothing', () => {
  const failures = [
    ['timeout', 'The interpretation request timed out. Nothing has been changed.'],
    ['malformed_output', 'The model returned something this app could not validate.'],
    ['refusal', 'The model declined to process that request. Nothing has been changed.'],
    ['model_unavailable', 'The configured model is not available to this account.'],
  ] as const;

  it.each(failures)('%s keeps the text and applies nothing', async (kind, message) => {
    const user = userEvent.setup();
    stubModelFailure(kind, message);
    const changes: TripState[] = [];
    render(<Harness onStateChange={(s) => changes.push(s)} />);
    await acceptDisclosure(user);

    const textarea = screen.getByLabelText(/Describe the trip in your own words/i);
    await user.type(textarea, TYPED);
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));

    await waitFor(() => expect(screen.getByText(new RegExp(message.slice(0, 30), 'i'))).toBeDefined());

    // THE ASSERTION: the text is still there, verbatim.
    expect((textarea as HTMLTextAreaElement).value).toBe(TYPED);
    expect(changes).toHaveLength(0);
    expect(screen.queryByText(/Proposed constraints/i)).toBeNull();
    // And the user can retry without retyping.
    expect(screen.getByRole('button', { name: /Interpret with AI/i })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('a dropped connection keeps the text and says so', async () => {
    const user = userEvent.setup();
    stubTransportFailure();
    render(<Harness />);
    await acceptDisclosure(user);

    const textarea = screen.getByLabelText(/Describe the trip in your own words/i);
    await user.type(textarea, TYPED);
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));

    await waitFor(() =>
      expect(screen.getByText(/Could not reach the interpretation endpoint/i)).toBeDefined(),
    );
    expect((textarea as HTMLTextAreaElement).value).toBe(TYPED);
    expect(screen.getByText(/Your text is preserved/i)).toBeDefined();
  });

  it('an unavailable endpoint keeps the text and points at the deterministic path', async () => {
    const user = userEvent.setup();
    stubUnavailable(
      'no_credentials',
      'AI interpretation is enabled but no Anthropic credential is configured on the server. Enter trip details using the form instead.',
    );
    render(<Harness />);
    await acceptDisclosure(user);

    const textarea = screen.getByLabelText(/Describe the trip in your own words/i);
    await user.type(textarea, TYPED);
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));

    await waitFor(() => expect(screen.getByText(/no Anthropic credential/i)).toBeDefined());
    expect((textarea as HTMLTextAreaElement).value).toBe(TYPED);
    expect(
      screen.getByText(/deterministic engine, the seeded scenarios and manual entry/i),
    ).toBeDefined();
  });
});

describe('no real network request occurs', () => {
  it('every interaction goes through the stubbed fetch only', async () => {
    const user = userEvent.setup();
    const spy = stubSuccessfulPatch(CABIN_PATCH);
    render(<Harness />);
    await acceptDisclosure(user);
    await user.type(screen.getByLabelText(/Describe the trip in your own words/i), TYPED);
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));
    await waitFor(() => expect(screen.getByText(/Proposed constraints/i)).toBeDefined());

    // Only our stub was called, and only with the app's own relative route.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe('/api/interpret');
  });

  it('without a stub, the network guard blocks the request rather than letting it out', async () => {
    const user = userEvent.setup();
    // No stub installed: the guard from setup.no-network.ts is in force.
    render(<Harness />);
    await acceptDisclosure(user);
    await user.type(screen.getByLabelText(/Describe the trip in your own words/i), TYPED);
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));

    // The component treats it as a transport failure -- it never reaches a server.
    await waitFor(() =>
      expect(screen.getByText(/Could not reach the interpretation endpoint/i)).toBeDefined(),
    );
  });
});
