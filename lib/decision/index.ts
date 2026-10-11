import type { TripState } from '../schema/tripState';
import { findConstraint } from '../schema/constraint';
import { optionArrival } from '../schema/flightOption';
import { CONSTRAINT_LABELS } from '../schema/constraint';
import { PRIORITY_RULE_LABELS } from '../schema/tripState';
import { computeMeasures } from './measures';
import { evaluateFeasibility } from './feasibility';
import { PRIORITY_RULES, rankOptions } from './priority';
import { assessRewards } from './rewards';
import { buildRelaxationReport } from './relax';
import { resolveDeadlineInstant, formatDuration } from './time';
import type {
  Conflict,
  DecisionResult,
  DecisionTrace,
  ExcludedOption,
  Measures,
  Need,
  RankedOption,
  Recommendation,
  RewardsAssessment,
} from './types';

export * from './types';
export { PRIORITY_RULES, measureValue } from './priority';
export { cashPayable, connectionRisks } from './measures';
export { assessRewards, findCashCounterpart, formatCpp } from './rewards';
export { RELAXATION_DISCLAIMER } from './relax';
export * from './time';

/**
 * The decision engine.
 *
 * Pure: no clock access, no randomness, no network, no filesystem. `evaluatedAt`
 * is supplied by the caller rather than read from `Date.now()`, which is what
 * makes a serialised trace byte-reproducible and therefore worth auditing.
 *
 * Runs in the browser. The UI imports this module directly -- there is no API
 * route for it -- so with AI features off, trip data never leaves the device.
 */
export function decide(state: TripState): DecisionResult {
  const { options, constraints, profile, priorityRule } = state;
  const evaluatedAt = state.asOf;

  // ---- Deadline resolution (in the DESTINATION zone, never the origin's) ----
  const deadlineConstraint = findConstraint(constraints, 'arrival_deadline');
  let deadlineInstant: string | null = null;
  let zoneUsed: string | null = null;
  let zoneNote: string | null = null;
  const needs: Need[] = [];

  if (deadlineConstraint) {
    const resolved = resolveDeadlineInstant(deadlineConstraint.value);
    if (resolved.ok) {
      deadlineInstant = resolved.instant;
      zoneUsed = resolved.zoneUsed;
      const arrivalZones = new Set(options.map((o) => optionArrival(o).tz));
      if (arrivalZones.size === 1 && !arrivalZones.has(resolved.zoneUsed)) {
        zoneNote =
          `Deadline interpreted in ${resolved.zoneUsed}; the itineraries arrive in ` +
          `${[...arrivalZones][0]}. Check this is intended.`;
      }
    } else {
      needs.push({
        constraintKey: 'arrival_deadline',
        optionId: null,
        field: resolved.reason === 'invalid_zone' ? 'tz' : 'localDateTime',
        message:
          resolved.reason === 'invalid_zone'
            ? 'The arrival deadline names a timezone this system does not recognise. Pick a valid IANA zone such as America/New_York.'
            : 'The arrival deadline is not a complete date and time. Supply both, so it can be resolved to an actual moment.',
      });
    }
  }

  // ---- Measures, computed before anything is eliminated ----
  const measures: Record<string, Measures> = {};
  for (const option of options) {
    measures[option.id] = computeMeasures({
      option,
      constraints,
      profile,
      deadlineInstant,
      evaluatedAt,
      stalenessThresholdMinutes: state.stalenessThresholdMinutes,
    });
  }

  // ---- Contradictions: the same constraint stated twice with different values ----
  const conflicts: Conflict[] = [];
  const byKey = new Map<string, typeof constraints>();
  for (const c of constraints) {
    byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
  }
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const distinct = new Set(group.map((g) => JSON.stringify(g.value)));
    if (distinct.size > 1) {
      conflicts.push({
        constraintKey: key as Conflict['constraintKey'],
        values: group.map((g) => ({ value: g.value, source: g.source, note: g.note })),
        message: `"${CONSTRAINT_LABELS[key as Conflict['constraintKey']]}" has been given more than one value. Resolve it before a recommendation can be made.`,
      });
    }
  }

  // ---- Missing data on options that would be ranked ----
  for (const option of options) {
    const m = measures[option.id]!;
    if (deadlineConstraint && deadlineInstant !== null && m.arrivalMarginMinutes === null) {
      needs.push({
        constraintKey: null,
        optionId: option.id,
        field: 'arrival',
        message: `${option.id} does not have a resolvable arrival time, so it cannot be measured against the deadline.`,
      });
    }
    if (m.cashPayable === null) {
      needs.push({
        constraintKey: null,
        optionId: option.id,
        field: option.paymentKind === 'award' ? 'awardCashCoPayment' : 'comparableCashTicketTotal',
        message:
          option.paymentKind === 'award'
            ? `${option.id} is an award booking but does not say what cash is still payable. Enter the co-payment (0 if genuinely none), or remove the option.`
            : `${option.id} is missing its cash ticket total, so it cannot be compared. Enter it, or remove the option.`,
      });
    }
    if (option.paymentKind === 'award' && option.pointsRequired === null) {
      needs.push({
        constraintKey: null,
        optionId: option.id,
        field: 'pointsRequired',
        message: `${option.id} is an award booking but does not say how many points it costs.`,
      });
    }
  }

  // ---- Rewards (optional module) ----
  const rewards: Record<string, RewardsAssessment> = {};
  for (const option of options) {
    rewards[option.id] = assessRewards({
      option,
      allOptions: options,
      profile,
      moduleEnabled: state.rewardsModuleEnabled,
    });
  }

  const baseTrace = (): DecisionTrace => ({
    schemaVersion: 1,
    evaluatedAt,
    priorityRule,
    comparators: [...PRIORITY_RULES[priorityRule]],
    deadline: {
      stated: deadlineConstraint ? { ...deadlineConstraint.value } : null,
      resolvedInstant: deadlineInstant,
      zoneUsed,
      zoneNote,
    },
    feasibility: [],
    measures,
    rewards,
    rankingDecisions: [],
    rankedOrder: [],
  });

  // Contradictions and missing requirements block a recommendation outright.
  // The engine does not guess, and does not pick one of two conflicting values.
  if (conflicts.length > 0) {
    return { status: 'contradiction', conflicts, trace: baseTrace() };
  }
  if (needs.length > 0) {
    return { status: 'missing_required', needs, trace: baseTrace() };
  }

  // ---- Stage 1: feasibility gate ----
  const ranked: RankedOption[] = [];
  const excluded: ExcludedOption[] = [];
  const trace = baseTrace();

  for (const option of options) {
    const m = measures[option.id]!;
    const reasons = evaluateFeasibility({ option, constraints, measures: m, deadlineInstant });
    trace.feasibility.push({
      optionId: option.id,
      outcome: reasons.length > 0 ? 'eliminated' : 'passed',
      reasons,
    });
    if (reasons.length > 0) {
      excluded.push({ option, measures: m, reasons });
    } else {
      ranked.push({ option, measures: m, rank: 0 });
    }
  }

  if (ranked.length === 0) {
    return {
      status: 'no_feasible_option',
      excluded,
      relaxation: buildRelaxationReport(excluded),
      trace,
    };
  }

  // ---- Stage 4: ranking ----
  const { order, decisions } = rankOptions(
    ranked.map((r) => ({ id: r.option.id, measures: r.measures })),
    priorityRule,
  );
  trace.rankingDecisions = decisions;
  trace.rankedOrder = order;

  const rankedSorted = order.map((id, idx) => {
    const found = ranked.find((r) => r.option.id === id)!;
    return { ...found, rank: idx + 1 };
  });

  const recommendation = buildRecommendation({
    rankedSorted,
    decisions,
    priorityRule,
    rewards,
    deadlineInstant,
  });

  return { status: 'ok', ranked: rankedSorted, excluded, recommendation, trace };
}

