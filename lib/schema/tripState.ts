import { z } from 'zod';
import { constraintSchema } from './constraint';
import { flightOptionSchema } from './flightOption';
import { travelerProfileSchema } from './travelerProfile';
import { isoInstantSchema } from './time';

/**
 * The four priority rules.
 *
 * NAMING IS LOAD-BEARING AND MUST NOT DRIFT. Earlier drafts called these
 * `arrival_certainty` and `reliability`. Both were withdrawn because this engine
 * inspects itinerary *characteristics* -- buffer sizes, connection counts,
 * overnight legs -- and has no historical on-time performance data whatsoever.
 * It therefore cannot and does not estimate any probability of arriving on time.
 *
 * `arrival_buffer_first` and `fewest_connection_risks` say what is actually
 * measured. Reinstating probability language would require introducing real
 * reliability data first. A test scans the source for the forbidden vocabulary.
 */
export const priorityRuleSchema = z.enum([
  'arrival_buffer_first',
  'fewest_connection_risks',
  'lowest_cash_outlay',
  'shortest_travel_time',
]);
export type PriorityRuleName = z.infer<typeof priorityRuleSchema>;

export const DEFAULT_PRIORITY_RULE: PriorityRuleName = 'arrival_buffer_first';

export const PRIORITY_RULE_LABELS: Record<PriorityRuleName, string> = {
  arrival_buffer_first: 'Most spare time before the commitment',
  fewest_connection_risks: 'Fewest connection risks',
  lowest_cash_outlay: 'Lowest cash outlay',
  shortest_travel_time: 'Shortest travel time',
};

/** One-line explanations shown beside the selector. Deliberately free of any
 * claim about punctuality -- these describe what is sorted, nothing more. */
export const PRIORITY_RULE_EXPLANATIONS: Record<PriorityRuleName, string> = {
  arrival_buffer_first:
    'Ranks by how much spare time there is between arrival and the commitment, largest first.',
  fewest_connection_risks:
    'Ranks by the number of flagged connection findings, fewest first.',
  lowest_cash_outlay:
    'Ranks by cash actually payable, lowest first. For an award option that is the co-payment only.',
  shortest_travel_time: 'Ranks by door-to-door elapsed time, shortest first.',
};

export const tripStateSchema = z.object({
  schemaVersion: z.literal(1),
  profile: travelerProfileSchema,
  constraints: z.array(constraintSchema),
  options: z.array(flightOptionSchema),
  priorityRule: priorityRuleSchema,
  /** Turns the optional rewards module on. Also requires profile.rewardsPermitted. */
  rewardsModuleEnabled: z.boolean(),
  /**
   * Options older than this many minutes are treated as stale (scenario S7).
   */
  stalenessThresholdMinutes: z.number().int().positive(),
  asOf: isoInstantSchema,
});

export type TripState = z.infer<typeof tripStateSchema>;
