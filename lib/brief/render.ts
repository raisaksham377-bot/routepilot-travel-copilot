import type { TripState } from '../schema/tripState';
import { PRIORITY_RULE_LABELS, PRIORITY_RULE_EXPLANATIONS } from '../schema/tripState';
import { CONSTRAINT_LABELS } from '../schema/constraint';
import { CABIN_LABELS, optionDestination, optionOrigin } from '../schema/flightOption';
import { PROVENANCE_DESCRIPTIONS, PROVENANCE_LABELS } from '../schema/provenance';
import type { DecisionResult } from '../decision/types';
import { formatDuration, formatLocal } from '../decision/time';

/**
 * Renders the executive brief as Markdown, deterministically, from the trace.
 *
 * No model is involved in Checkpoint A: this is templated prose over computed
 * values. That is a feature rather than a placeholder -- it guarantees the brief
 * cannot introduce a reason that is not in the trace, which is the property the
 * whole "auditable decision record" idea rests on.
 *
 * Runs in the browser. Generating a brief posts nothing to any server.
 */

export const SAMPLE_DATA_NOTICE =
  'Nothing in this brief was fetched live. Prices and availability were not retrieved or ' +
  'verified by this application, and nothing here is bookable. Check every figure against the ' +
  'airline or your booking channel before acting.';

function provenanceSummary(state: TripState): string {
  const kinds = [...new Set(state.options.map((o) => o.provenance))].sort();
  const parts = kinds.map((k) => `${PROVENANCE_LABELS[k]} — ${PROVENANCE_DESCRIPTIONS[k]}`);
  return parts.join('\n')
}

function constraintLedgerSection(state: TripState): string {
  if (state.constraints.length === 0) return '_No constraints recorded._';
  const rows = state.constraints.map((c) => {
    const value =
      c.key === 'arrival_deadline'
        ? `${c.value.localDateTime} (${c.value.tz})`
        : String(c.value);
    return `| ${CONSTRAINT_LABELS[c.key]} | ${value} | ${c.kind} | ${c.source} |`;
  });
  return ['| Constraint | Value | Kind | Source |', '|---|---|---|---|', ...rows].join('\n');
}

