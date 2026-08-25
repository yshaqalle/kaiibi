// The Post History door: what is waiting to reach the ledger, presented.
//
// backfill_shop_ledger has existed since 20260908000700 with nothing calling
// it. The call that finally does lives in ledger.ts, beside the rest of the
// Supabase-facing ledger -- this file is the half that can be tested without a
// runtime, the same split ledger-math.ts already draws.
//
// NOTHING HERE DECIDES WHAT "UNPOSTED" MEANS, and that is deliberate. The
// answer comes from public.unposted_ledger_counts(), over the
// public.unposted_ledger_sources view, which carries the same eight per-kind
// predicates the replay does -- see the migration's header for why each one is
// a trap (a sale's own tenders keep a null pointer for ever; a zero-valued sale
// is never replayed; a count-derived expense stays unposted by design). Eight
// counts hand-rolled here would give a door and an RPC that disagree about the
// one word the whole screen is built on.
//
// What IS decided here is presentation: eight database words become eight
// English ones, in an order a shopkeeper reads down. That is a pure function,
// and it is tested.

export type UnpostedCountRow = {
  /** The database's own word: 'sale', 'invoice_payment', 'payroll'… */
  kind: string;
  rowsUnposted: number;
  /** The date the oldest waiting row would be posted on. Null when there are none. */
  oldestOn: string | null;
};

export type UnpostedLine = {
  kind: string;
  label: string;
  /** What that kind's entry records, in one clause. Renders under the label. */
  note: string;
  count: number;
};

export type UnpostedSummary = {
  totalRows: number;
  /** All eight kinds, in reading order, zeroes included. */
  lines: UnpostedLine[];
  /** How many kinds have anything waiting. */
  kindsWithRows: number;
  /** The earliest date anything waiting would be posted on, or null. */
  oldestOn: string | null;
};

// The order the screen reads down, and the only place the database's vocabulary
// meets the shop's. Sales first because they are almost always the bulk of it,
// then what happens to a sale afterwards, then stock, then what the shop owes.
const KINDS: { kind: string; label: string; note: string }[] = [
  { kind: 'sale', label: 'Sales', note: 'revenue, tax, tenders and cost of goods' },
  { kind: 'refund', label: 'Refunds', note: 'returns and the tax that came back' },
  { kind: 'settlement', label: 'Balance settlements', note: 'money collected against a credit sale' },
  { kind: 'receipt', label: 'Stock deliveries', note: "at the delivery's costed value" },
  { kind: 'count', label: 'Stock counts', note: 'the net variance only' },
  { kind: 'invoice_payment', label: 'Supplier payments', note: 'against what the shop owed' },
  { kind: 'payroll', label: 'Pay runs', note: 'posted runs only, never drafts' },
  { kind: 'expense', label: 'Expenses and bills', note: 'what the shop spent, by category' },
];

/**
 * Eight database rows into eight lines a shopkeeper can read, plus the totals.
 *
 * A zero kind still gets a line. "Nothing to do" is the state this door is in
 * for ever after its first run, and eight named rows each reading 0 is a
 * positive statement -- it looked in eight places and all eight are clear --
 * where a list that drops its empty rows cannot be told apart from one that
 * failed to look.
 *
 * A kind the client has never heard of is kept, not dropped, and labelled with
 * its raw name. A ninth source added to the replay must show up in the total
 * the reader is asked to confirm, even before anyone gets round to naming it
 * here; silently omitting it would make the button post more than it promised.
 */
export function summariseUnposted(rows: UnpostedCountRow[]): UnpostedSummary {
  const byKind = new Map<string, UnpostedCountRow>();
  for (const row of rows) {
    const existing = byKind.get(row.kind);
    // Summed rather than overwritten: the function returns one row per kind, so
    // a duplicate means something upstream changed shape, and adding is the
    // reading that cannot under-report.
    byKind.set(
      row.kind,
      existing
        ? { kind: row.kind, rowsUnposted: existing.rowsUnposted + row.rowsUnposted, oldestOn: earlier(existing.oldestOn, row.oldestOn) }
        : row
    );
  }

  const lines: UnpostedLine[] = KINDS.map(({ kind, label, note }) => ({
    kind,
    label,
    note,
    count: byKind.get(kind)?.rowsUnposted ?? 0,
  }));
  for (const [kind, row] of byKind) {
    if (KINDS.some((known) => known.kind === kind)) continue;
    lines.push({ kind, label: kind, note: 'a source this app does not have a name for yet', count: row.rowsUnposted });
  }

  let oldestOn: string | null = null;
  for (const row of byKind.values()) {
    // Only from a kind that actually has rows: the database returns the min
    // over an empty set as null anyway, but a caller assembling rows by hand
    // should not be able to date a history that is not there.
    if (row.rowsUnposted > 0) oldestOn = earlier(oldestOn, row.oldestOn);
  }

  return {
    totalRows: lines.reduce((sum, line) => sum + line.count, 0),
    lines,
    kindsWithRows: lines.filter((line) => line.count > 0).length,
    oldestOn,
  };
}

// Date columns are 'YYYY-MM-DD', so a string compare is a date compare. Never
// `new Date(dateColumn)` -- that parses as UTC midnight and reads as the day
// before anywhere west of Greenwich.
function earlier(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}
