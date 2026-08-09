// shop-drawer.tsx (a screen component) transitively imports '@/lib/platform',
// which constructs the real Supabase client at module load and throws without
// EXPO_PUBLIC_SUPABASE_* env vars -- same reason platform-shops.test.ts mocks
// this module. addMonths itself never touches Supabase; this only unblocks
// the import.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

import { periodMonths } from '@/lib/billing-period';
import { addMonths } from '@/components/platform/shop-drawer';

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

// periodMonths('year') === 12 on its own proves nothing about what the drawer
// actually does with it -- the two have to be composed, the way shop-drawer.tsx
// itself does at its three call sites, to prove a yearly plan really covers a
// year rather than the one-month default the bug above would silently fall
// back to.
describe('addMonths(from, periodMonths(interval))', () => {
  it('covers a monthly plan to the same day next month', () => {
    expect(addMonths('2026-03-15', periodMonths('month'))).toBe('2026-04-15');
  });

  it('covers a yearly plan to the same day a year later', () => {
    expect(addMonths('2026-03-15', periodMonths('year'))).toBe('2027-03-15');
  });

  it('clamps a month-end date into the shorter month, monthly', () => {
    // 2026 is not a leap year, so 31 Jan + 1 month lands on 28 Feb, not 3 Mar.
    expect(addMonths('2026-01-31', periodMonths('month'))).toBe('2026-02-28');
  });

  it('clamps a month-end date into the shorter month, yearly', () => {
    // 2027 is not a leap year either; the year hop still has to clamp Jan 31
    // if it ever lands on a 28-day February (it doesn't here, since Jan has
    // 31 days both years), so this instead proves the year hop preserves the
    // day-of-month when the target month can hold it.
    expect(addMonths('2026-01-31', periodMonths('year'))).toBe('2027-01-31');
  });

  it('clamps 31 Jan + 1 month into a leap February', () => {
    // 2028 is a leap year: 31 Jan 2028 + 1 month clamps to 29 Feb, not 28.
    expect(addMonths('2028-01-31', periodMonths('month'))).toBe('2028-02-29');
  });
});
