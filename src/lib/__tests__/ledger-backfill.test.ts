import { describeShutMonths, summariseUnposted, type UnpostedCountRow } from '@/lib/ledger-backfill';

// The Post History door has to say how many entries a run will write and of
// what kind, BEFORE anyone presses anything. The counting is the database's --
// these cover the half that is this app's: turning nine database words into
// nine lines a shopkeeper reads down, and the two states the screen is
// actually ever in.
//
// Nine, not eight, since 20260908001300: the eight kinds of source row the
// replay reads, plus the shop's opening stock balance, which is the one entry
// a run writes with no source row behind it.

const row = (kind: string, rowsUnposted: number, oldestOn: string | null = null): UnpostedCountRow => ({
  kind,
  rowsUnposted,
  oldestOn,
});

/** What unposted_ledger_counts returns for a shop with nothing waiting: nine rows, all zero. */
const NOTHING_TO_DO: UnpostedCountRow[] = [
  row('sale', 0),
  row('refund', 0),
  row('settlement', 0),
  row('receipt', 0),
  row('count', 0),
  row('invoice_payment', 0),
  row('payroll', 0),
  row('expense', 0),
  row('opening', 0),
];

describe('summariseUnposted — a shop with nothing to do', () => {
  // The common case, and the one this door is in for ever after its first run.
  it('totals nothing', () => {
    const summary = summariseUnposted(NOTHING_TO_DO);
    expect(summary.totalRows).toBe(0);
    expect(summary.kindsWithRows).toBe(0);
  });

  it('still lists all nine kinds, because nine zeroes is the message', () => {
    // "Nothing to do" on its own cannot be told apart from "this screen failed
    // to load". Nine named rows each reading 0 is a positive statement: it
    // looked in nine places and all nine are clear.
    const summary = summariseUnposted(NOTHING_TO_DO);
    expect(summary.lines).toHaveLength(9);
    expect(summary.lines.every((line) => line.count === 0)).toBe(true);
    expect(summary.lines.every((line) => line.label.length > 0 && line.note.length > 0)).toBe(true);
  });

  it('dates nothing, because there is no history waiting to be dated', () => {
    expect(summariseUnposted(NOTHING_TO_DO).oldestOn).toBeNull();
  });

  it('survives the database returning no rows at all', () => {
    // Not a state the function produces, but a screen that renders a blank card
    // on an empty array is indistinguishable from one that errored.
    const summary = summariseUnposted([]);
    expect(summary.lines).toHaveLength(9);
    expect(summary.totalRows).toBe(0);
  });
});

describe('summariseUnposted — a shop with rows of several kinds', () => {
  // Deliberately lopsided figures: no two counts are equal and no subset sums
  // to another, so a line read off the wrong kind gives a visibly different
  // number rather than coincidentally matching.
  const MIXED: UnpostedCountRow[] = [
    row('sale', 3180, '2024-03-04'),
    row('refund', 96, '2024-04-19'),
    row('settlement', 0),
    row('receipt', 212, '2024-03-11'),
    row('count', 18, '2025-01-06'),
    row('invoice_payment', 74, '2024-06-02'),
    row('payroll', 12, '2024-07-31'),
    row('expense', 341, '2024-03-09'),
    // Never more than one, ever, per shop -- and it must reach the total the
    // reader is asked to confirm, or the button posts one more entry than it
    // promised.
    row('opening', 1, '2024-03-01'),
  ];

  it('adds up every kind, including the ones that are zero', () => {
    expect(summariseUnposted(MIXED).totalRows).toBe(3180 + 96 + 0 + 212 + 18 + 74 + 12 + 341 + 1);
  });

  it('counts how many kinds have anything waiting, not how many were returned', () => {
    // 8, not 9: the settlement row is present and empty. This is what the
    // screen's "kinds" tile reads, and reporting 9 would tell a shop it has
    // settlements to post when it has none.
    expect(summariseUnposted(MIXED).kindsWithRows).toBe(8);
  });

  it('reads down in a fixed order whatever order the rows arrive in', () => {
    const forwards = summariseUnposted(MIXED).lines.map((line) => line.kind);
    const backwards = summariseUnposted([...MIXED].reverse()).lines.map((line) => line.kind);
    expect(forwards).toEqual([
      'sale', 'refund', 'settlement', 'receipt', 'count', 'invoice_payment', 'payroll', 'expense', 'opening',
    ]);
    expect(backwards).toEqual(forwards);
  });

  it("names each kind in the shop's words, not the database's", () => {
    const labels = Object.fromEntries(summariseUnposted(MIXED).lines.map((line) => [line.kind, line.label]));
    expect(labels.invoice_payment).toBe('Supplier payments');
    expect(labels.receipt).toBe('Stock deliveries');
    expect(labels.expense).toBe('Expenses and bills');
    expect(labels.opening).toBe('Opening stock');
  });

  it('puts each count against its own kind', () => {
    const counts = Object.fromEntries(summariseUnposted(MIXED).lines.map((line) => [line.kind, line.count]));
    expect(counts.sale).toBe(3180);
    expect(counts.payroll).toBe(12);
    expect(counts.settlement).toBe(0);
  });

  it('reports the earliest date across every kind, not the first row it saw', () => {
    // 2024-03-01 is on `opening`, which arrives last here -- so the test also
    // runs the rows reversed, where the earliest date is first. The opening
    // balance is always the earliest: it is dated the first day of the month
    // the ledger begins in.
    expect(summariseUnposted(MIXED).oldestOn).toBe('2024-03-01');
    expect(summariseUnposted([...MIXED].reverse()).oldestOn).toBe('2024-03-01');
  });

  it('ignores a date attached to a kind with nothing waiting', () => {
    // A stale date on an empty kind would date a history that is not there.
    const summary = summariseUnposted([row('sale', 5, '2025-09-01'), row('settlement', 0, '2019-01-01')]);
    expect(summary.oldestOn).toBe('2025-09-01');
  });
});

