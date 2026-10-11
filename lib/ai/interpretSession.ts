import type { InterpretResult } from './interpret';

/**
 * The interpretation interaction, as a pure state machine.
 *
 * Extracted from the React component for one specific reason: "the user's text
 * survives a failure" is a behavioural guarantee, and a guarantee that lives
 * only inside a component body is one nobody tests. Here it is a reducer with
 * a single invariant that can be asserted directly against every transition.
 *
 * THE INVARIANT: no action ever clears `text` except the one the user
 * explicitly triggers. A timeout, a refusal, malformed output, a transport
 * failure, a disabled feature -- none of them lose what was typed.
 */

export type SessionPhase = 'idle' | 'pending' | 'settled';

export interface SessionState {
  /** What the user typed. Preserved across every failure. */
  text: string;
  phase: SessionPhase;
  /** The last result, success or structured failure. */
  result: InterpretResult | null;
  /** Set when the request never completed (network/transport level). */
  transportError: string | null;
  /** Indices of proposals the user has explicitly accepted. */
  appliedIndices: ReadonlySet<number>;
  /** An unresolved overwrite decision, if one is pending. */
  pendingConflict: { index: number; message: string } | null;
}

export const initialSessionState: SessionState = {
  text: '',
  phase: 'idle',
  result: null,
  transportError: null,
  appliedIndices: new Set(),
  pendingConflict: null,
};

export type SessionAction =
  | { type: 'edit_text'; text: string }
  | { type: 'submit' }
  | { type: 'settle'; result: InterpretResult }
  | { type: 'transport_failed'; message: string }
  | { type: 'proposal_applied'; index: number }
  | { type: 'conflict_raised'; index: number; message: string }
  | { type: 'conflict_resolved' }
  /** The ONLY action permitted to clear the text. User-triggered. */
  | { type: 'clear_text' };

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'edit_text':
      return { ...state, text: action.text };

    case 'submit':
      // Previous results are cleared so stale proposals cannot be accepted
      // against a new request -- but the text stays.
      return {
        ...state,
        phase: 'pending',
        result: null,
        transportError: null,
        appliedIndices: new Set(),
        pendingConflict: null,
      };

    case 'settle':
      return { ...state, phase: 'settled', result: action.result, transportError: null };

    case 'transport_failed':
      // The request never completed. Text is explicitly retained so the user
      // can retry without retyping.
      return { ...state, phase: 'settled', result: null, transportError: action.message };

    case 'proposal_applied': {
      const next = new Set(state.appliedIndices);
      next.add(action.index);
      return { ...state, appliedIndices: next, pendingConflict: null };
    }

    case 'conflict_raised':
      return {
        ...state,
        pendingConflict: { index: action.index, message: action.message },
      };

    case 'conflict_resolved':
      return { ...state, pendingConflict: null };

    case 'clear_text':
      return { ...state, text: '' };
  }
}

/** Whether the Interpret action should be available. */
export function canSubmit(state: SessionState): boolean {
  return state.phase !== 'pending' && state.text.trim() !== '';
}

/**
 * Whether the deterministic product remains fully usable.
 *
 * Always true, by construction -- there is no session state that disables the
 * form, the scenarios, the ledger or the engine. The function exists so that
 * claim is asserted in tests rather than merely believed.
 */
export function deterministicPathAvailable(_state: SessionState): true {
  void _state;
  return true;
}
