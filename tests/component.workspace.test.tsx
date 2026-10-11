// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Page from '@/app/page';
import { stubSuccessfulPatch, stubUnavailable } from './helpers/mockInterpretFetch';

/**
 * Tests against the REAL workspace page.
 *
 * This is the integration that matters: `page.tsx` owns TripState and commits
 * through `applyProposedConstraint`, while `NaturalLanguageInput` renders the
 * proposals and the conflict prompt. Testing them together is what proves the
 * conflict path actually reaches the user, rather than existing only as a
 * return value nobody renders.
 *
 * Everything is driven through user-visible affordances.
 */

const TYPED = 'Should land by early evening on the 4th.';

/**
 * Scopes a query to one workspace panel.
 *
 * Necessary because a constraint value legitimately appears TWICE once a
 * proposal is on screen: in the proposal row, and in the ledger. An unscoped
 * `getByText` matches both and throws, and asserting "this value is nowhere"
 * would be wrong -- a declined proposal is still listed, it just is not
 * applied. The meaningful question is always "is it in the LEDGER", so the
 * query has to say which panel it means.
 */
function panel(title: RegExp | string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name: title });
  const section = heading.closest('section');
  if (section === null) throw new Error(`No panel section found for ${String(title)}`);
  return section as HTMLElement;
}

const ledger = () => panel(/^Constraints$/i);
const recommendation = () => panel(/^Recommendation$/i);
const proposals = () => panel(/Describe the trip/i);

async function acceptDisclosure(user: ReturnType<typeof userEvent.setup>) {
  const button = screen.queryByRole('button', { name: /enable AI interpretation/i });
  if (button !== null) await user.click(button);
}

/**
 * Loads scenario S1, which seeds a STATED 18:00 deadline plus four options.
 *
 * Queried by exact text: the scenario buttons render their id ("S1") as their
 * content, and the descriptive sentence is only a `title` attribute. Text
 * content wins the accessible-name computation, so `name: 'S1'` is the handle.
 */
async function loadScenarioS1(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'S1' }));
  // Confirm it loaded before any assertion depends on it.
  expect(screen.getByText(/cheapest option misses the arrival deadline/i)).toBeDefined();
}

