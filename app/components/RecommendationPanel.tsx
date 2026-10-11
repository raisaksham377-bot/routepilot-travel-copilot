'use client';

import { CONSTRAINT_LABELS } from '@/lib/schema/constraint';
import { formatCpp } from '@/lib/decision/rewards';
import type { DecisionResult } from '@/lib/decision/types';

/**
 * The recommendation, the refusals, and the reasoning.
 *
 * Every one of the engine's four outcomes renders something useful. A refusal
 * is a result, not an error state: "no option satisfies every requirement" with
 * the arithmetic of what would have to change is more valuable to an assistant
 * than a fabricated winner.
 */
export function RecommendationPanel({ result }: { result: DecisionResult }) {
  if (result.status === 'missing_required') {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <h3 className="font-medium">Not enough information yet</h3>
        <p style={{ color: 'var(--rp-muted)' }}>
          Nothing was guessed. These values are needed before anything can be ranked:
        </p>
        <ul className="list-disc pl-5">
          {result.needs.map((n, i) => (
            <li key={`${n.optionId ?? n.constraintKey}-${n.field}-${i}`}>{n.message}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (result.status === 'contradiction') {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <h3 className="font-medium">Two different answers for the same requirement</h3>
        <p style={{ color: 'var(--rp-muted)' }}>
          Both values are shown rather than one being picked for you.
        </p>
        {result.conflicts.map((c) => (
          <div key={c.constraintKey}>
            <div className="font-medium">{CONSTRAINT_LABELS[c.constraintKey]}</div>
            <ul className="list-disc pl-5">
              {c.values.map((v, i) => (
                <li key={i} className="rp-mono text-[13px]">
                  {JSON.stringify(v.value)}{' '}
                  <span style={{ color: 'var(--rp-muted)' }}>({v.source})</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }

  if (result.status === 'no_feasible_option') {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <h3 className="font-medium">No option satisfies every firm requirement</h3>
        <p style={{ color: 'var(--rp-muted)' }}>No winner has been invented.</p>

        {result.relaxation.singleConstraint.length > 0 ? (
          <>
            <h4 className="font-medium">What would have to change</h4>
            <ul className="list-disc pl-5">
              {result.relaxation.singleConstraint.map((s) => (
                <li key={`${s.constraint}-${s.viaOptionId}`}>{s.statement}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>
            No single-requirement change could be calculated exactly, so the options are listed
            with what each breaks.
          </p>
        )}

        {result.relaxation.candidates.length > 0 && (
          <>
            <h4 className="font-medium">What each option breaks</h4>
            <ul className="list-disc pl-5">
              {result.relaxation.candidates.map((c) => (
                <li key={c.optionId}>
                  <span className="font-medium">{c.optionId}</span> —{' '}
                  {c.violates.map((v) => CONSTRAINT_LABELS[v]).join(', ')}
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
          {result.relaxation.disclaimer}
        </p>
      </div>
    );
  }

  const { recommendation, trace } = result;
  const rewards = trace.rewards[recommendation.chosenOptionId];

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <h3 className="text-base font-semibold">Recommend {recommendation.chosenOptionId}</h3>
        {recommendation.provisional && (
          <p
            className="mt-1 rounded px-2 py-1 text-[13px]"
            style={{
              background: 'var(--rp-warn-bg)',
              border: '1px solid var(--rp-warn-border)',
            }}
          >
            Provisional — {recommendation.provisionalReason}
          </p>
        )}
      </div>

      <div>
        <h4 className="font-medium">Why</h4>
        <ul className="list-disc pl-5">
          {recommendation.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </div>

      {rewards?.applicable && (
        <div>
          <h4 className="font-medium">Points value</h4>
          {rewards.effectiveCpp === null ? (
            <p>
              Cannot be reliably calculated — {rewards.failedCheck ?? rewards.reason}.
            </p>
          ) : (
            <p>
              {formatCpp(rewards.effectiveCpp)} ={' '}
              <span className="rp-mono">
                ({rewards.inputs.comparableCashTicketTotal} − {rewards.inputs.awardCashCoPayment}) ÷{' '}
                {rewards.inputs.pointsRequired}
              </span>
              {rewards.valuationCpp !== null && (
                <>
                  {' '}
                  against your estimate of {rewards.valuationCpp}c.{' '}
                  {rewards.verdict === 'below_valuation' ? 'Below it.' : 'At or above it.'}
                </>
              )}
            </p>
          )}
          <p className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
            Your points valuation is an estimate of opportunity cost, not money paid. It is never
            added to a cash figure.
          </p>
        </div>
      )}

      <div>
        <h4 className="font-medium">Risks and limitations</h4>
        <ul className="list-disc pl-5">
          {recommendation.risks.length === 0 ? (
            <li>No connection findings were raised for this option.</li>
          ) : (
            recommendation.risks.map((r, i) => <li key={i}>{r}</li>)
          )}
          <li>
            This covers only the options recorded here. It is not a market search, and nothing was
            fetched live.
          </li>
        </ul>
      </div>

      <div>
        <h4 className="font-medium">Fallback</h4>
        {recommendation.fallback ? (
          <p>
            <span className="font-medium">{recommendation.fallback.optionId}</span> —{' '}
            {recommendation.fallback.triggerCondition}
          </p>
        ) : (
          <p>No second feasible option, so there is no fallback to name.</p>
        )}
      </div>

      <details>
        <summary className="cursor-pointer font-medium">Decision trace</summary>
        <div className="mt-2 flex flex-col gap-2 text-[12px]">
          <div>
            <span style={{ color: 'var(--rp-muted)' }}>comparators: </span>
            <span className="rp-mono">
              {trace.comparators.map((c) => `${c.measure} ${c.direction}`).join(' → ')}
            </span>
          </div>
          {trace.deadline.resolvedInstant && (
            <div>
              <span style={{ color: 'var(--rp-muted)' }}>deadline resolved: </span>
              <span className="rp-mono">{trace.deadline.resolvedInstant}</span>{' '}
              <span style={{ color: 'var(--rp-muted)' }}>({trace.deadline.zoneUsed})</span>
            </div>
          )}
          {trace.deadline.zoneNote && (
            <div style={{ color: 'var(--rp-muted)' }}>{trace.deadline.zoneNote}</div>
          )}
          <div>
            <span style={{ color: 'var(--rp-muted)' }}>pairwise decisions:</span>
            <ul className="list-disc pl-5">
              {trace.rankingDecisions.map((d, i) => (
                <li key={i} className="rp-mono">
                  {d.higherId} over {d.lowerId} — {d.decidedBy} {d.direction} ({d.higherValue} vs{' '}
                  {d.lowerValue})
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </div>
  );
}
