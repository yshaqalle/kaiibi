import {
  annualCents,
  dailySalaryCents,
  daysInYear,
  formatPayRate,
  formatPayRateLong,
  isValidRateInput,
  isWholeCalendarMonth,
  payRateUnitLabel,
  rateInputToCents,
  toMonthlyCents,
} from '@/lib/pay-rate';

describe('toMonthlyCents', () => {
  it('leaves a monthly figure alone', () => {
    expect(toMonthlyCents(300000, 'monthly')).toBe(300000);
  });

  it('divides a yearly figure by twelve', () => {
    expect(toMonthlyCents(3600000, 'yearly')).toBe(300000);
  });

  // The tempting wrong answer is x4 -- four weeks is not a month, and it
  // under-pays by about 8% a year. 52/12 is what makes a weekly and a
  // monthly quote agree over a full year.
  it('converts weekly using 52/12, not 4', () => {
    expect(toMonthlyCents(70000, 'weekly')).toBe(303333);
    expect(toMonthlyCents(70000, 'weekly')).not.toBe(280000);
  });
});

describe('annualCents', () => {
  it('is twelve monthly payments', () => {
    expect(annualCents(300000)).toBe(3600000);
  });
});

describe('daysInYear', () => {
  it('is 365 in a common year', () => {
    expect(daysInYear(2026)).toBe(365);
  });

  it('is 366 in a leap year', () => {
    expect(daysInYear(2024)).toBe(366);
  });

  // The century rules, which a naive %4 check gets wrong.
  it('handles the century exceptions', () => {
    expect(daysInYear(2100)).toBe(365);
    expect(daysInYear(2000)).toBe(366);
  });
});

describe('dailySalaryCents', () => {
  // Deliberately fractional: rounding here and then multiplying by a day
  // count compounds the error. The caller rounds once, at the end.
  it('returns an unrounded daily rate', () => {
    expect(dailySalaryCents(300000, 2026)).toBeCloseTo(9863.0137, 3);
  });

  it('spreads over 366 days in a leap year', () => {
    expect(dailySalaryCents(300000, 2024)).toBeCloseTo(9836.0656, 3);
  });
});

describe('isWholeCalendarMonth', () => {
  it('accepts a full 31-day month', () => {
    expect(isWholeCalendarMonth('2026-08-01', '2026-08-31')).toBe(true);
  });

  it('accepts a full February', () => {
    expect(isWholeCalendarMonth('2026-02-01', '2026-02-28')).toBe(true);
  });

  it('accepts a full leap February', () => {
    expect(isWholeCalendarMonth('2024-02-01', '2024-02-29')).toBe(true);
  });

  it('rejects a month missing its last day', () => {
    expect(isWholeCalendarMonth('2026-08-01', '2026-08-30')).toBe(false);
  });

  it('rejects a period not starting on the 1st', () => {
    expect(isWholeCalendarMonth('2026-08-02', '2026-08-31')).toBe(false);
  });

  it('rejects a span crossing two months', () => {
    expect(isWholeCalendarMonth('2026-08-01', '2026-09-30')).toBe(false);
  });
});

describe('rateInputToCents', () => {
  it('is null for blank input', () => {
    expect(rateInputToCents('   ', 'salary', 'monthly')).toBeNull();
  });

  it('converts a yearly salary entry to monthly cents', () => {
    expect(rateInputToCents('36000', 'salary', 'yearly')).toBe(300000);
  });

  // Hourly is per hour by definition, so the entry unit must not touch it.
  it('ignores the entry unit for hourly pay', () => {
    expect(rateInputToCents('8.50', 'hourly', 'yearly')).toBe(850);
  });

  // Fixed is per pay run by definition -- also not converted.
  it('ignores the entry unit for fixed pay', () => {
    expect(rateInputToCents('500', 'fixed', 'yearly')).toBe(50000);
  });
});

describe('isValidRateInput', () => {
  it('accepts blank input, which clears the rate to null', () => {
    expect(isValidRateInput('')).toBe(true);
  });

  it('accepts whitespace-only input as blank', () => {
    expect(isValidRateInput('   ')).toBe(true);
  });

  // This is the regression the fix exists to prevent: a stored 0 rate must
  // not be indistinguishable from unparseable garbage, or opening the modal
  // to edit an unrelated field and saving throws "Enter a valid pay rate."
  it('accepts a literal 0 as a legitimately-typed rate, not garbage', () => {
    expect(isValidRateInput('0')).toBe(true);
  });

  it('accepts a whole-dollar figure', () => {
    expect(isValidRateInput('3000')).toBe(true);
  });

  it('accepts a figure with cents', () => {
    expect(isValidRateInput('8.50')).toBe(true);
  });

  it('rejects unparseable letters', () => {
    expect(isValidRateInput('abc')).toBe(false);
  });

  it('rejects a negative sign', () => {
    expect(isValidRateInput('-5')).toBe(false);
  });

  it('rejects multiple decimal points', () => {
    expect(isValidRateInput('1.2.3')).toBe(false);
  });

  it('rejects a bare decimal point', () => {
    expect(isValidRateInput('.')).toBe(false);
  });
});

describe('formatPayRate', () => {
  it('labels salary per month', () => {
    expect(formatPayRate('salary', 300000)).toBe('$3,000.00 / month');
  });

  it('labels hourly per hour', () => {
    expect(formatPayRate('hourly', 850)).toBe('$8.50 / hour');
  });

  it('labels fixed per run', () => {
    expect(formatPayRate('fixed', 50000)).toBe('$500.00 / run');
  });

  it('dashes when there is no rate', () => {
    expect(formatPayRate('salary', null)).toBe('—');
    expect(formatPayRate(null, 300000)).toBe('—');
  });
});

describe('formatPayRateLong', () => {
  // Both figures, always, so the number can never be misread as annual again.
  it('shows monthly and annual for a salary', () => {
    expect(formatPayRateLong('salary', 300000)).toBe('$3,000.00 / month · $36,000.00 / year');
  });

  it('is unchanged for hourly, which has no annual equivalent', () => {
    expect(formatPayRateLong('hourly', 850)).toBe('$8.50 / hour');
  });
});

describe('payRateUnitLabel', () => {
  it('names the unit for a CSV column', () => {
    expect(payRateUnitLabel('hourly')).toBe('per hour');
    expect(payRateUnitLabel('salary')).toBe('per month');
    expect(payRateUnitLabel('fixed')).toBe('per run');
    expect(payRateUnitLabel(null)).toBe('');
  });
});