export function renderBrief(state: TripState, result: DecisionResult): string {
  const header = [
    '# Executive travel decision brief',
    '',
    `**Priority applied:** ${PRIORITY_RULE_LABELS[state.priorityRule]} — ${PRIORITY_RULE_EXPLANATIONS[state.priorityRule]}`,
    '',
    `**Data provenance:** ${provenanceSummary(state)}`,
    '',
    `> ${SAMPLE_DATA_NOTICE}`,
    '',
  ].join('\n');

  if (result.status === 'missing_required') {
    return [
      header,
      '## No recommendation yet',
      '',
      'Required information is missing, so no option has been ranked. Nothing was guessed.',
      '',
      ...result.needs.map((n) => `- ${n.message}`),
      '',
      '## Constraints as recorded',
      '',
      constraintLedgerSection(state),
    ].join('\n');
  }

  if (result.status === 'contradiction') {
    return [
      header,
      '## No recommendation yet',
      '',
      'The same requirement has been given more than one value. The engine will not pick one for you.',
      '',
      ...result.conflicts.map(
        (c) =>
          `- ${c.message} Values seen: ${c.values
            .map((v) => `${JSON.stringify(v.value)} (${v.source})`)
            .join(' vs ')}`,
      ),
      '',
      '## Constraints as recorded',
      '',
      constraintLedgerSection(state),
    ].join('\n');
  }

  if (result.status === 'no_feasible_option') {
    const lines = [
      header,
      '## No option satisfies every requirement',
      '',
      'Every option breaks at least one requirement you marked as firm. No winner has been invented.',
      '',
      '### What each excluded option breaks',
      '',
    ];
    for (const ex of result.excluded) {
      lines.push(`**${ex.option.id}** — ${ex.option.carrier}, ${CABIN_LABELS[ex.option.cabin]}`);
      for (const r of ex.reasons) {
        lines.push(`- ${CONSTRAINT_LABELS[r.constraintKey]}: ${r.comparison}`);
      }
      lines.push('');
    }
    if (result.relaxation.singleConstraint.length > 0) {
      lines.push('### What would have to change', '');
      for (const s of result.relaxation.singleConstraint) {
        lines.push(`- ${s.statement}`);
      }
      lines.push('', `_${result.relaxation.disclaimer}_`, '');
    } else {
      lines.push(
        '### What would have to change',
        '',
        'No single-requirement change could be calculated exactly, so the options above are listed with what each breaks instead.',
        '',
        `_${result.relaxation.disclaimer}_`,
        '',
      );
    }
    lines.push('## Constraints as recorded', '', constraintLedgerSection(state));
    return lines.join('\n');
  }

  // status === 'ok'
  const { ranked, excluded, recommendation } = result;
  const top = ranked.find((r) => r.option.id === recommendation.chosenOptionId)!;
  const compared = ranked.slice(0, 3);

  const lines = [
    header,
    `## Recommendation: ${top.option.id}`,
    '',
    `${top.option.carrier} · ${CABIN_LABELS[top.option.cabin]} · ${optionOrigin(top.option)} → ${optionDestination(
      top.option,
    )}`,
    '',
    `Departs ${formatLocal(top.option.legs[0]!.departure, top.option.legs[0]!.departureTz)}`,
    `Arrives ${formatLocal(
      top.option.legs[top.option.legs.length - 1]!.arrival,
      top.option.legs[top.option.legs.length - 1]!.arrivalTz,
    )}`,
    '',
  ];

  if (recommendation.provisional) {
    lines.push(`> **Provisional.** ${recommendation.provisionalReason}`, '');
  }

  lines.push('### Why', '');
  for (const r of recommendation.reasons) lines.push(`- ${r}`);
  lines.push('');

  lines.push('### Compared options', '');
  lines.push(
    '| # | Option | Cash payable | Points | Spare time before commitment | Connection findings | Travel time |',
  );
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of compared) {
    lines.push(
      `| ${r.rank} | ${r.option.id} | ${r.measures.cashPayable ?? '—'} | ${
        r.measures.pointsRequired ?? '—'
      } | ${
        r.measures.arrivalMarginMinutes === null
          ? '—'
          : formatDuration(r.measures.arrivalMarginMinutes)
      } | ${r.measures.connectionRiskCount} | ${formatDuration(r.measures.travelDurationMinutes)} |`,
    );
  }
  lines.push('');

  /*
   * Findings on EVERY compared option, not just the recommended one.
   *
   * The table above reports a finding count per option. A bare count is the
   * kind of opacity this product exists to avoid: an assistant choosing between
   * these options needs to know what the finding on the runner-up actually is,
   * particularly since the fallback section may send them to it.
   */
  const othersWithFindings = compared.filter(
    (r) => r.option.id !== top.option.id && r.measures.connectionRisks.length > 0,
  );
  if (othersWithFindings.length > 0) {
    lines.push('### Connection findings on the other options', '');
    for (const r of othersWithFindings) {
      lines.push(`**${r.option.id}**`);
      for (const finding of r.measures.connectionRisks) {
        lines.push(`- ${finding.detail}`);
      }
      lines.push('');
    }
  }

  lines.push('### Risks and limitations', '');
  if (recommendation.risks.length === 0) {
    lines.push('- No connection findings were raised for the recommended option.');
  } else {
    for (const r of recommendation.risks) lines.push(`- ${r}`);
  }
  lines.push(
    '- This comparison covers only the options recorded here. It is not a market search.',
    '',
  );

  lines.push('### Fallback', '');
  if (recommendation.fallback) {
    lines.push(
      `**${recommendation.fallback.optionId}** — ${recommendation.fallback.triggerCondition}`,
    );
  } else {
    lines.push('No second feasible option is available, so there is no fallback to name.');
  }
  lines.push('');

  if (excluded.length > 0) {
    lines.push('### Excluded, and why', '');
    for (const ex of excluded) {
      const why = ex.reasons.map((r) => r.comparison).join('; ');
      lines.push(`- **${ex.option.id}** — ${why}`);
    }
    lines.push('');
  }

  lines.push('### Constraints as decided', '', constraintLedgerSection(state));

  return lines.join('\n');
}
