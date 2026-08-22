import { ageReceivables, bucketForDays, customerBalanceSummary } from '@/lib/receivable-aging';
import type { CustomerBalance } from '@/lib/balances';

const NOW = new Date('2026-08-22T12:00:00.000Z').getTime();
const DAY = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

function balance(overrides: Partial<CustomerBalance> = {}): CustomerBalance {
  return {
    customerId: 'c1',
    customerName: 'Amina',
    saleId: 's1',
    saleCreatedAt: daysAgo(5),
    totalCents: 10_000,
    paidCents: 0,
    refundedCents: 0,
    owedCents: 10_000,
    ...overrides,
  };
}

describe('bucketForDays', () => {
  it('uses the conventional 30-day bands, inclusive at each top', () => {
    // Conventional because every accountant, bank and factoring company reads
    // a receivables report this way — our own bands would make it unusable by
    // the people a shop shows it to.
    expect(bucketForDays(0)).toBe('current');
    expect(bucketForDays(29)).toBe('current');
    expect(bucketForDays(30)).toBe('30');
    expect(bucketForDays(59)).toBe('30');
    expect(bucketForDays(60)).toBe('60');
    expect(bucketForDays(89)).toBe('60');
    expect(bucketForDays(90)).toBe('90');
    expect(bucketForDays(4000)).toBe('90');
  });
});

describe('ageReceivables', () => {
  it('ages a customer on their OLDEST debt, not on each sale', () => {
    // Nobody chases the part of a debt that is 40 days old.
    const aging = ageReceivables(
      [
        balance({ saleId: 's1', saleCreatedAt: daysAgo(95), owedCents: 2_000 }),
        balance({ saleId: 's2', saleCreatedAt: daysAgo(3), owedCents: 8_000 }),
      ],
      NOW
    );
    expect(aging.rows).toHaveLength(1);
    expect(aging.rows[0].owedCents).toBe(10_000);
    expect(aging.rows[0].bucketKey).toBe('90');
    expect(aging.rows[0].saleCount).toBe(2);
  });

  it('orders oldest first — a risk report, not a call sheet', () => {
    const aging = ageReceivables(
      [
        balance({ customerId: 'big', customerName: 'Big', saleCreatedAt: daysAgo(2), owedCents: 90_000 }),
        balance({ customerId: 'old', customerName: 'Old', saleCreatedAt: daysAgo(120), owedCents: 1_000 }),
      ],
      NOW
    );
    expect(aging.rows.map((row) => row.customerId)).toEqual(['old', 'big']);
  });

  it('reports each band’s share of the total', () => {
    const aging = ageReceivables(
      [
        balance({ customerId: 'a', saleCreatedAt: daysAgo(1), owedCents: 7_500 }),
        balance({ customerId: 'b', saleCreatedAt: daysAgo(100), owedCents: 2_500 }),
      ],
      NOW
    );
    expect(aging.totalOwedCents).toBe(10_000);
    expect(aging.buckets.find((b) => b.key === 'current')?.pct).toBe(75);
    expect(aging.buckets.find((b) => b.key === '90')?.pct).toBe(25);
  });

  it('counts 60 days and over as at risk', () => {
    const aging = ageReceivables(
      [
        balance({ customerId: 'a', saleCreatedAt: daysAgo(59), owedCents: 1_000 }),
        balance({ customerId: 'b', saleCreatedAt: daysAgo(60), owedCents: 2_000 }),
      ],
      NOW
    );
    expect(aging.atRiskCents).toBe(2_000);
  });

  it('reports no share at all rather than NaN when nothing is owed', () => {
    const aging = ageReceivables([], NOW);
    expect(aging.totalOwedCents).toBe(0);
    expect(aging.buckets.every((bucket) => bucket.pct === 0)).toBe(true);
  });
});

describe('customerBalanceSummary', () => {
  it('orders by size — this one is read down when reconciling an account', () => {
    const rows = customerBalanceSummary(
      [
        balance({ customerId: 'small', customerName: 'Small', saleCreatedAt: daysAgo(200), owedCents: 500 }),
        balance({ customerId: 'large', customerName: 'Large', saleCreatedAt: daysAgo(1), owedCents: 50_000 }),
      ],
      NOW
    );
    expect(rows.map((row) => row.customerId)).toEqual(['large', 'small']);
  });

  it('names a customer nobody named, because this report gets exported', () => {
    // A blank in a column of names reads as a bug rather than as a customer
    // with no name on file.
    const [row] = customerBalanceSummary([balance({ customerName: '' })], NOW);
    expect(row.customerName).toBe('Unnamed customer');
  });
});
