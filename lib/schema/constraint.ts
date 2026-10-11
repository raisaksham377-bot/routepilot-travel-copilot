import { z } from 'zod';
import { cabinSchema } from './flightOption';
import { zonedWallClockSchema } from './time';

/**
 * A hard constraint eliminates. A soft constraint informs ranking or raises a
 * named risk. The distinction is the user's to make and is always visible in
 * the ledger -- it is never inferred silently.
 */
export const constraintKindSchema = z.enum(['hard', 'soft']);
export type ConstraintKind = z.infer<typeof constraintKindSchema>;

/**
 * Provenance of the constraint itself, shown in the ledger so the user can see
 * what the app assumed versus what they actually said. `inferred` values are
 * rendered distinctly and are never auto-committed as hard constraints.
 */
export const constraintSourceSchema = z.enum(['stated', 'inferred', 'profile', 'user-edited']);
export type ConstraintSource = z.infer<typeof constraintSourceSchema>;

const base = {
  kind: constraintKindSchema,
  source: constraintSourceSchema,
  /** 0..1, only meaningful for `inferred`. */
  confidence: z.number().min(0).max(1).optional(),
  note: z.string().optional(),
};

/**
 * The arrival deadline is stated as a wall clock plus a zone -- "noon on the
 * 4th, New York time" -- because that is how a commitment is actually expressed.
 * The engine resolves it to an instant in the DESTINATION zone. Storing it as a
 * bare instant would hide the resolution step and make the destination-zone
 * requirement untestable.
 */
export const arrivalDeadlineConstraint = z.object({
  key: z.literal('arrival_deadline'),
  value: zonedWallClockSchema,
  ...base,
});

export const minConnectionConstraint = z.object({
  key: z.literal('min_connection_minutes'),
  value: z.number().int().positive(),
  ...base,
});

export const cabinFloorConstraint = z.object({
  key: z.literal('cabin_floor'),
  value: cabinSchema,
  ...base,
});

export const budgetCeilingConstraint = z.object({
  key: z.literal('budget_ceiling'),
  value: z.number().nonnegative(),
  ...base,
});

export const originConstraint = z.object({
  key: z.literal('origin'),
  value: z.string().length(3).toUpperCase(),
  ...base,
});

export const destinationConstraint = z.object({
  key: z.literal('destination'),
  value: z.string().length(3).toUpperCase(),
  ...base,
});

export const avoidOvernightConstraint = z.object({
  key: z.literal('avoid_overnight_connection'),
  value: z.boolean(),
  ...base,
});

export const constraintSchema = z.discriminatedUnion('key', [
  arrivalDeadlineConstraint,
  minConnectionConstraint,
  cabinFloorConstraint,
  budgetCeilingConstraint,
  originConstraint,
  destinationConstraint,
  avoidOvernightConstraint,
]);

export type Constraint = z.infer<typeof constraintSchema>;
export type ConstraintKey = Constraint['key'];

export const CONSTRAINT_LABELS: Record<ConstraintKey, string> = {
  arrival_deadline: 'Must arrive by',
  min_connection_minutes: 'Minimum connection time',
  cabin_floor: 'Cabin at least',
  budget_ceiling: 'Cash budget ceiling',
  origin: 'Departing from',
  destination: 'Arriving at',
  avoid_overnight_connection: 'Avoid overnight connections',
};

/**
 * Constraints the relaxation report (S8) can reason about quantitatively.
 * Deliberately short: the engine reports a relaxation only where it can compute
 * one exactly, for ONE constraint at a time, holding the others constant. It
 * never searches for a globally minimum relaxation across several constraints,
 * because that is a different and much larger optimisation problem than this
 * MVP needs.
 */
export const RELAXABLE_CONSTRAINTS = ['arrival_deadline', 'budget_ceiling'] as const;
export type RelaxableConstraint = (typeof RELAXABLE_CONSTRAINTS)[number];

export function findConstraint<K extends ConstraintKey>(
  constraints: readonly Constraint[],
  key: K,
): Extract<Constraint, { key: K }> | undefined {
  return constraints.find((c): c is Extract<Constraint, { key: K }> => c.key === key);
}
