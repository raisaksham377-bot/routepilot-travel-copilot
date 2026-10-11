'use client';

import { CABIN_LABELS, optionDestination, optionOrigin } from '@/lib/schema/flightOption';
import { CONSTRAINT_LABELS } from '@/lib/schema/constraint';
import { formatDuration, formatLocal } from '@/lib/decision/time';
import type { DecisionResult, ExcludedOption, Measures, RankedOption } from '@/lib/decision/types';
import { ProvenanceBadge } from './ProvenanceBanner';

function MeasureCells({ m }: { m: Measures }) {
  return (
    <>
      <td className="px-2 py-1 text-right rp-mono">{m.cashPayable ?? '—'}</td>
      <td className="px-2 py-1 text-right rp-mono">{m.pointsRequired ?? '—'}</td>
      <td className="px-2 py-1 text-right rp-mono">
        {m.arrivalMarginMinutes === null ? '—' : formatDuration(m.arrivalMarginMinutes)}
      </td>
      <td className="px-2 py-1 text-right rp-mono">{m.connectionRiskCount}</td>
      <td className="px-2 py-1 text-right rp-mono">{formatDuration(m.travelDurationMinutes)}</td>
    </>
  );
}

function RankedRow({ r, onRemove }: { r: RankedOption; onRemove: (id: string) => void }) {
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--rp-border)' }}>
        <td className="px-2 py-1 rp-mono">{r.rank}</td>
        <td className="px-2 py-1">
          <span className="font-medium">{r.option.id}</span>{' '}
          <ProvenanceBadge provenance={r.option.provenance} />
          <div className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
            {r.option.carrier} · {CABIN_LABELS[r.option.cabin]} · {optionOrigin(r.option)}→
            {optionDestination(r.option)}
            {r.measures.isStale && ' · stale'}
          </div>
        </td>
        <MeasureCells m={r.measures} />
        <td className="px-2 py-1 text-right">
          <button type="button" className="rp-btn-secondary" onClick={() => onRemove(r.option.id)}>
            ×
          </button>
        </td>
      </tr>
      {r.measures.connectionRisks.length > 0 && (
        <tr>
          <td />
          <td colSpan={7} className="px-2 pb-1.5 text-[11px]" style={{ color: 'var(--rp-muted)' }}>
            {r.measures.connectionRisks.map((risk) => (
              <div key={risk.code}>• {risk.detail}</div>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

function ExcludedRow({ e, onRemove }: { e: ExcludedOption; onRemove: (id: string) => void }) {
  return (
    <tr
      style={{
        borderTop: '1px solid var(--rp-excluded-border)',
        background: 'var(--rp-excluded-bg)',
      }}
    >
      <td className="px-2 py-1 rp-mono">—</td>
      <td className="px-2 py-1">
        <span className="font-medium line-through">{e.option.id}</span>{' '}
        <ProvenanceBadge provenance={e.option.provenance} />
        <div className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
          {e.reasons.map((r) => (
            <div key={r.constraintKey}>
              excluded — {CONSTRAINT_LABELS[r.constraintKey]}: {r.comparison}
            </div>
          ))}
        </div>
      </td>
      <MeasureCells m={e.measures} />
      <td className="px-2 py-1 text-right">
        <button type="button" className="rp-btn-secondary" onClick={() => onRemove(e.option.id)}>
          ×
        </button>
      </td>
    </tr>
  );
}

/**
 * The options panel.
 *
 * Excluded options are shown in their own band rather than at the bottom of the
 * ranking, because they were never ranked -- the feasibility gate removes them
 * from the ranked set entirely. Showing them greyed out at position 4 would
 * imply they merely scored badly.
 */
export function OptionsPanel({
  result,
  onRemove,
}: {
  result: DecisionResult;
  onRemove: (id: string) => void;
}) {
  const ranked = result.status === 'ok' ? result.ranked : [];
  const excluded =
    result.status === 'ok' || result.status === 'no_feasible_option' ? result.excluded : [];

  if (ranked.length === 0 && excluded.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--rp-muted)' }}>
        No options yet. Load a scenario, or add one by hand below.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px]" style={{ color: 'var(--rp-muted)' }}>
            <th className="px-2 py-1">#</th>
            <th className="px-2 py-1">Option</th>
            <th className="px-2 py-1 text-right">Cash payable</th>
            <th className="px-2 py-1 text-right">Points</th>
            <th className="px-2 py-1 text-right">Spare time</th>
            <th className="px-2 py-1 text-right">Findings</th>
            <th className="px-2 py-1 text-right">Travel time</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ranked.map((r) => (
            <RankedRow key={r.option.id} r={r} onRemove={onRemove} />
          ))}
          {excluded.length > 0 && (
            <tr>
              <td
                colSpan={8}
                className="px-2 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide"
                style={{ color: 'var(--rp-muted)' }}
              >
                Excluded — never ranked, not merely ranked last
              </td>
            </tr>
          )}
          {excluded.map((e) => (
            <ExcludedRow key={e.option.id} e={e} onRemove={onRemove} />
          ))}
        </tbody>
      </table>

      {ranked.length > 0 && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--rp-muted)' }}>
          Captured {formatLocal(ranked[0]!.option.asOf, 'UTC')} — not refreshed since.
        </p>
      )}
    </div>
  );
}
