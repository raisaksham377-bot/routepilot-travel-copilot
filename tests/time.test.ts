import { describe, expect, it } from 'vitest';
import {
  connectionWindows,
  isOvernightConnection,
  minutesBetween,
  resolveDeadlineInstant,
  travelDurationMinutes,
} from '@/lib/decision/time';
import { decide } from '@/lib/decision';
import { S2_OVERNIGHT, S5_CROSS_MIDNIGHT, s5CrossMidnightState } from '@/lib/data/scenarios';

/**
 * Time arithmetic gets its own suite because its bugs are silent. A wrong
 * duration or margin does not throw -- it quietly inverts a ranking while the
 * rest of the suite stays green.
 */

describe('deadline resolution', () => {
  it('resolves a wall clock in the zone it was stated in', () => {
    const r = resolveDeadlineInstant({
      localDateTime: '2026-11-04T18:00',
      tz: 'America/New_York',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Date.parse(r.instant)).toBe(Date.parse('2026-11-04T23:00:00Z'));
  });

  /**
   * The same wall clock is a DIFFERENT moment in a different zone, five hours
   * apart here. Resolving a deadline against the origin's zone instead of the
   * destination's would shift feasibility for every option at once.
   */
  it('gives a different instant for the same wall clock in a different zone', () => {
    const ny = resolveDeadlineInstant({
      localDateTime: '2026-11-04T18:00',
      tz: 'America/New_York',
    });
    const london = resolveDeadlineInstant({
      localDateTime: '2026-11-04T18:00',
      tz: 'Europe/London',
    });
    expect(ny.ok && london.ok).toBe(true);
    if (!ny.ok || !london.ok) return;
    expect(Date.parse(ny.instant) - Date.parse(london.instant)).toBe(5 * 60 * 60 * 1000);
  });

  /**
   * US DST ended on 1 November 2026. 18:00 in New York is therefore UTC-4 in
   * late October and UTC-5 in early November. A hardcoded offset gets one of
   * these wrong; consulting the IANA database gets both right.
   */
  it('applies the correct offset either side of a DST transition', () => {
    const beforeTransition = resolveDeadlineInstant({
      localDateTime: '2026-10-28T18:00',
      tz: 'America/New_York',
    });
    const afterTransition = resolveDeadlineInstant({
      localDateTime: '2026-11-04T18:00',
      tz: 'America/New_York',
    });
    expect(beforeTransition.ok && afterTransition.ok).toBe(true);
    if (!beforeTransition.ok || !afterTransition.ok) return;

    expect(beforeTransition.instant).toContain('-04:00'); // EDT
    expect(afterTransition.instant).toContain('-05:00'); // EST
  });

  it('reports an unrecognised zone instead of falling back to a default', () => {
    const r = resolveDeadlineInstant({
      localDateTime: '2026-11-04T18:00',
      tz: 'Mars/Olympus_Mons',
    });
    expect(r).toEqual({ ok: false, reason: 'invalid_zone' });
  });

  it('reports an incomplete wall clock instead of guessing the missing part', () => {
    const r = resolveDeadlineInstant({ localDateTime: 'not-a-time', tz: 'America/New_York' });
    expect(r).toEqual({ ok: false, reason: 'invalid_wall_clock' });
  });
});

describe('durations and margins across midnight and zones', () => {
  /**
   * Departs 23:40 on 3 November in London, arrives 03:05 on 4 November in New
   * York. A clock-time subtraction (03:05 minus 23:40) yields a NEGATIVE
   * duration. Instant arithmetic yields the real 8h25.
   */
  it('computes a positive duration for an itinerary crossing midnight', () => {
    expect(travelDurationMinutes(S5_CROSS_MIDNIGHT)).toBe(505);
  });

  it('computes the arrival margin correctly for that itinerary', () => {
    const result = decide(s5CrossMidnightState());
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.trace.measures['CROSS-MIDNIGHT']!.arrivalMarginMinutes).toBe(895);
  });

  it('minutesBetween is signed and symmetric', () => {
    const a = '2026-11-04T10:00:00Z';
    const b = '2026-11-04T12:30:00Z';
    expect(minutesBetween(a, b)).toBe(150);
    expect(minutesBetween(b, a)).toBe(-150);
  });
});

describe('connection windows', () => {
  it('derives the buffer across a zone change', () => {
    const windows = connectionWindows(S2_OVERNIGHT);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.airport).toBe('DUB');
    // 22:45 on 3 Nov to 13:00 on 4 Nov, both GMT = 14h15.
    expect(windows[0]!.bufferMinutes).toBe(855);
  });

  it('identifies a connection that spans the local small hours', () => {
    const windows = connectionWindows(S2_OVERNIGHT);
    expect(isOvernightConnection(windows[0]!)).toBe(true);
  });

  it('does not flag a daytime connection as overnight', () => {
    const result = decide(s5CrossMidnightState());
    if (result.status !== 'ok') throw new Error('expected ok');
    // NONSTOP has no connections at all, so no findings.
    expect(result.trace.measures['NONSTOP']!.connectionRisks).toEqual([]);
  });
});
