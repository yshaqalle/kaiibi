import {
  agingDaysFor,
  daysOwed,
  daysPastDue,
  dueStatus,
  groupByCustomer,
  pastDueLabel,
  remindedLabel,
  type Receivable,
} from '@/lib/receivables';
import type { CustomerBalance } from '@/lib/balances';

// customer_balances reports a row per unsettled SALE, which is right for
// arithmetic and wrong for a collections list -- nobody rings a customer about
// sale 3 of 4. The grouping and the ordering are the whole value of the screen,
// so they live in a pure function and are checked here.

const row = (
  customerId: string,
  owedCents: number,
  saleCreatedAt: string,
  customerName: string | null = 'Farah Hassan',
  dueOn: string | null = null,
  lastRemindedAt: string | null = null,
  customerPhone: string | null = null
): CustomerBalance => ({
  customerId,
  customerName,
  saleId: `${customerId}-${saleCreatedAt}`,
  saleCreatedAt,
  totalCents: owedCents,
  paidCents: 0,
  refundedCents: 0,
  owedCents,
  dueOn,
  lastRemindedAt,
  customerPhone,
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

  it('keeps the EARLIEST due date, which is what justifies the phone call', () => {
    // Taking the latest would let a fresh sale hide a debt two months late.
    const [only] = groupByCustomer([
      row('c1', 1000, '2026-08-14T10:00:00.000Z', 'Farah Hassan', '2026-10-05'),
      row('c1', 1000, '2026-08-12T10:00:00.000Z', 'Farah Hassan', '2026-08-02'),
    ]);
    expect(only.dueOn).toBe('2026-08-02');
  });

  it('does not let a row without a due date displace one that has it', () => {
    const [only] = groupByCustomer([
      row('c1', 1000, '2026-08-12T10:00:00.000Z', 'Farah Hassan', '2026-09-01'),
      row('c1', 1000, '2026-08-13T10:00:00.000Z', 'Farah Hassan', null),
    ]);
    expect(only.dueOn).toBe('2026-09-01');
  });

  it('carries the reminder stamp, and a null row never wipes it', () => {
    // last_reminded_at is a customers column repeated on every row of theirs,
    // but a reader who cannot see `customers` gets nulls -- same shape as the
    // missing-name case above.
    const [only] = groupByCustomer([
      row('c1', 1000, '2026-08-12T10:00:00.000Z', 'Farah Hassan', null, '2026-09-03T09:00:00.000Z'),
      row('c1', 1000, '2026-08-13T10:00:00.000Z', 'Farah Hassan', null, null),
    ]);
    expect(only.lastRemindedAt).toBe('2026-09-03T09:00:00.000Z');
  });
});

// ── Lateness ───────────────────────────────────────────────────────────────
//
// These use LOCAL dates throughout, because fromDateColumn parses a `date`
// column as a local calendar day. Constructing the "today" with new Date(y, m,
// d) keeps the test in the same frame as the code -- an ISO string with a Z
// would be UTC midnight and drift by a day for a shop ahead of UTC, which is
// the exact bug the helper exists to avoid.
const localDay = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12, 0, 0);

describe('daysPastDue', () => {
  it('is zero ON the due date -- due on a day is not late until it has passed', () => {
    expect(daysPastDue('2026-10-05', localDay(2026, 10, 5))).toBe(0);
  });

  it('counts whole days after the due date', () => {
    expect(daysPastDue('2026-10-05', localDay(2026, 10, 6))).toBe(1);
    expect(daysPastDue('2026-08-02', localDay(2026, 9, 5))).toBe(34);
  });

  it('goes negative before the due date, so "how soon" is answerable', () => {
    expect(daysPastDue('2026-10-05', localDay(2026, 10, 1))).toBe(-4);
  });

  it('reads a missing due date as not late rather than infinitely late', () => {
    expect(daysPastDue(null, localDay(2026, 10, 5))).toBe(0);
  });

  it('does not change with the time of day the screen is open', () => {
    const morning = new Date(2026, 9, 6, 0, 5, 0);
    const night = new Date(2026, 9, 6, 23, 55, 0);
    expect(daysPastDue('2026-10-05', morning)).toBe(daysPastDue('2026-10-05', night));
  });
});

describe('dueStatus', () => {
  it('is late the day after the due date', () => {
    expect(dueStatus('2026-10-05', localDay(2026, 10, 6))).toBe('late');
  });

  it('is soon on the due date itself and within the week before', () => {
    expect(dueStatus('2026-10-05', localDay(2026, 10, 5))).toBe('soon');
    expect(dueStatus('2026-10-05', localDay(2026, 9, 28))).toBe('soon');
  });

  it('is nothing at all when comfortably ahead -- a badge on every row is a badge on none', () => {
    expect(dueStatus('2026-10-05', localDay(2026, 9, 27))).toBeNull();
  });

  it('is nothing when there is no due date to judge', () => {
    expect(dueStatus(null, localDay(2026, 10, 5))).toBeNull();
  });
});

describe('pastDueLabel', () => {
  it('says so in words rather than printing a negative number', () => {
    expect(pastDueLabel('2026-10-05', localDay(2026, 10, 1))).toBe('not yet');
    expect(pastDueLabel('2026-10-05', localDay(2026, 10, 5))).toBe('not yet');
  });

  it('counts days once late, singular on the first one', () => {
    expect(pastDueLabel('2026-10-05', localDay(2026, 10, 6))).toBe('1 day');
    expect(pastDueLabel('2026-10-05', localDay(2026, 10, 8))).toBe('3 days');
  });

  it('prints a dash when there is no date', () => {
    expect(pastDueLabel(null, localDay(2026, 10, 5))).toBe('—');
  });
});

describe('agingDaysFor', () => {
  const receivable = (dueOn: string | null): Receivable => ({
    customerId: 'c1',
    customerName: 'Farah Hassan',
    owedCents: 1000,
    oldestAt: '2026-08-12T10:00:00.000Z',
    saleCount: 1,
    dueOn,
    lastRemindedAt: null,
    customerPhone: null,
  });

  it('is the days past due, which is what repoints the whole aging strip', () => {
    expect(agingDaysFor(receivable('2026-08-02'), localDay(2026, 9, 5))).toBe(34);
  });

  it('clamps a not-yet-due debt to zero rather than handing the buckets a negative', () => {
    expect(agingDaysFor(receivable('2026-12-01'), localDay(2026, 9, 5))).toBe(0);
  });
});

describe('remindedLabel', () => {
  const now = new Date('2026-09-05T12:00:00.000Z').getTime();

  it('says nothing when the shop has never chased this person', () => {
    expect(remindedLabel(null, now)).toBeNull();
  });

  it('reads as today, yesterday, then a count', () => {
    expect(remindedLabel('2026-09-05T09:00:00.000Z', now)).toBe('Reminded today');
    expect(remindedLabel('2026-09-04T09:00:00.000Z', now)).toBe('Reminded yesterday');
    expect(remindedLabel('2026-09-01T09:00:00.000Z', now)).toBe('Reminded 4 days ago');
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