beforeEach(() => {
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

describe('a proposal conflicting with a human-authored constraint', () => {
  /**
   * S1 seeds `arrival_deadline` = 18:00 America/New_York with source 'stated'.
   * The stubbed model proposes the same key with a DIFFERENT local time, so
   * accepting it would overwrite something the human supplied.
   */
  it('shows BOTH values and demands an explicit choice', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await loadScenarioS1(user);

    // Replace the seeded 18:00 with a noon deadline so the proposal differs.
    // Done through the UI's own affordances: the ledger shows the stated value.
    expect(screen.getByText(/2026-11-04 18:00 \(America\/New_York\)/)).toBeDefined();

    stubSuccessfulPatch({
      proposals: [
        {
          key: 'arrival_deadline',
          rawValue: '2026-11-04T11:30',
          timezone: 'America/New_York',
          suggestedKind: 'hard',
          confidence: 0.6,
          evidence: 'wants to land before lunch',
        },
      ],
      clarifyingQuestions: [],
      unmapped: [],
    });

    await acceptDisclosure(user);
    await user.type(screen.getByLabelText(/Describe the trip in your own words/i), TYPED);
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));
    await waitFor(() => expect(screen.getByText(/Proposed constraints/i)).toBeDefined());

    await user.click(screen.getByRole('button', { name: /Add as firm requirement/i }));

    // THE ASSERTION: a conflict prompt naming both values, and no application.
    await waitFor(() => expect(screen.getByText(/You already set this to/i)).toBeDefined());
    const prompt = screen.getByText(/You already set this to/i);
    expect(prompt.textContent).toContain('2026-11-04T18:00'); // the human's value
    expect(prompt.textContent).toContain('2026-11-04T11:30'); // the suggestion
    expect(prompt.textContent).toMatch(/stated/);

    // Both choices offered; neither taken.
    expect(screen.getByRole('button', { name: /Keep mine/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Replace with the suggestion/i })).toBeDefined();
    expect(screen.queryByText(/Added to the ledger/i)).toBeNull();

    // The ledger still shows the human's original value, untouched.
    expect(screen.getByText(/2026-11-04 18:00 \(America\/New_York\)/)).toBeDefined();
  });

  it('"Keep mine" preserves the existing constraint', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await loadScenarioS1(user);

    stubSuccessfulPatch({
      proposals: [
        {
          key: 'arrival_deadline',
          rawValue: '2026-11-04T11:30',
          timezone: 'America/New_York',
          suggestedKind: 'hard',
          confidence: 0.6,
          evidence: 'before lunch',
        },
      ],
      clarifyingQuestions: [],
      unmapped: [],
    });

    await acceptDisclosure(user);
    await user.type(screen.getByLabelText(/Describe the trip in your own words/i), TYPED);
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));
    await waitFor(() => expect(screen.getByText(/Proposed constraints/i)).toBeDefined());
    await user.click(screen.getByRole('button', { name: /Add as firm requirement/i }));
    await waitFor(() => expect(screen.getByText(/You already set this to/i)).toBeDefined());

    await user.click(screen.getByRole('button', { name: /Keep mine/i }));

    // The prompt closes and nothing was applied.
    await waitFor(() => expect(screen.queryByText(/You already set this to/i)).toBeNull());
    expect(screen.queryByText(/Added to the ledger/i)).toBeNull();

    // THE ASSERTION, scoped to the LEDGER: the human's value survives and the
    // suggestion did not land. (The suggestion is still *listed* as an
    // unapplied proposal, which is correct -- hence the scoping.)
    expect(within(ledger()).getByText(/2026-11-04 18:00 \(America\/New_York\)/)).toBeDefined();
    expect(within(ledger()).queryByText(/11:30/)).toBeNull();
    // Still attributed to the human, not rewritten to user-edited by a decline.
    expect(within(ledger()).getByText(/source: stated/i)).toBeDefined();
  });

  it('"Replace with the suggestion" updates it deliberately', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await loadScenarioS1(user);

    stubSuccessfulPatch({
      proposals: [
        {
          key: 'arrival_deadline',
          rawValue: '2026-11-04T11:30',
          timezone: 'America/New_York',
          suggestedKind: 'hard',
          confidence: 0.6,
          evidence: 'before lunch',
        },
      ],
      clarifyingQuestions: [],
      unmapped: [],
    });

    await acceptDisclosure(user);
    await user.type(screen.getByLabelText(/Describe the trip in your own words/i), TYPED);
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));
    await waitFor(() => expect(screen.getByText(/Proposed constraints/i)).toBeDefined());
    await user.click(screen.getByRole('button', { name: /Add as firm requirement/i }));
    await waitFor(() => expect(screen.getByText(/You already set this to/i)).toBeDefined());

    await user.click(screen.getByRole('button', { name: /Replace with the suggestion/i }));

    // Scoped to the LEDGER: the new value is in, the old one is gone.
    await waitFor(() =>
      expect(within(ledger()).getByText(/2026-11-04 11:30 \(America\/New_York\)/)).toBeDefined(),
    );
    expect(within(ledger()).queryByText(/18:00/)).toBeNull();
    expect(within(proposals()).getByText(/Added to the ledger/i)).toBeDefined();
    // Ownership transferred: the user made this call, not the model.
    expect(within(ledger()).getByText(/source: user-edited/i)).toBeDefined();
  });

  it('a proposal for a NEW key applies without any conflict prompt', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await loadScenarioS1(user);

    // cabin_floor is not seeded by S1, so there is nothing to overwrite.
    stubSuccessfulPatch({
      proposals: [
        {
          key: 'cabin_floor',
          rawValue: 'business',
          timezone: null,
          suggestedKind: 'soft',
          confidence: 0.9,
          evidence: 'needs to work onboard',
        },
      ],
      clarifyingQuestions: [],
      unmapped: [],
    });

    await acceptDisclosure(user);
    await user.type(screen.getByLabelText(/Describe the trip in your own words/i), TYPED);
    await user.click(screen.getByRole('button', { name: /Interpret with AI/i }));
    await waitFor(() => expect(screen.getByText(/Proposed constraints/i)).toBeDefined());
    await user.click(screen.getByRole('button', { name: /Add as preference/i }));

    await waitFor(() => expect(screen.getByText(/Added to the ledger/i)).toBeDefined());
    // No conflict prompt, because there was nothing of the user's to overwrite.
    expect(screen.queryByText(/You already set this to/i)).toBeNull();
    // It landed in the ledger, alongside the deadline S1 already seeded.
    expect(within(ledger()).getByText('Cabin at least')).toBeDefined();
    expect(within(ledger()).getByText('Must arrive by')).toBeDefined();
  });
});

