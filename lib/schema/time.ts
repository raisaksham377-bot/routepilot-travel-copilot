import { z } from 'zod';
import { DateTime } from 'luxon';

/**
 * Time representation. The single most important schema decision in the project.
 *
 * Every instant is stored as an ISO 8601 timestamp WITH an explicit UTC offset,
 * alongside an IANA timezone identifier. Both are required:
 *
 *  - The offset makes the instant unambiguous on its own, so comparing two
 *    instants is exact and needs no timezone database.
 *  - The IANA id is still needed to answer wall-clock questions ("is this
 *    connection overnight *where the traveller is sitting*?") and to resolve a
 *    stated deadline like "12:00 in New York" into an instant across a DST
 *    boundary, which a fixed offset cannot do.
 *
 * Local clock times are never compared. An overnight transatlantic arrival at
 * "08:30" against a "10:00" deadline is only meaningful as instants.
 */

/** ISO 8601 with a mandatory offset: 2026-11-04T07:15:00-05:00 or ...Z */
export const isoInstantSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    'Must be an ISO 8601 timestamp with an explicit UTC offset (e.g. 2026-11-04T07:15:00-05:00)',
  )
  .refine((s) => DateTime.fromISO(s, { setZone: true }).isValid, {
    message: 'Not a valid timestamp',
  });

/** An IANA timezone identifier, validated against the runtime's tz database. */
export const ianaZoneSchema = z
  .string()
  .min(1)
  .refine((z0) => DateTime.local().setZone(z0).isValid, {
    message: 'Not a recognised IANA timezone identifier (e.g. America/New_York)',
  });

/**
 * A wall-clock date and time with no offset, paired with the zone it is meant in.
 * This is how a human states a deadline: "be there by noon on the 4th, New York
 * time". Resolving it to an instant requires the tz database, which is exactly
 * why the zone travels with it instead of being assumed.
 */
export const localDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
    'Must be a local date-time with no offset (e.g. 2026-11-04T12:00)',
  );

export const zonedWallClockSchema = z.object({
  localDateTime: localDateTimeSchema,
  tz: ianaZoneSchema,
});

export type IsoInstant = z.infer<typeof isoInstantSchema>;
export type IanaZone = z.infer<typeof ianaZoneSchema>;
export type ZonedWallClock = z.infer<typeof zonedWallClockSchema>;