describe('summariseUnposted — a source this app has no name for', () => {
  it('keeps it and counts it, rather than dropping it out of the total', () => {
    // A tenth source added to the replay must reach the number the reader is
    // asked to confirm before it reaches this file's label table. Dropping it
    // would make the button post more than it promised. This is not
    // hypothetical: 'opening' arrived exactly this way, and a client that had
    // dropped it would have said 14 while the run wrote 15.
    const summary = summariseUnposted([...NOTHING_TO_DO, row('asset_disposal', 7, '2025-02-02')]);
    expect(summary.totalRows).toBe(7);
    expect(summary.lines).toHaveLength(10);
    expect(summary.lines[9]).toMatchObject({ kind: 'asset_disposal', label: 'asset_disposal', count: 7 });
    expect(summary.oldestOn).toBe('2025-02-02');
  });

  it('keeps the nine known kinds ahead of it', () => {
    const summary = summariseUnposted([row('asset_disposal', 7), ...NOTHING_TO_DO]);
    expect(summary.lines[0].kind).toBe('sale');
    expect(summary.lines[9].kind).toBe('asset_disposal');
  });
});

// ── The months that are no longer open ──────────────────────────────────────
//
// The replay creates only the periods that do not exist, and creates those
// open. A period that ALREADY exists keeps its status and receives the entries
// anyway -- no re-open, no re-close, no closed_at change, no audit row -- and
// `accounting_periods` documents `locked` as "nothing posts, ever. Manual,
// deliberate, final". unposted_ledger_period_exposure counts that exposure off
// the same view the counts come from; these cover the folding and the sentence.

describe('summariseUnposted — folding in the period exposure', () => {
  it('reads zero for both statuses when the database sent nothing', () => {
    // The old shape of the RPC pair, and any caller that only has counts. It
    // must not read as "one shut month" by accident.
    const summary = summariseUnposted(NOTHING_TO_DO);
    expect(summary.exposure).toEqual({ closedMonths: 0, lockedMonths: 0, closedEntries: 0, lockedEntries: 0 });
  });

  it('keeps closed and locked apart, because only one of them is meant to be final', () => {
    const summary = summariseUnposted(NOTHING_TO_DO, [
      { status: 'closed', months: 3, entries: 41 },
      { status: 'locked', months: 1, entries: 9 },
    ]);
    expect(summary.exposure).toEqual({ closedMonths: 3, lockedMonths: 1, closedEntries: 41, lockedEntries: 9 });
  });
});

describe('describeShutMonths', () => {
  it('says nothing when nothing lands in a shut month', () => {
    // The ordinary state. A warning that shows on every visit is one nobody
    // reads, and this one has to survive being read.
    expect(describeShutMonths({ closedMonths: 0, lockedMonths: 0, closedEntries: 0, lockedEntries: 0 })).toBeNull();
  });

  it('counts months across both statuses and entries across both', () => {
    const copy = describeShutMonths({ closedMonths: 3, lockedMonths: 1, closedEntries: 41, lockedEntries: 9 })!;
    expect(copy).toContain('4 months');
    expect(copy).toContain('3 you have closed');
    expect(copy).toContain('1 you have locked');
    expect(copy).toContain('50');
  });

  it('reads as one month rather than "1 months"', () => {
    const copy = describeShutMonths({ closedMonths: 1, lockedMonths: 0, closedEntries: 2, lockedEntries: 0 })!;
    expect(copy).toContain('One month that is no longer open');
    expect(copy).toContain('does not re-open it');
  });

  it('does not mention locking when nothing is locked', () => {
    // Naming a state the shop is not in is how a warning becomes boilerplate.
    const copy = describeShutMonths({ closedMonths: 2, lockedMonths: 0, closedEntries: 5, lockedEntries: 0 })!;
    expect(copy).not.toContain('you have locked');
    expect(copy).not.toContain('final');
  });

  it('never claims the months are re-opened, which is what the card used to say', () => {
    const copy = describeShutMonths({ closedMonths: 2, lockedMonths: 2, closedEntries: 5, lockedEntries: 5 })!;
    expect(copy).toContain('does not re-open them');
    expect(copy).not.toContain('re-opened');
  });
});
