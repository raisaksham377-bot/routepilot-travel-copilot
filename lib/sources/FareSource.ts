import type { FlightOption } from '../schema/flightOption';
import type { Provenance } from '../schema/provenance';

/**
 * The fare-source seam. INTERFACE AND TYPES ONLY.
 *
 * No implementation here, no paid API integrated, and no code path in P0 can
 * produce `LIVE_VERIFIED`. The seam is written now because writing it costs
 * nothing, while filling it would cost correctness: live data makes the golden
 * tests non-deterministic and would turn "nothing was fetched live" into a
 * false statement.
 *
 * The fixture loader and the structured manual-entry form both satisfy this
 * interface, so adding a real adapter later is a new implementation rather than
 * a redesign of the engine.
 */
export interface FareQuery {
  origin: string;
  destination: string;
  /** Local departure date, YYYY-MM-DD. */
  departureDate: string;
  cabin?: string;
}

export interface FareSourceResult {
  options: FlightOption[];
  /** Every source must declare what it produces. P0 sources never say LIVE_VERIFIED. */
  provenance: Provenance;
  /** When this data was captured, as an ISO instant. */
  asOf: string;
}

export interface FareSource {
  readonly id: string;
  readonly label: string;
  /**
   * Declared up front so the UI can label results honestly before a query runs,
   * rather than inferring trustworthiness from the response.
   */
  readonly producesProvenance: Provenance;
  fetchOptions(query: FareQuery): Promise<FareSourceResult>;
}

/**
 * Guard used by tests and by the UI: nothing in P0 may claim verified live data.
 */
export function assertNotLiveVerified(p: Provenance): void {
  if (p === 'LIVE_VERIFIED') {
    throw new Error(
      'LIVE_VERIFIED is reserved and unreachable in P0. No source may claim verified live data.',
    );
  }
}
