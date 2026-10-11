import { z } from 'zod';
import { cabinSchema } from './flightOption';

/**
 * The traveller profile.
 *
 * Note what has no field here, by design: no name, no contact details, no
 * loyalty numbers, no account credentials, no passport or payment data. The
 * product cannot collect them because there is nowhere to put them.
 *
 * `roleLabel` is deliberately a role ("CEO", "Head of Sales") rather than a
 * person. It keeps a real individual's travel pattern out of the data, and it
 * is the only identifier that would ever accompany a future AI request.
 */
export const travelerProfileSchema = z.object({
  schemaVersion: z.literal(1),
  roleLabel: z.string().min(1).max(60),

  preferredCabin: cabinSchema.nullable(),
  /** Used as the default threshold for the connection-buffer risk. */
  minConnectionMinutes: z.number().int().positive(),
  preferredCarriers: z.array(z.string()),
  homeAirports: z.array(z.string().length(3)),

  /**
   * Loyalty programmes BY NAME ONLY. Never a membership number, never a
   * balance, never a credential. The app does not and cannot look up a balance.
   */
  loyaltyProgramNames: z.array(z.string()),

  /**
   * The user's own estimate of what a point is worth, in cents.
   *
   * This is an estimate of OPPORTUNITY COST, not money paid. It is never added
   * to a cash figure and never presented as a price. It exists so the rewards
   * module can say "this redemption returns 0.93c per point against your 1.5c
   * estimate" -- arithmetic the user can check and disagree with.
   */
  pointsValuationCpp: z.number().positive().nullable(),

  /**
   * Gates the optional rewards module. Many corporate travellers are simply not
   * permitted to use personal points for company travel, so the core product
   * must work with this false -- and does.
   */
  rewardsPermitted: z.boolean(),

  updatedAt: z.string(),
});

export type TravelerProfile = z.infer<typeof travelerProfileSchema>;

export const DEFAULT_PROFILE: TravelerProfile = {
  schemaVersion: 1,
  roleLabel: 'Executive',
  preferredCabin: 'business',
  minConnectionMinutes: 75,
  preferredCarriers: [],
  homeAirports: [],
  loyaltyProgramNames: [],
  pointsValuationCpp: null,
  rewardsPermitted: false,
  updatedAt: '1970-01-01T00:00:00Z',
};
