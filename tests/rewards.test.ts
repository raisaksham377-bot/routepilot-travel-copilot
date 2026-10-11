import { describe, expect, it } from 'vitest';
import { decide } from '@/lib/decision';
import { renderBrief } from '@/lib/brief/render';
import {
  s3,
  s3ModuleOffState,
  s3NoCounterpartState,
  s3NotComparableState,
} from '@/lib/data/scenarios';

/**
 * The optional rewards module.
 *
 * Two things are under test here beyond the arithmetic: that the module refuses
 * to produce a number when the comparison is not valid, and that a cheap-looking
 * award option is never described as cheapest or best value.
 */

describe('effective cents-per-point', () => {
  it('computes (cash ticket - award co-payment) / points, in cents', () => {
    const result = decide(s3.state);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    const a = result.trace.rewards['AWARD-BA183']!;

    expect(a.applicable).toBe(true);
    expect(a.reason).toBeNull();
    expect(a.counterpartOptionId).toBe('CASH-BA183');
    expect(a.inputs).toEqual({
      comparableCashTicketTotal: 2400,
      awardCashCoPayment: 1150,
      pointsRequired: 120000,
    });
    // (2400 - 1150) * 100 / 120000 = 1.041666...
    expect(a.effectiveCpp).toBeCloseTo(1.0417, 4);
  });

  it('reports the redemption as below the user’s own valuation', () => {
    const result = decide(s3.state);
    if (result.status !== 'ok') throw new Error('expected ok');
    const a = result.trace.rewards['AWARD-BA183']!;
    expect(a.valuationCpp).toBe(1.5);
    expect(a.verdict).toBe('below_valuation');
  });

  /**
   * THE FEE DOUBLE-COUNT GUARD.
   *
   * An earlier spec draft had one "cash fare" field and subtracted award fees
   * from it, which double-counted fees whenever both figures were present.
   * Cash payable on an award booking is the co-payment ALONE -- not the cash
   * ticket, and not the two added together.
   */
  it('never double-counts fees: cash payable on an award is the co-payment alone', () => {
    const result = decide(s3.state);
    if (result.status !== 'ok') throw new Error('expected ok');
    const award = result.trace.measures['AWARD-BA183']!;

    expect(award.cashPayable).toBe(1150);
    expect(award.cashPayable).not.toBe(2400);
    expect(award.cashPayable).not.toBe(3550); // 2400 + 1150
    // The cash baseline is still carried, but as the rewards comparator only.
    expect(award.comparableCashTicketTotal).toBeNull();
    expect(award.awardCashCoPayment).toBe(1150);
  });

  it('does not add the points valuation into any cash figure', () => {
    const result = decide(s3.state);
    if (result.status !== 'ok') throw new Error('expected ok');
    const award = result.trace.measures['AWARD-BA183']!;
    // 120000 points at 1.5c would be 1800. It must appear nowhere as cash.
    expect(award.cashPayable).not.toBe(1150 + 1800);
    expect(award.cashPayable).not.toBe(1800);
  });
});

describe('comparability refusals', () => {
  it('refuses to compute when the cabins differ, and names the check', () => {
    const result = decide(s3NotComparableState());
    if (result.status !== 'ok') throw new Error('expected ok');
    const a = result.trace.rewards['AWARD-ECONOMY']!;

    expect(a.effectiveCpp).toBeNull();
    expect(a.reason).toBe('not_comparable');
    expect(a.failedCheck).toContain('economy');
  });

  it('refuses to compute when there is no cash counterpart at all', () => {
    const result = decide(s3NoCounterpartState());
    if (result.status !== 'ok') throw new Error('expected ok');
    const a = result.trace.rewards['AWARD-BA183']!;

    expect(a.effectiveCpp).toBeNull();
    expect(a.reason).toBe('no_cash_counterpart');
    expect(a.failedCheck).toContain('no cash option');
  });
});

describe('the module is genuinely optional', () => {
  it('reports module_disabled and still produces a full decision when off', () => {
    const result = decide(s3ModuleOffState());
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);

    expect(result.trace.rewards['AWARD-BA183']!.reason).toBe('module_disabled');
    expect(result.trace.rewards['AWARD-BA183']!.effectiveCpp).toBeNull();

    // The core product is unaffected: ranking and a recommendation still happen.
    expect(result.ranked.length).toBe(2);
    expect(result.recommendation.chosenOptionId).toBeTruthy();
  });

  it('refuses when rewards are not permitted, even with the module on', () => {
    const state = { ...s3.state, profile: { ...s3.state.profile, rewardsPermitted: false } };
    const result = decide(state);
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.trace.rewards['AWARD-BA183']!.reason).toBe('rewards_not_permitted');
  });
});

describe('wording when an award wins on cash outlay', () => {
  /**
   * Under lowest_cash_outlay the award ranks first precisely because only the
   * co-payment counts as cash. It must never be called cheapest or best value:
   * it also consumes 120,000 points, whose opportunity cost this engine does
   * not price.
   */
  it('says "plus N points" and never claims cheapest or best value', () => {
    const result = decide(s3.state);
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.recommendation.chosenOptionId).toBe('AWARD-BA183');

    const brief = renderBrief(s3.state, result).toLowerCase();

    expect(brief).toContain('plus 120000 points');
    for (const forbidden of ['cheapest', 'lowest cost', 'best value', 'best deal']) {
      expect(brief).not.toContain(forbidden);
    }
  });

  it('states the points consumed in the recommendation reasons', () => {
    const result = decide(s3.state);
    if (result.status !== 'ok') throw new Error('expected ok');
    const joined = result.recommendation.reasons.join(' ');
    expect(joined).toContain('120000 points');
  });
});
