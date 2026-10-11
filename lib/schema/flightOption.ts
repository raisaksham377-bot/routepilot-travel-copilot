import { z } from 'zod';
import { isoInstantSchema, ianaZoneSchema } from './time';
import { provenanceSchema } from './provenance';

/** Cabin, ordered worst-to-best. Index is the rank used by the cabin floor. */
export const CABIN_ORDER = ['economy', 'premium_economy', 'business', 'first'] as const;
export const cabinSchema = z.enum(CABIN_ORDER);
export type Cabin = z.infer<typeof cabinSchema>;

export function cabinRank(c: Cabin): number {
  return CABIN_ORDER.indexOf(c);
}

export const CABIN_LABELS: Record<Cabin, string> = {
  economy: 'Economy',
  premium_economy: 'Premium economy',
  business: 'Business',
  first: 'First',
};

/**
 * A single flight segment.
 *
 * The itinerary is modelled as legs rather than as an option-level
 * departure/arrival plus a separate stop count. Connections are then *derived*
 * from consecutive legs, which means a connection buffer cannot disagree with
 * the times it was computed from -- there is only one source of truth.
 */
export const legSchema = z.object({
  flightNumber: z.string().min(1),
  origin: z.string().length(3).toUpperCase(),
  destination: z.string().length(3).toUpperCase(),
  departure: isoInstantSchema,
  departureTz: ianaZoneSchema,
  arrival: isoInstantSchema,
  arrivalTz: ianaZoneSchema,
});
export type Leg = z.infer<typeof legSchema>;

export const paymentKindSchema = z.enum(['cash', 'award']);
export type PaymentKind = z.infer<typeof paymentKindSchema>;

const money = z.number().nonnegative();

/**
 * A candidate option.
 *
 * THE TWO CASH FIELDS ARE DELIBERATELY SEPARATE AND MUST NEVER BE SUMMED:
 *
 *  - `comparableCashTicketTotal` is the full all-in price of buying the
 *    equivalent ticket for cash. On a cash option it is what you pay. On an
 *    award option it is the *baseline* used to judge the redemption -- the cash
 *    you avoided -- and is NOT money you hand over.
 *
 *  - `awardCashCoPayment` is the cash still payable alongside a redemption:
 *    carrier surcharges, taxes, booking fees. On an award option this IS what
 *    you pay.
 *
 * An earlier draft of the spec had a single "cash fare" field and subtracted
 * award fees from it. That double-counted fees whenever both were populated.
 * Keeping them as distinct fields makes that mistake unrepresentable rather
 * than merely discouraged.
 */
export const flightOptionSchema = z
  .object({
    id: z.string().min(1),
    carrier: z.string().min(1),
    legs: z.array(legSchema).min(1),
    cabin: cabinSchema,

    paymentKind: paymentKindSchema,
    comparableCashTicketTotal: money.nullable(),
    awardCashCoPayment: money.nullable(),
    taxesAndFees: money.nullable(),
    pointsRequired: z.number().int().positive().nullable(),
    pointsProgram: z.string().min(1).nullable(),

    provenance: provenanceSchema,
    asOf: isoInstantSchema,
    capturedFrom: z.string().optional(),
  })
  .superRefine((o, ctx) => {
    /*
     * SCHEMA VALIDATES SHAPE. THE ENGINE VALIDATES SUFFICIENCY.
     *
     * A missing cash figure or missing points total is NOT a schema error: it is
     * the normal state of an option the user is halfway through entering, and
     * the product's job is to ask for it rather than reject the record. The
     * engine reports those as `missing_required` needs, which is what scenario
     * S5 exercises.
     *
     * Rejecting them here instead would have made the engine's whole
     * missing-data branch unreachable -- the check would have looked rigorous
     * while testing nothing.
     *
     * What IS a shape error is a contradiction in kind, like a cash ticket that
     * also consumes points, or legs that do not join up.
     */
    if (o.paymentKind === 'cash' && o.pointsRequired !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pointsRequired'],
        message: 'A cash option must not consume points',
      });
    }
    // Legs must be chronologically ordered and connected end-to-end.
    for (let i = 1; i < o.legs.length; i += 1) {
      const prev = o.legs[i - 1]!;
      const cur = o.legs[i]!;
      if (prev.destination !== cur.origin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['legs', i, 'origin'],
          message: `Leg ${i} departs ${cur.origin} but the previous leg arrives at ${prev.destination}`,
        });
      }
      if (Date.parse(cur.departure) < Date.parse(prev.arrival)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['legs', i, 'departure'],
          message: `Leg ${i} departs before the previous leg arrives`,
        });
      }
    }
  });

export type FlightOption = z.infer<typeof flightOptionSchema>;

/** Option-level origin/destination/times are derived, never stored twice. */
export function optionOrigin(o: FlightOption): string {
  return o.legs[0]!.origin;
}
export function optionDestination(o: FlightOption): string {
  return o.legs[o.legs.length - 1]!.destination;
}
export function optionDeparture(o: FlightOption): { instant: string; tz: string } {
  const first = o.legs[0]!;
  return { instant: first.departure, tz: first.departureTz };
}
export function optionArrival(o: FlightOption): { instant: string; tz: string } {
  const last = o.legs[o.legs.length - 1]!;
  return { instant: last.arrival, tz: last.arrivalTz };
}
export function connectionCount(o: FlightOption): number {
  return o.legs.length - 1;
}
