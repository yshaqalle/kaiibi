import { periodMonths } from '@/lib/billing-period';

// addMonths(from, 1) was hardcoded at three call sites in shop-drawer.tsx, so a
// yearly plan handed the operator a one-month period and relied on them
// noticing. Latent rather than live — no seeded plan uses 'year' — which is
// exactly the kind of bug that ships the day one does.

describe('periodMonths', () => {
  it('gives a monthly plan one month', () => {
    expect(periodMonths('month')).toBe(1);
  });

  it('gives a yearly plan twelve months', () => {
    expect(periodMonths('year')).toBe(12);
  });

  it('falls back to one month when a plan has no interval', () => {
    // Free and Trial both have a null interval. They are never paid for, but
    // the drawer still renders defaults for them.
    expect(periodMonths(null)).toBe(1);
  });
});
