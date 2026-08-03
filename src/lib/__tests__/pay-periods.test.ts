import {
  isWholePayPeriod,
  payPeriodsFor,
  perPaymentCents,
  periodsPerYear,
} from '@/lib/pay-periods';

describe('periodsPerYear', () => {
  it('counts real payment dates, not month divisions', () => {
    expect(periodsPerYear('weekly')).toBe(52);
    expect(periodsPerYear('biweekly')).toBe(26);
    expect(periodsPerYear('semimonthly')).toBe(24);
    expect(periodsPerYear('monthly')).toBe(12);
  });
});

describe('perPaymentCents', () => {
  // The payoff of storing salary as monthly: the common case needs no
  // division at all, so it cannot drift.
  it('is the stored figure exactly for a monthly cadence', () => {
    expect(perPaymentCents(300000, 'monthly')).toBe(300000);
  });

  it('is exactly half for a semi-monthly cadence', () => {
    expect(perPaymentCents(300000, 'semimonthly')).toBe(150000);
  });

  it('divides the annual figure for weekly and biweekly', () => {
    expect(perPaymentCents(300000, 'weekly')).toBe(69231);
    expect(perPaymentCents(300000, 'biweekly')).toBe(138462);
  });

  // 26 biweekly payments must add up to the year, not to 24 months.
  it('keeps a year of payments close to the annual figure', () => {
    expect(perPaymentCents(300000, 'biweekly') * 26).toBe(3600012);
    expect(perPaymentCents(300000, 'monthly') * 12).toBe(3600000);
  });
});

describe('payPeriodsFor — monthly', () => {
  it('returns whole calendar months', () => {
    const { periods, reason } = payPeriodsFor('monthly', null, '2026-08-01', '2026-09-30');
    expect(reason).toBe('ok');
    expect(periods).toEqual([
      { start: '2026-08-01', end: '2026-08-31' },
      { start: '2026-09-01', end: '2026-09-30' },
    ]);
  });

  it('returns the containing month even for a partial range', () => {
    const { periods } = payPeriodsFor('monthly', null, '2026-08-10', '2026-08-12');
    expect(periods).toEqual([{ start: '2026-08-01', end: '2026-08-31' }]);
  });

  it('needs no anchor', () => {
    expect(payPeriodsFor('monthly', null, '2026-08-01', '2026-08-31').reason).toBe('ok');
  });
});

describe('payPeriodsFor — semimonthly', () => {
  // The second half varies in length; the first never does.
  it('splits a 31-day month at the 15th', () => {
    const { periods } = payPeriodsFor('semimonthly', null, '2026-08-01', '2026-08-31');
    expect(periods).toEqual([
      { start: '2026-08-01', end: '2026-08-15' },
      { start: '2026-08-16', end: '2026-08-31' },
    ]);
  });

  it('splits a 28-day February at the 15th', () => {
    const { periods } = payPeriodsFor('semimonthly', null, '2026-02-01', '2026-02-28');
    expect(periods).toEqual([
      { start: '2026-02-01', end: '2026-02-15' },
      { start: '2026-02-16', end: '2026-02-28' },
    ]);
  });

  it('handles a leap February', () => {
    const { periods } = payPeriodsFor('semimonthly', null, '2024-02-01', '2024-02-29');
    expect(periods[1]).toEqual({ start: '2024-02-16', end: '2024-02-29' });
  });
});

describe('payPeriodsFor — weekly and biweekly', () => {
  it('counts forward from the anchor', () => {
    const { periods } = payPeriodsFor('weekly', '2026-08-03', '2026-08-03', '2026-08-23');
    expect(periods).toEqual([
      { start: '2026-08-03', end: '2026-08-09' },
      { start: '2026-08-10', end: '2026-08-16' },
      { start: '2026-08-17', end: '2026-08-23' },
    ]);
  });

  it('uses 14-day blocks when biweekly', () => {
    const { periods } = payPeriodsFor('biweekly', '2026-08-03', '2026-08-03', '2026-08-30');
    expect(periods).toEqual([
      { start: '2026-08-03', end: '2026-08-16' },
      { start: '2026-08-17', end: '2026-08-30' },
    ]);
  });

  // The anchor may predate the range by years; periods must still land on the
  // anchor's rhythm rather than restarting at the range boundary.
  it('keeps the anchor rhythm when the range starts much later', () => {
    // 2026-01-05 + 14n lands on Jul 20, then Aug 3. The period containing
    // Aug 1 is therefore Jul 20 - Aug 2, NOT a period restarting on Aug 1.
    const { periods } = payPeriodsFor('biweekly', '2026-01-05', '2026-08-01', '2026-08-20');
    expect(periods[0]).toEqual({ start: '2026-07-20', end: '2026-08-02' });
    expect(periods[1]).toEqual({ start: '2026-08-03', end: '2026-08-16' });
    expect(periods[2]).toEqual({ start: '2026-08-17', end: '2026-08-30' });
  });

  it('works when the anchor is after the range', () => {
    const { periods } = payPeriodsFor('weekly', '2026-08-31', '2026-08-03', '2026-08-16');
    expect(periods).toEqual([
      { start: '2026-08-03', end: '2026-08-09' },
      { start: '2026-08-10', end: '2026-08-16' },
    ]);
  });

  // Crossing a year boundary must not restart the count.
  it('crosses a year boundary without drifting', () => {
    const { periods } = payPeriodsFor('biweekly', '2026-12-07', '2026-12-07', '2027-01-17');
    expect(periods).toEqual([
      { start: '2026-12-07', end: '2026-12-20' },
      { start: '2026-12-21', end: '2027-01-03' },
      { start: '2027-01-04', end: '2027-01-17' },
    ]);
  });

  it('reports that an anchor is required rather than guessing', () => {
    expect(payPeriodsFor('weekly', null, '2026-08-01', '2026-08-31')).toEqual({
      periods: [],
      reason: 'anchor_required',
    });
    expect(payPeriodsFor('biweekly', null, '2026-08-01', '2026-08-31').reason).toBe('anchor_required');
  });
});

describe('isWholePayPeriod', () => {
  it('accepts a calendar month for a monthly cadence', () => {
    expect(isWholePayPeriod('monthly', null, '2026-08-01', '2026-08-31')).toBe(true);
  });

  it('rejects a part month for a monthly cadence', () => {
    expect(isWholePayPeriod('monthly', null, '2026-08-01', '2026-08-07')).toBe(false);
  });

  it('accepts either half for a semi-monthly cadence', () => {
    expect(isWholePayPeriod('semimonthly', null, '2026-08-01', '2026-08-15')).toBe(true);
    expect(isWholePayPeriod('semimonthly', null, '2026-08-16', '2026-08-31')).toBe(true);
  });

  it('accepts an anchored biweekly block', () => {
    expect(isWholePayPeriod('biweekly', '2026-08-03', '2026-08-03', '2026-08-16')).toBe(true);
    expect(isWholePayPeriod('biweekly', '2026-08-03', '2026-08-03', '2026-08-15')).toBe(false);
  });

  it('is false when the anchor is missing', () => {
    expect(isWholePayPeriod('weekly', null, '2026-08-03', '2026-08-09')).toBe(false);
  });
});
