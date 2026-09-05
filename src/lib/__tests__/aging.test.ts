import { agingTotals, AGING_BUCKETS, bucketForDays, daysSince, inBucket } from '@/lib/aging';

type Debt = { who: string; age: number; cents: number };
const DEBTS: Debt[] = [
  { who: 'Amal', age: 4, cents: 3280 },
  { who: 'Iman', age: 29, cents: 1000 },
  { who: 'Hibo', age: 34, cents: 12807 },
  { who: 'Sagal', age: 61, cents: 5000 },
  { who: 'Deqa', age: 400, cents: 900 },
];
const read = { days: (d: Debt) => d.age, cents: (d: Debt) => d.cents };

describe('which bucket a debt falls in', () => {
  it('puts anything under a month in Current', () => {
    expect(bucketForDays(0)).toBe('current');
    expect(bucketForDays(29)).toBe('current');
  });

  it('moves on the boundary day, not the day after', () => {
    // 30 is the first day of the 30-59 bucket. Off by one here and every
    // figure on the strip is wrong for one day in thirty.
    expect(bucketForDays(30)).toBe('d30');
    expect(bucketForDays(59)).toBe('d30');
    expect(bucketForDays(60)).toBe('d60');
    expect(bucketForDays(89)).toBe('d60');
    expect(bucketForDays(90)).toBe('d90');
  });

  it('leaves the oldest bucket open-ended so nothing falls out of the total', () => {
    expect(bucketForDays(365)).toBe('d90');
    expect(bucketForDays(99999)).toBe('d90');
  });

  it('clamps a negative age into the newest bucket rather than losing it', () => {
    // A back-dated bill or a skewed clock must not vanish from the strip.
    expect(bucketForDays(-5)).toBe('current');
  });
});

describe('the strip', () => {
  it('always shows all four buckets, including the empty ones', () => {
    const totals = agingTotals([DEBTS[0]], read);
    expect(totals).toHaveLength(4);
    expect(totals.map((t) => t.key)).toEqual(AGING_BUCKETS.map((b) => b.key));
    // "90+ is zero" is the reassurance, and dropping the tile would delete it.
    expect(totals.find((t) => t.key === 'd90')).toMatchObject({ cents: 0, count: 0 });
  });

  it('totals the money and counts the debts in each bucket', () => {
    const totals = agingTotals(DEBTS, read);
    const by = Object.fromEntries(totals.map((t) => [t.key, t]));
    expect(by.current).toMatchObject({ cents: 3280 + 1000, count: 2 });
    expect(by.d30).toMatchObject({ cents: 12807, count: 1 });
    expect(by.d60).toMatchObject({ cents: 5000, count: 1 });
    expect(by.d90).toMatchObject({ cents: 900, count: 1 });
  });

  it('reconciles — the buckets add up to the whole list', () => {
    // The one property that makes the strip trustworthy. If these ever differ,
    // the tab above and the tiles below are telling a shopkeeper two numbers.
    const totals = agingTotals(DEBTS, read);
    const summed = totals.reduce((n, t) => n + t.cents, 0);
    expect(summed).toBe(DEBTS.reduce((n, d) => n + d.cents, 0));
    expect(totals.reduce((n, t) => n + t.count, 0)).toBe(DEBTS.length);
  });

  it('serves both directions from one function', () => {
    // Money owed BY the shop is the same arithmetic as money owed TO it, which
    // is why there is one implementation and not two that can drift.
    const bills = [{ who: 'Landlord', age: 61, cents: 32000 }];
    expect(agingTotals(bills, read).find((t) => t.key === 'd60')).toMatchObject({ cents: 32000, count: 1 });
  });
});

describe('filtering the table under the strip', () => {
  it('returns only the chosen bucket', () => {
    expect(inBucket(DEBTS, 'current', read.days).map((d) => d.who)).toEqual(['Amal', 'Iman']);
    expect(inBucket(DEBTS, 'd90', read.days).map((d) => d.who)).toEqual(['Deqa']);
  });

  it('returns everything when no bucket is chosen — the tab’s ordinary state', () => {
    expect(inBucket(DEBTS, null, read.days)).toHaveLength(DEBTS.length);
  });

  it('preserves the list’s own order, which is the order the screen sorted', () => {
    // Biggest debt first is what the collections list is FOR; a filter that
    // reshuffles would undo the screen's whole argument.
    expect(inBucket(DEBTS, null, read.days)).toEqual(DEBTS);
  });
});

describe('how old, in days', () => {
  const now = new Date('2026-09-05T12:00:00Z').getTime();

  it('floors to whole days', () => {
    expect(daysSince('2026-09-02T23:00:00Z', now)).toBe(2);
  });

  it('clamps a future timestamp at zero rather than going negative', () => {
    expect(daysSince('2026-09-09T00:00:00Z', now)).toBe(0);
  });
});
