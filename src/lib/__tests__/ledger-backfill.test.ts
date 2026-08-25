import { summariseUnposted, type UnpostedCountRow } from '@/lib/ledger-backfill';

// The Post History door has to say how many rows are waiting and of what kind
// BEFORE anyone presses anything. The counting is the database's -- these cover
// the half that is this app's: turning eight database words into eight lines a
// shopkeeper reads down, and the two states the screen is actually ever in.

const row = (kind: string, rowsUnposted: number, oldestOn: string | null = null): UnpostedCountRow => ({
  kind,
  rowsUnposted,
  oldestOn,
});

/** What unposted_ledger_counts returns for a shop with nothing waiting: eight rows, all zero. */
const NOTHING_TO_DO: UnpostedCountRow[] = [
  row('sale', 0),
  row('refund', 0),
  row('settlement', 0),
  row('receipt', 0),
  row('count', 0),
  row('invoice_payment', 0),
  row('payroll', 0),
  row('expense', 0),
];

describe('summariseUnposted — a shop with nothing to do', () => {
  // The common case, and the one this door is in for ever after its first run.
  it('totals nothing', () => {
    const summary = summariseUnposted(NOTHING_TO_DO);
    expect(summary.totalRows).toBe(0);
    expect(summary.kindsWithRows).toBe(0);
  });

  it('still lists all eight kinds, because eight zeroes is the message', () => {
    // "Nothing to do" on its own cannot be told apart from "this screen failed
    // to load". Eight named rows each reading 0 is a positive statement: it
    // looked in eight places and all eight are clear.
    const summary = summariseUnposted(NOTHING_TO_DO);
    expect(summary.lines).toHaveLength(8);
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
    expect(summary.lines).toHaveLength(8);
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
  ];

  it('adds up every kind, including the ones that are zero', () => {
    expect(summariseUnposted(MIXED).totalRows).toBe(3180 + 96 + 0 + 212 + 18 + 74 + 12 + 341);
  });

  it('counts how many kinds have anything waiting, not how many were returned', () => {
    // 7, not 8: the settlement row is present and empty. This is what the
    // screen's "kinds" tile reads, and reporting 8 would tell a shop it has
    // settlements to post when it has none.
    expect(summariseUnposted(MIXED).kindsWithRows).toBe(7);
  });

  it('reads down in a fixed order whatever order the rows arrive in', () => {
    const forwards = summariseUnposted(MIXED).lines.map((line) => line.kind);
    const backwards = summariseUnposted([...MIXED].reverse()).lines.map((line) => line.kind);
    expect(forwards).toEqual(['sale', 'refund', 'settlement', 'receipt', 'count', 'invoice_payment', 'payroll', 'expense']);
    expect(backwards).toEqual(forwards);
  });

  it("names each kind in the shop's words, not the database's", () => {
    const labels = Object.fromEntries(summariseUnposted(MIXED).lines.map((line) => [line.kind, line.label]));
    expect(labels.invoice_payment).toBe('Supplier payments');
    expect(labels.receipt).toBe('Stock deliveries');
    expect(labels.expense).toBe('Expenses and bills');
  });

  it('puts each count against its own kind', () => {
    const counts = Object.fromEntries(summariseUnposted(MIXED).lines.map((line) => [line.kind, line.count]));
    expect(counts.sale).toBe(3180);
    expect(counts.payroll).toBe(12);
    expect(counts.settlement).toBe(0);
  });

  it('reports the earliest date across every kind, not the first row it saw', () => {
    // 2024-03-04 is on `sale`, which arrives first here -- so the test also
    // runs the rows reversed, where the earliest date is last.
    expect(summariseUnposted(MIXED).oldestOn).toBe('2024-03-04');
    expect(summariseUnposted([...MIXED].reverse()).oldestOn).toBe('2024-03-04');
  });

  it('ignores a date attached to a kind with nothing waiting', () => {
    // A stale date on an empty kind would date a history that is not there.
    const summary = summariseUnposted([row('sale', 5, '2025-09-01'), row('settlement', 0, '2019-01-01')]);
    expect(summary.oldestOn).toBe('2025-09-01');
  });
});

describe('summariseUnposted — a source this app has no name for', () => {
  it('keeps it and counts it, rather than dropping it out of the total', () => {
    // A ninth source added to the replay must reach the number the reader is
    // asked to confirm before it reaches this file's label table. Dropping it
    // would make the button post more than it promised.
    const summary = summariseUnposted([...NOTHING_TO_DO, row('asset_disposal', 7, '2025-02-02')]);
    expect(summary.totalRows).toBe(7);
    expect(summary.lines).toHaveLength(9);
    expect(summary.lines[8]).toMatchObject({ kind: 'asset_disposal', label: 'asset_disposal', count: 7 });
    expect(summary.oldestOn).toBe('2025-02-02');
  });

  it('keeps the eight known kinds ahead of it', () => {
    const summary = summariseUnposted([row('asset_disposal', 7), ...NOTHING_TO_DO]);
    expect(summary.lines[0].kind).toBe('sale');
    expect(summary.lines[8].kind).toBe('asset_disposal');
  });
});
