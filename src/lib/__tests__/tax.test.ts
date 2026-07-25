import { taxCentsFor } from '@/lib/tax';

describe('taxCentsFor', () => {
  it('computes tax at the given percent, rounded to the nearest cent', () => {
    expect(taxCentsFor(10000, 2.5)).toBe(250); // $100.00 at 2.5% = $2.50
  });

  it('rounds to the nearest cent on a non-round result', () => {
    expect(taxCentsFor(999, 2.5)).toBe(25); // 24.975 rounds to 25
  });

  it('returns 0 for a zero base', () => {
    expect(taxCentsFor(0, 2.5)).toBe(0);
  });

  it('returns 0 for a zero rate', () => {
    expect(taxCentsFor(10000, 0)).toBe(0);
  });
});
