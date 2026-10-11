import { DateTime } from 'luxon';
import type { FlightOption } from '../schema/flightOption';
import { optionArrival, optionDeparture } from '../schema/flightOption';
import type { ZonedWallClock } from '../schema/time';

/**
 * All time arithmetic for the engine. Pure, no clock access, no I/O.
 *
 * The rule this module exists to enforce: NOTHING compares local clock times.
 * Every comparison is between absolute instants. Date and timezone bugs do not
 * crash -- they quietly invert a decision and the test suite stays green -- so
 * the arithmetic is isolated here and tested directly.
 */

/** Minutes from `a` to `b`. Positive when `b` is later. Rounded to whole minutes. */
export function minutesBetween(a: string, b: string): number {
  const ms = Date.parse(b) - Date.parse(a);
  return Math.round(ms / 60000);
}

export type DeadlineResolution =
  | { ok: true; instant: string; zoneUsed: string }
  | { ok: false; reason: 'invalid_wall_clock' | 'invalid_zone' };

/**
 * Resolves a stated wall-clock deadline into an absolute instant.
 *
 * The zone is REQUIRED and is used as given -- it is not defaulted to the
 * machine's local zone and not inferred from the origin. A deadline of
 * "12:00 on 2026-11-04" means a different instant in New York than in London,
 * and resolving it against the wrong zone is exactly the bug class this guards.
 *
 * Luxon consults the IANA database, so a date on the far side of a DST
 * transition gets the correct offset. A hardcoded offset cannot do this.
 */
export function resolveDeadlineInstant(deadline: ZonedWallClock): DeadlineResolution {
  const zoned = DateTime.fromISO(deadline.localDateTime, { zone: deadline.tz });
  if (!zoned.isValid) {
    // Luxon reports an unknown zone and an unparseable literal differently.
    const zoneProbe = DateTime.local().setZone(deadline.tz);
    return { ok: false, reason: zoneProbe.isValid ? 'invalid_wall_clock' : 'invalid_zone' };
  }
  return { ok: true, instant: zoned.toISO()!, zoneUsed: deadline.tz };
}

/**
 * Door-to-door elapsed time in minutes, from the first leg's departure instant
 * to the last leg's arrival instant.
 *
 * Computed from instants, so an itinerary crossing midnight and several zones
 * yields a correct positive duration. A clock-time subtraction would produce a
 * negative or absurd number for an overnight transatlantic leg.
 */
export function travelDurationMinutes(option: FlightOption): number {
  return minutesBetween(optionDeparture(option).instant, optionArrival(option).instant);
}

/**
 * Arrival margin: spare minutes between arriving and the commitment.
 * Positive means slack; negative means the commitment is missed.
 */
export function arrivalMarginMinutes(option: FlightOption, deadlineInstant: string): number {
  return minutesBetween(optionArrival(option).instant, deadlineInstant);
}

export interface ConnectionWindow {
  /** Airport where the traveller waits. */
  airport: string;
  bufferMinutes: number;
  /** Zone of the connecting airport -- used for the overnight wall-clock test. */
  tz: string;
  /** Local wall-clock bounds of the wait, for display and the overnight check. */
  arriveLocal: string;
  departLocal: string;
}

/**
 * Derives the connection windows between consecutive legs.
 *
 * Because connections are derived rather than stored, a buffer can never
 * disagree with the leg times it came from.
 */
export function connectionWindows(option: FlightOption): ConnectionWindow[] {
  const windows: ConnectionWindow[] = [];
  for (let i = 1; i < option.legs.length; i += 1) {
    const inbound = option.legs[i - 1]!;
    const outbound = option.legs[i]!;
    const tz = inbound.arrivalTz;
    windows.push({
      airport: inbound.destination,
      bufferMinutes: minutesBetween(inbound.arrival, outbound.departure),
      tz,
      arriveLocal: DateTime.fromISO(inbound.arrival, { setZone: true }).setZone(tz).toISO()!,
      departLocal: DateTime.fromISO(outbound.departure, { setZone: true }).setZone(tz).toISO()!,
    });
  }
  return windows;
}

/** Local hours (inclusive start, exclusive end) treated as the overnight window. */
export const OVERNIGHT_WINDOW_START_HOUR = 0;
export const OVERNIGHT_WINDOW_END_HOUR = 5;

/**
 * Whether a connection requires sitting through the local small hours.
 *
 * This is a WALL-CLOCK question, not an instant question -- "is it the middle of
 * the night where the traveller actually is" -- which is precisely why the IANA
 * zone has to travel alongside the offset. Deliberately a structural
 * observation about the itinerary, with no claim about how tired anyone will be
 * or how likely anything is to go wrong.
 */
export function isOvernightConnection(w: ConnectionWindow): boolean {
  const start = DateTime.fromISO(w.arriveLocal, { setZone: true });
  const end = DateTime.fromISO(w.departLocal, { setZone: true });
  if (!start.isValid || !end.isValid) return false;

  // Walk hour boundaries across the wait and see if any fall in the night window.
  let cursor = start.startOf('hour');
  while (cursor <= end) {
    const h = cursor.hour;
    if (h >= OVERNIGHT_WINDOW_START_HOUR && h < OVERNIGHT_WINDOW_END_HOUR && cursor >= start) {
      return true;
    }
    cursor = cursor.plus({ hours: 1 });
  }
  return false;
}

/** The local calendar date of an instant in a given zone, as YYYY-MM-DD. */
export function localDate(instant: string, tz: string): string {
  return DateTime.fromISO(instant, { setZone: true }).setZone(tz).toISODate()!;
}

/** Human-readable local time, for the brief and the UI. */
export function formatLocal(instant: string, tz: string): string {
  return DateTime.fromISO(instant, { setZone: true })
    .setZone(tz)
    .toFormat("ccc d LLL yyyy, HH:mm 'local'");
}

export function formatDuration(minutes: number): string {
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return `${sign}${m}m`;
  return `${sign}${h}h ${String(m).padStart(2, '0')}m`;
}