describe('the deterministic workflow when AI is unavailable', () => {
  it('ranks, excludes and recommends with the AI endpoint returning 503', async () => {
    const user = userEvent.setup();
    stubUnavailable(
      'feature_disabled',
      'AI interpretation is switched off for this deployment. Enter trip details using the form, or set AI_FEATURES_ENABLED=true locally.',
    );
    render(<Page />);
    await loadScenarioS1(user);

    // The engine ran entirely in the browser: A, C, B ranked and D excluded.
    const options = screen.getByRole('table');
    expect(within(options).getByText('A')).toBeDefined();
    expect(within(options).getByText('C')).toBeDefined();
    expect(within(options).getByText('B')).toBeDefined();
    expect(screen.getByText(/Excluded — never ranked, not merely ranked last/i)).toBeDefined();

    // And a full recommendation is produced, with its reasoning.
    expect(within(recommendation()).getByRole('heading', { name: /Recommend A/i })).toBeDefined();
    expect(within(recommendation()).getByText(/Beat C on arrivalMarginMinutes/i)).toBeDefined();
    // Queried as headings: a bare text match also hits the wrapping div whose
    // textContent contains the same string, which is ambiguous by definition.
    const panelRec = within(recommendation());
    expect(panelRec.getByRole('heading', { name: 'Why' })).toBeDefined();
    expect(panelRec.getByRole('heading', { name: 'Risks and limitations' })).toBeDefined();
    expect(panelRec.getByRole('heading', { name: 'Fallback' })).toBeDefined();
    /*
     * The fallback names a specific option and its trigger condition.
     *
     * Asserted against the panel's textContent rather than with getByText,
     * because the markup splits it across a <span> and a text node. And note
     * the condition: option A carries connection findings, so the engine emits
     * the DISRUPTION trigger, not the generic availability one.
     */
    expect(recommendation().textContent).toMatch(/flagged connection on A is disrupted/i);
    expect(recommendation().textContent).toMatch(/\bB\b/); // the named fallback option
  });

  it('switching the priority rule re-ranks, with no AI involvement at all', async () => {
    const user = userEvent.setup();
    const spy = stubUnavailable('feature_disabled', 'off');
    render(<Page />);
    await loadScenarioS1(user);

    expect(screen.getByRole('heading', { name: /Recommend A/i })).toBeDefined();

    await user.click(screen.getByRole('button', { name: /Lowest cash outlay/i }));

    // C is cheapest of the feasible three, so it becomes the recommendation.
    await waitFor(() => expect(screen.getByRole('heading', { name: /Recommend C/i })).toBeDefined());

    // Decisive: the whole re-ranking happened without one request.
    expect(spy).not.toHaveBeenCalled();
  });

  it('the brief is generated locally, with no request', async () => {
    const user = userEvent.setup();
    const spy = stubUnavailable('feature_disabled', 'off');
    render(<Page />);
    await loadScenarioS1(user);

    const brief = screen.getByLabelText(/Executive brief as Markdown/i) as HTMLTextAreaElement;
    expect(brief.value).toContain('Recommendation: A');
    expect(brief.value).toContain('Nothing in this brief was fetched live');
    expect(spy).not.toHaveBeenCalled();
  });

  it('manual option entry remains available and needs no AI', async () => {
    const user = userEvent.setup();
    const spy = stubUnavailable('feature_disabled', 'off');
    render(<Page />);

    expect(screen.getByRole('button', { name: /Add this option/i })).toBeDefined();
    expect(screen.getByPlaceholderText(/BA117/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: /Add this option/i }));
    // Validation errors are produced locally, with no request.
    await waitFor(() => expect(screen.getByText(/Give the option a short label/i)).toBeDefined());
    expect(spy).not.toHaveBeenCalled();
  });

  it('the deterministic panels render before the AI disclosure is ever accepted', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await loadScenarioS1(user);

    // The disclosure is still pending -- AI has never been enabled.
    expect(screen.getByRole('button', { name: /enable AI interpretation/i })).toBeDefined();
    // Yet the full deterministic workflow is already on screen.
    expect(screen.getByRole('heading', { name: /Recommend A/i })).toBeDefined();
    expect(screen.getByText('Must arrive by')).toBeDefined();
  });
});
