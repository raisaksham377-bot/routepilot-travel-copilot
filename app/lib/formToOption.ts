import { DateTime } from 'luxon';
import { flightOptionSchema, type Cabin, type FlightOption } from '@/lib/schema/flightOption';

/**
 * Converts the structured manual-entry form into a validated FlightOption.
 *
 * The form collects a wall-clock time plus an IANA zone, exactly as a person
 * reads a timetable, and Luxon resolves that pair into an ISO instant with the
 * correct offset for that date -- including across a DST transition. The engine
 * then only ever sees unambiguous instants.
 *
 * A missing cash figure is passed through as null rather than rejected here.
 * The engine reports it as a `missing_required` need so the UI can ask for it,
 * which keeps a half-finished entry editable instead of throwing it away.
 */

export const COMMON_ZONES = [
  'Europe/London',
  'Europe/Dublin',
  'Europe/Amsterdam',
  'Europe/Paris',
  'Europe/Frankfurt',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;

export interface LegFormValues {
  flightNumber: string;
  origin: string;
  destination: string;
  /** datetime-local value: "2026-11-04T09:00" */
  departureLocal: string;
  departureTz: string;
  arrivalLocal: string;
  arrivalTz: string;
}

export interface OptionFormValues {
  id: string;
  carrier: string;
  cabin: Cabin;
  paymentKind: 'cash' | 'award';
  comparableCashTicketTotal: string;
  awardCashCoPayment: string;
  taxesAndFees: string;
  pointsRequired: string;
  pointsProgram: string;
  legs: LegFormValues[];
}

export function emptyLeg(): LegFormValues {
  return {
    flightNumber: '',
    origin: '',
    destination: '',
    departureLocal: '',
    departureTz: 'Europe/London',
    arrivalLocal: '',
    arrivalTz: 'America/New_York',
  };
}

export function emptyOptionForm(): OptionFormValues {
  return {
    id: '',
    carrier: '',
    cabin: 'business',
    paymentKind: 'cash',
    comparableCashTicketTotal: '',
    awardCashCoPayment: '',
    taxesAndFees: '',
    pointsRequired: '',
    pointsProgram: '',
    legs: [emptyLeg()],
  };
}

function toNumberOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Resolves a wall clock plus a zone into an ISO instant with a real offset. */
function toInstant(local: string, tz: string): string | null {
  if (local.trim() === '') return null;
  const dt = DateTime.fromISO(local, { zone: tz });
  return dt.isValid ? dt.toISO() : null;
}

export type FormConversion =
  | { ok: true; option: FlightOption }
  | { ok: false; errors: string[] };

export function formToOption(values: OptionFormValues, asOf: string): FormConversion {
  const errors: string[] = [];

  if (values.id.trim() === '') errors.push('Give the option a short label, e.g. "BA117".');
  if (values.carrier.trim() === '') errors.push('Enter the carrier.');
  if (values.legs.length === 0) errors.push('Add at least one flight.');

  const legs = values.legs.map((leg, i) => {
    const n = i + 1;
    if (leg.origin.trim().length !== 3) errors.push(`Flight ${n}: origin must be a 3-letter code.`);
    if (leg.destination.trim().length !== 3)
      errors.push(`Flight ${n}: destination must be a 3-letter code.`);

    const departure = toInstant(leg.departureLocal, leg.departureTz);
    const arrival = toInstant(leg.arrivalLocal, leg.arrivalTz);

    // Ambiguity is reported, never guessed. No assumed date, no assumed zone.
    if (departure === null)
      errors.push(`Flight ${n}: enter a full departure date and time, and its timezone.`);
    if (arrival === null)
      errors.push(`Flight ${n}: enter a full arrival date and time, and its timezone.`);

    return {
      flightNumber: leg.flightNumber.trim() === '' ? `LEG${n}` : leg.flightNumber.trim(),
      origin: leg.origin.trim().toUpperCase(),
      destination: leg.destination.trim().toUpperCase(),
      departure: departure ?? '',
      departureTz: leg.departureTz,
      arrival: arrival ?? '',
      arrivalTz: leg.arrivalTz,
    };
  });

  if (errors.length > 0) return { ok: false, errors };

  const candidate = {
    id: values.id.trim(),
    carrier: values.carrier.trim(),
    legs,
    cabin: values.cabin,
    paymentKind: values.paymentKind,
    comparableCashTicketTotal:
      values.paymentKind === 'cash' ? toNumberOrNull(values.comparableCashTicketTotal) : null,
    awardCashCoPayment:
      values.paymentKind === 'award' ? toNumberOrNull(values.awardCashCoPayment) : null,
    taxesAndFees: toNumberOrNull(values.taxesAndFees),
    pointsRequired: values.paymentKind === 'award' ? toNumberOrNull(values.pointsRequired) : null,
    pointsProgram: values.pointsProgram.trim() === '' ? null : values.pointsProgram.trim(),
    // Entered by hand from the user's own research. Never "verified".
    provenance: 'USER_ENTERED' as const,
    asOf,
    capturedFrom: 'Entered by hand',
  };

  const parsed = flightOptionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'option'}: ${i.message}`),
    };
  }
  return { ok: true, option: parsed.data };
}