function buildRecommendation(args: {
  rankedSorted: RankedOption[];
  decisions: DecisionTrace['rankingDecisions'];
  priorityRule: TripState['priorityRule'];
  rewards: Record<string, RewardsAssessment>;
  deadlineInstant: string | null;
}): Recommendation {
  const { rankedSorted, decisions, priorityRule, rewards, deadlineInstant } = args;
  const top = rankedSorted[0]!;
  const runnerUp = rankedSorted[1] ?? null;
  const deciding = decisions.find((d) => d.higherId === top.option.id) ?? null;

  const reasons: string[] = [];
  reasons.push(`Ranked first under "${PRIORITY_RULE_LABELS[priorityRule]}".`);

  if (deciding && runnerUp) {
    reasons.push(
      `Beat ${runnerUp.option.id} on ${deciding.decidedBy} ` +
        `(${deciding.higherValue} vs ${deciding.lowerValue}, sorted ${deciding.direction}).`,
    );
  }

  if (top.measures.arrivalMarginMinutes !== null && deadlineInstant !== null) {
    reasons.push(
      `Arrives with ${formatDuration(top.measures.arrivalMarginMinutes)} to spare before the commitment.`,
    );
  }

  // The rewards wording rule. Under lowest_cash_outlay an award option can win
  // precisely because only the co-payment counts as cash -- it must never be
  // called cheapest or best value, because it also consumes points carrying an
  // opportunity cost this engine does not price.
  const topRewards = rewards[top.option.id];
  if (top.option.paymentKind === 'award' && top.measures.pointsRequired !== null) {
    const cashText =
      top.measures.cashPayable === null ? 'no cash figure' : String(top.measures.cashPayable);
    reasons.push(
      priorityRule === 'lowest_cash_outlay'
        ? `Lowest cash outlay (${cashText}) — plus ${top.measures.pointsRequired} points.`
        : `Cash payable ${cashText} — plus ${top.measures.pointsRequired} points.`,
    );
    if (topRewards?.effectiveCpp !== null && topRewards?.effectiveCpp !== undefined) {
      reasons.push(
        `Redemption returns ${topRewards.effectiveCpp.toFixed(2)}c per point against your own estimate of ${topRewards.valuationCpp ?? 'n/a'}c.`,
      );
    }
  }

  const risks: string[] = top.measures.connectionRisks.map((r) => r.detail);
  if (top.measures.isStale) {
    risks.push(
      `This option's data is ${formatDuration(top.measures.staleByMinutes ?? 0)} past the staleness threshold. Re-check it before acting.`,
    );
  }
  for (const other of rankedSorted.slice(1)) {
    if (other.measures.isStale) {
      risks.push(`${other.option.id} is also stale, so the comparison may have moved.`);
    }
  }

  const provisional = rankedSorted.some((r) => r.measures.isStale);

  return {
    chosenOptionId: top.option.id,
    priorityRule,
    decidingComparator: deciding,
    reasons,
    risks,
    fallback: runnerUp
      ? {
          optionId: runnerUp.option.id,
          triggerCondition:
            top.measures.connectionRisks.length > 0
              ? `If the flagged connection on ${top.option.id} is disrupted, or its fare or availability changes.`
              : `If ${top.option.id} becomes unavailable or its price changes.`,
        }
      : null,
    provisional,
    provisionalReason: provisional
      ? 'At least one option in this comparison is past the staleness threshold, so the recommendation is provisional.'
      : null,
  };
}
