import { foreignCentsToUsdCents, formatAccountingCents, formatCents, formatForeignCents, toCents, usdCentsToForeignCents } from '@/lib/currency';

describe('formatAccountingCents', () => {
  it('groups thousands', () => {
    expect(formatAccountingCents(208500)).toBe('$2,085.00');
    expect(formatAccountingCents(123456789)).toBe('$1,234,567.89');
  });

  it('keeps two decimals for small amounts', () => {
    expect(formatAccountingCents(0)).toBe('$0.00');
    expect(formatAccountingCents(5)).toBe('$0.05');
  });

  // The bug this formatter exists to fix: formatCents renders a loss as
  // "$-1925.10", stranding the sign inside the amount.
  it('puts the minus sign before the currency symbol', () => {
    expect(formatAccountingCents(-192510)).toBe('-$1,925.10');
  });

  it('uses accounting parentheses when asked', () => {
    expect(formatAccountingCents(-192510, { negativeStyle: 'parens' })).toBe('($1,925.10)');
    expect(formatAccountingCents(192510, { negativeStyle: 'parens' })).toBe('$1,925.10');
  });
});

describe('toCents', () => {
  it('converts a decimal string to integer cents', () => {
    expect(toCents('24.00')).toBe(2400);
  });

  it('strips a leading dollar sign', () => {
    expect(toCents('$24.5')).toBe(2450);
  });

  it('rounds to the nearest cent', () => {
    expect(toCents('24.005')).toBe(2401);
  });

  it('returns 0 for empty or invalid input', () => {
    expect(toCents('')).toBe(0);
    expect(toCents('abc')).toBe(0);
  });

  it('returns 0 for negative input', () => {
    expect(toCents('-5')).toBe(0);
  });
});

describe('formatCents', () => {
  it('formats cents as a dollar string', () => {
    expect(formatCents(2400)).toBe('$24.00');
  });

  it('pads single-digit cents', () => {
    expect(formatCents(2405)).toBe('$24.05');
  });

  it('formats zero', () => {
    expect(formatCents(0)).toBe('$0.00');
  });
});

describe('foreignCentsToUsdCents', () => {
  it('converts foreign cents to USD cents using the rate (units of foreign currency per $1)', () => {
    // 500,000 Sl Sh cents (i.e. 5,000 Sl Sh) at 115 Sl Sh/$1 = $43.4783 -> 4348 cents
    expect(foreignCentsToUsdCents(500000, 115)).toBe(4348);
  });

  it('rounds to the nearest USD cent', () => {
    expect(foreignCentsToUsdCents(100, 3)).toBe(33); // 33.33 rounds down
    expect(foreignCentsToUsdCents(200, 3)).toBe(67); // 66.67 rounds up
  });

  it('returns 0 for 0 foreign cents', () => {
    expect(foreignCentsToUsdCents(0, 115)).toBe(0);
  });
});

describe('usdCentsToForeignCents', () => {
  it('converts USD cents to foreign cents using the rate', () => {
    expect(usdCentsToForeignCents(4348, 115)).toBe(500020); // inverse of above, off by rounding
  });

  it('round-trips within a cent for whole-dollar amounts', () => {
    const usd = 1000; // $10.00
    const foreign = usdCentsToForeignCents(usd, 115);
    expect(foreignCentsToUsdCents(foreign, 115)).toBeCloseTo(usd, -1);
  });
});

describe('formatForeignCents', () => {
  it('formats a whole-unit amount without decimals', () => {
    expect(formatForeignCents(500000, 'Sl Sh')).toBe('5,000 Sl Sh');
  });

  it('formats a fractional amount with 2 decimals', () => {
    expect(formatForeignCents(4348, '$')).toBe('43.48 $');
  });

  it('formats zero', () => {
    expect(formatForeignCents(0, 'Br')).toBe('0 Br');
  });
});
