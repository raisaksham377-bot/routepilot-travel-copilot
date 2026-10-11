import { z } from 'zod';

/**
 * Where an option's data came from. This is a correctness concern, not a
 * disclaimer: an executive brief that looks authoritative while resting on
 * fixture data is the main way this project could mislead someone.
 *
 * LIVE_VERIFIED is declared but UNREACHABLE in P0. No code path may produce it.
 * It exists so that adding a real fare source later is a new branch rather than
 * a schema change, and so that the absence of live data is explicit in the type
 * system rather than implied.
 */
export const provenanceSchema = z.enum(['SAMPLE', 'USER_ENTERED', 'LIVE_VERIFIED']);
export type Provenance = z.infer<typeof provenanceSchema>;

export const PROVENANCE_LABELS: Record<Provenance, string> = {
  SAMPLE: 'Sample data',
  USER_ENTERED: 'You entered this',
  LIVE_VERIFIED: 'Live verified',
};

export const PROVENANCE_DESCRIPTIONS: Record<Provenance, string> = {
  SAMPLE: 'Seeded demonstration data. Not fetched, not live, not bookable.',
  USER_ENTERED: 'Entered by hand from your own research. Not fetched or verified by this app.',
  LIVE_VERIFIED: 'Retrieved from a verified live source.',
};

/** Reachable in P0. Used to assert LIVE_VERIFIED never appears. */
export const REACHABLE_PROVENANCE: readonly Provenance[] = ['SAMPLE', 'USER_ENTERED'];
