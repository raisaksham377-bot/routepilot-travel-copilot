import type { Cabin, FlightOption } from '../schema/flightOption';
import type { ConstraintKey, RelaxableConstraint } from '../schema/constraint';
import type { PriorityRuleName } from '../schema/tripState';

/** The measures that ranking may sort on. Each has its own units; none are blended. */
export type MeasureName =
  | 'arrivalMarginMinutes'
  | 'connectionRiskCount'
  | 'cashPayable'
  | 'travelDurationMinutes';

export type SortDirection = 'ASC' | 'DESC';

export interface ComparatorSpec {
  measure: MeasureName;
  direction: SortDirection;
}

export type ConnectionRiskCode =
  | 'buffer_below_minimum'
  | 'overnight_connection'
  | 'tight_single_connection';

export interface ConnectionRisk {
  code: ConnectionRiskCode;
  airport: string;
  bufferMinutes: number;
  /** Plain-language statement of the finding. No probability language. */
  detail: string;
}

/**
 * Stage 2 measures. Note the two cash figures are carried separately alongside
 * `cashPayable`, so the brief can show the arithmetic rather than a conclusion.
 */
export interface Measures {
  cashPayable: number | null;
  comparableCashTicketTotal: number | null;
  awardCashCoPayment: number | null;
  taxesAndFees: number | null;
  pointsRequired: number | null;
  arrivalMarginMinutes: number | null;
  connectionRisks: ConnectionRisk[];
  connectionRiskCount: number;
  travelDurationMinutes: number;
  isStale: boolean;
  staleByMinutes: number | null;
}

export interface EliminationReason {
  constraintKey: ConstraintKey;
  /** The comparison that failed, written out so the trace is self-explaining. */
  comparison: string;
  /** How far past the limit, in the constraint's own units, when quantifiable. */
  exceededBy: number | null;
  exceededByUnit: 'minutes' | 'currency' | 'cabin_steps' | null;
}

export interface RankedOption {
  option: FlightOption;
  measures: Measures;
  rank: number;
}

export interface ExcludedOption {
  option: FlightOption;
  measures: Measures;
  reasons: EliminationReason[];
}

export interface RankingDecision {
  higherId: string;
  lowerId: string;
  decidedBy: MeasureName | 'option_id_tiebreak';
  direction: SortDirection;
  higherValue: number | null;
  lowerValue: number | null;
}

export type RewardsReason =
  | 'module_disabled'
  | 'rewards_not_permitted'
  | 'not_an_award_option'
  | 'no_cash_counterpart'
  | 'not_comparable'
  | 'missing_data';

export interface RewardsAssessment {
  optionId: string;
  applicable: boolean;
  effectiveCpp: number | null;
  reason: RewardsReason | null;
  /** Names the specific comparability check that failed, when one did. */
  failedCheck: string | null;
  counterpartOptionId: string | null;
  inputs: {
    comparableCashTicketTotal: number | null;
    awardCashCoPayment: number | null;
    pointsRequired: number | null;
  };
  valuationCpp: number | null;
  verdict: 'at_or_above_valuation' | 'below_valuation' | null;
}

export interface Need {
  constraintKey: ConstraintKey | null;
  optionId: string | null;
  field: string;
  message: string;
}

export interface Conflict {
  constraintKey: ConstraintKey;
  values: Array<{ value: unknown; source: string; note?: string }>;
  message: string;
}

export interface SingleConstraintRelaxation {
  constraint: RelaxableConstraint;
  /** Amount of relaxation needed, in the units below. */
  amount: number;
  unit: 'minutes' | 'currency';
  /** The specific option that becomes feasible. Not a claim about any other. */
  viaOptionId: string;
  statement: string;
}

export interface RelaxationReport {
  /**
   * Exact single-constraint relaxations, each holding every other constraint
   * constant. Only options violating EXACTLY ONE relaxable hard constraint are
   * considered, because only then is the required amount computable without
   * searching a multi-constraint space.
   */
  singleConstraint: SingleConstraintRelaxation[];
  /**
   * Fallback when no exact relaxation is computable: the candidates and what
   * each violates. Explicitly NOT ranked and NOT a claim of optimality.
   */
  candidates: Array<{ optionId: string; violates: ConstraintKey[] }>;
  /** States in the output that no global optimum is being claimed. */
  disclaimer: string;
}

export interface Recommendation {
  chosenOptionId: string;
  priorityRule: PriorityRuleName;
  /** Why it ranked top: the comparator that beat the runner-up, with values. */
  decidingComparator: RankingDecision | null;
  reasons: string[];
  risks: string[];
  fallback: {
    optionId: string;
    triggerCondition: string;
  } | null;
  /** True when any contributing option is stale (S7). */
  provisional: boolean;
  provisionalReason: string | null;
}

export interface DecisionTrace {
  schemaVersion: 1;
  /** Echoed from input, never read from the clock -- traces must be reproducible. */
  evaluatedAt: string;
  priorityRule: PriorityRuleName;
  comparators: ComparatorSpec[];
  deadline: {
    stated: { localDateTime: string; tz: string } | null;
    resolvedInstant: string | null;
    zoneUsed: string | null;
    /** Set when the deadline zone differs from the itinerary's arrival zone. */
    zoneNote: string | null;
  };
  feasibility: Array<{
    optionId: string;
    outcome: 'passed' | 'eliminated';
    reasons: EliminationReason[];
  }>;
  measures: Record<string, Measures>;
  rewards: Record<string, RewardsAssessment>;
  rankingDecisions: RankingDecision[];
  rankedOrder: string[];
}

export type DecisionResult =
  | {
      status: 'ok';
      ranked: RankedOption[];
      excluded: ExcludedOption[];
      recommendation: Recommendation;
      trace: DecisionTrace;
    }
  | {
      status: 'no_feasible_option';
      excluded: ExcludedOption[];
      relaxation: RelaxationReport;
      trace: DecisionTrace;
    }
  | { status: 'missing_required'; needs: Need[]; trace: DecisionTrace }
  | { status: 'contradiction'; conflicts: Conflict[]; trace: DecisionTrace };

export type { Cabin };
