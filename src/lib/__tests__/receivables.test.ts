import { daysOwed, groupByCustomer } from '@/lib/receivables';
import type { CustomerBalance } from '@/lib/balances';

// customer_balances reports a row per unsettled SALE, which is right for
// arithmetic and wrong for a collections list -- nobody rings a customer about
// sale 3 of 4. The grouping and the ordering are the whole value of the screen,
// so they live in a pure function and are checked here.

const row = (
  customerId: string,
  owedCents: number,
  saleCreatedAt: string,
  customerName: string | null = 'Farah Hassan'
): CustomerBalance => ({
  customerId,
  customerName,
  saleId: `${customerId}-${saleCreatedAt}`,
  saleCreatedAt,
  totalCents: owedCents,
  paidCents: 0,
  refundedCents: 0,
  owedCents,
});

describe('groupByCustomer', () => {
  it('adds up everything one person owes across their sales', () => {
    const [only] = groupByCustomer([
      row('c1', 3474, '2026-08-12T10:00:00.000Z'),
      row('c1', 2000, '2026-08-14T10:00:00.000Z'),
    ]);
    expect(only.owedCents).toBe(5474);
    expect(only.saleCount).toBe(2);
  });

  it('keeps the oldest sale, not the last one read', () => {
    const [only] = groupByCustomer([
      row('c1', 2000, '2026-08-14T10:00:00.000Z'),
      row('c1', 3474, '2026-08-12T10:00:00.000Z'),
    ]);
    expect(only.oldestAt).toBe('2026-08-12T10:00:00.000Z');
  });

  it('puts the biggest debt first, because that is what a shop acts on', () => {
    const grouped = groupByCustomer([
      row('small', 500, '2026-08-01T10:00:00.000Z'),
      row('big', 9000, '2026-08-14T10:00:00.000Z'),
      row('middle', 3000, '2026-08-10T10:00:00.000Z'),
    ]);
    expect(grouped.map((g) => g.customerId)).toEqual(['big', 'middle', 'small']);
  });

  it('breaks a tie on age, then on id, so the order never varies between reads', () => {
    const same = '2026-08-12T10:00:00.000Z';
    const older = '2026-08-01T10:00:00.000Z';
    const forwards = groupByCustomer([row('bbb', 1000, same), row('aaa', 1000, older)]);
    const backwards = groupByCustomer([row('aaa', 1000, older), row('bbb', 1000, same)]);
    expect(forwards.map((g) => g.customerId)).toEqual(['aaa', 'bbb']);
    expect(backwards.map((g) => g.customerId)).toEqual(['aaa', 'bbb']);
  });

  it('keeps a name from whichever row carried one', () => {
    // A reader holding only sales.view cannot see `customers`, so the view falls
    // back to the name the sale recorded -- which some rows may not have. A later
    // blank must not wipe a name an earlier row supplied.
    const [only] = groupByCustomer([
      row('c1', 1000, '2026-08-12T10:00:00.000Z', 'Farah Hassan'),
      row('c1', 1000, '2026-08-13T10:00:00.000Z', null),
    ]);
    expect(only.customerName).toBe('Farah Hassan');
  });

  it('is empty when nobody owes anything', () => {
    expect(groupByCustomer([])).toEqual([]);
  });
});

describe('daysOwed', () => {
  const noon = (day: number) => new Date(`2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`).getTime();

  it('is zero on the day the debt was taken', () => {
    expect(daysOwed('2026-08-12T10:00:00.000Z', noon(12))).toBe(0);
  });

  it('floors rather than rounds up', () => {
    // Aug 12 10:00 to Aug 14 08:00 is 1 day and 22 hours, which is 1 day owed.
    // Rounding up would make a debt taken this morning read as older than it is.
    expect(daysOwed('2026-08-12T10:00:00.000Z', noon(14) - 4 * 3600_000)).toBe(1);
  });

  it('counts a month correctly, which is the threshold the screen colours on', () => {
    const thirtyDaysLater = new Date('2026-08-12T10:00:00.000Z').getTime() + 30 * 86_400_000;
    expect(daysOwed('2026-08-12T10:00:00.000Z', thirtyDaysLater)).toBe(30);
  });

  it('never goes negative on a clock skew', () => {
    expect(daysOwed('2026-08-12T10:00:00.000Z', noon(1))).toBe(0);
  });
});
