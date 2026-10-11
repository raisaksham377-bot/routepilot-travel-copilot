'use client';

import { CONSTRAINT_LABELS, type Constraint } from '@/lib/schema/constraint';

/**
 * The editable constraint ledger.
 *
 * Every constraint shows its value, whether it is firm or a preference, and
 * where it came from. An `inferred` value is rendered distinctly and is never
 * silently treated as firm -- the user can see what the app assumed and
 * override it, which is the point of having a ledger rather than a hidden state
 * blob.
 */
export function ConstraintLedger({
  constraints,
  onChangeKind,
  onRemove,
}: {
  constraints: Constraint[];
  onChangeKind: (index: number, kind: 'hard' | 'soft') => void;
  onRemove: (index: number) => void;
}) {
  if (constraints.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--rp-muted)' }}>
        No constraints yet. Load a scenario to see a worked example.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {constraints.map((c, i) => {
        const value =
          c.key === 'arrival_deadline'
            ? `${c.value.localDateTime.replace('T', ' ')} (${c.value.tz})`
            : String(c.value);
        const inferred = c.source === 'inferred';

        return (
          <li
            key={`${c.key}-${i}`}
            className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-sm"
            style={{
              border: `1px ${inferred ? 'dashed' : 'solid'} var(--rp-border)`,
              background: 'var(--rp-surface)',
            }}
          >
            <span className="font-medium">{CONSTRAINT_LABELS[c.key]}</span>
            <span className="rp-mono">{value}</span>

            <span className="ml-auto flex items-center gap-1">
              <button
                type="button"
                className="rp-btn-secondary"
                aria-pressed={c.kind === 'hard'}
                onClick={() => onChangeKind(i, 'hard')}
                title="Firm: options breaking this are excluded"
              >
                Firm
              </button>
              <button
                type="button"
                className="rp-btn-secondary"
                aria-pressed={c.kind === 'soft'}
                onClick={() => onChangeKind(i, 'soft')}
                title="Preference: informs ranking, does not exclude"
              >
                Preference
              </button>
              <button
                type="button"
                className="rp-btn-secondary"
                onClick={() => onRemove(i)}
                aria-label={`Remove ${CONSTRAINT_LABELS[c.key]}`}
              >
                ×
              </button>
            </span>

            <span className="w-full text-[11px]" style={{ color: 'var(--rp-muted)' }}>
              source: {c.source}
              {inferred && ' — inferred, not stated by you. Check it.'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
