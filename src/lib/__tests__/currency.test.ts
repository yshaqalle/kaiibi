import { formatCents, toCents } from '@/lib/currency';

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
