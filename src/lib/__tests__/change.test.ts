import { isFavourable, percentChange } from '@/lib/change';

describe('percentChange', () => {
  it('reports a straightforward rise and fall', () => {
    expect(percentChange(110, 100)).toBeCloseTo(10);
    expect(percentChange(90, 100)).toBeCloseTo(-10);
  });

  it('keeps the sign tracking direction when the baseline is negative', () => {
    // The trap this function exists for. A loss deepening from -100 to -200 is
    // worse; dividing by the signed baseline returns +100% and points the
    // badge up on the worst week of the year.
    expect(percentChange(-200, -100)).toBeCloseTo(-100);
    // And a loss shrinking is an improvement.
    expect(percentChange(-50, -100)).toBeCloseTo(50);
  });

  it('returns null rather than infinity when there was nothing before', () => {
    expect(percentChange(500, 0)).toBeNull();
  });

  it('returns null when no prior window was fetched', () => {
    expect(percentChange(500, null)).toBeNull();
    expect(percentChange(500, undefined)).toBeNull();
  });
});

describe('isFavourable', () => {
  it('treats a rise as good news by default', () => {
    expect(isFavourable(110, 100)).toBe(true);
    expect(isFavourable(90, 100)).toBe(false);
  });

  it('inverts for figures where lower is better, without moving the arrow', () => {
    // Expenses up is unfavourable, but the arrow still points up -- direction
    // and desirability are different facts.
    expect(isFavourable(110, 100, true)).toBe(false);
    expect(isFavourable(90, 100, true)).toBe(true);
  });

  it('counts no change as favourable rather than as a fall', () => {
    expect(isFavourable(100, 100)).toBe(true);
  });
});
