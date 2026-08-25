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
// is never replayed; a count-derived expense stays unposted by design) -- plus,
// since 20260908001300, the shop's opening stock balance, which is the one
// entry a run writes with NO source row behind it and whose existence depends
// on an amount rather than on a row. Counts hand-rolled here would give a door
// and an RPC that disagree about the one word the whole screen is built on, and
// the opening balance is the one nothing outside the database could work out at
// all.
//
// What IS decided here is presentation: nine database words become nine
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

/** One already-shut status and what the replay would put into it. */
export type PeriodExposureRow = {
  /** 'closed' or 'locked'. Both always come back, zeroes included. */
  status: string;
  months: number;
  entries: number;
};

export type PeriodExposure = {
  closedMonths: number;
  lockedMonths: number;
  /** Entries that would land in an already-closed month. */
  closedEntries: number;
  /** Entries that would land in an already-locked month. */
  lockedEntries: number;
};

export type UnpostedSummary = {
  totalRows: number;
  /** All nine kinds, in reading order, zeroes included. */
  lines: UnpostedLine[];
  /** How many kinds have anything waiting. */
  kindsWithRows: number;
  /** The earliest date anything waiting would be posted on, or null. */
  oldestOn: string | null;
  /**
   * Which already-shut months the replay would write into. Zeroes throughout
   * when nothing is waiting, or when everything waiting lands in a month that
   * is open or does not exist yet.
   */
  exposure: PeriodExposure;
};

// The order the screen reads down, and the only place the database's vocabulary
// meets the shop's. Sales first because they are almost always the bulk of it,
// then what happens to a sale afterwards, then stock, then what the shop owes.
//
// 'opening' is LAST, and it is the one line here that is not a replay of
// something the shop did. It is the ledger's starting position -- the stock
// that was already on the shelf before the app recorded a single delivery --
// and it is the only entry a run writes with no source row behind it. Last
// rather than first because the eight replays are the bulk of what happens and
// this reads as the closing statement of the list rather than a preamble to it.
// Its count is never more than 1, for ever, per shop.
const KINDS: { kind: string; label: string; note: string }[] = [
  { kind: 'sale', label: 'Sales', note: 'revenue, tax, tenders and cost of goods' },
  { kind: 'refund', label: 'Refunds', note: 'returns and the tax that came back' },
  { kind: 'settlement', label: 'Balance settlements', note: 'money collected against a credit sale' },
  { kind: 'receipt', label: 'Stock deliveries', note: "at the delivery's costed value" },
  { kind: 'count', label: 'Stock counts', note: 'the net variance only' },
  { kind: 'invoice_payment', label: 'Supplier payments', note: 'against what the shop owed' },
  { kind: 'payroll', label: 'Pay runs', note: 'posted runs only, never drafts' },
  { kind: 'expense', label: 'Expenses and bills', note: 'what the shop spent, by category' },
  { kind: 'opening', label: 'Opening stock', note: 'what was on the shelf before any delivery was recorded' },
];

/**
 * Nine database rows into nine lines a shopkeeper can read, plus the totals.
 *
 * A zero kind still gets a line. "Nothing to do" is the state this door is in
 * for ever after its first run, and nine named rows each reading 0 is a
 * positive statement -- it looked in nine places and all nine are clear --
 * where a list that drops its empty rows cannot be told apart from one that
 * failed to look.
 *
 * A kind the client has never heard of is kept, not dropped, and labelled with
 * its raw name. A tenth source added to the replay must show up in the total
 * the reader is asked to confirm, even before anyone gets round to naming it
 * here; silently omitting it would make the button post more than it promised.
 */
export function summariseUnposted(rows: UnpostedCountRow[], exposureRows: PeriodExposureRow[] = []): UnpostedSummary {
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

  const shut = (status: string) => exposureRows.find((row) => row.status === status);

  return {
    totalRows: lines.reduce((sum, line) => sum + line.count, 0),
    lines,
    kindsWithRows: lines.filter((line) => line.count > 0).length,
    oldestOn,
    exposure: {
      closedMonths: shut('closed')?.months ?? 0,
      lockedMonths: shut('locked')?.months ?? 0,
      closedEntries: shut('closed')?.entries ?? 0,
      lockedEntries: shut('locked')?.entries ?? 0,
    },
  };
}

/**
 * The sentence that names the shut months a replay would write into, or null
 * when there are none.
 *
 * A PURE FUNCTION AND NOT A JSX FRAGMENT, so the wording is testable without a
 * renderer -- the same split the rest of this file draws. It is the only place
 * that decides what the reader is told about closed and locked months, and it
 * must not soften it: the replay does not re-open a closed month, does not
 * re-close it, does not touch `closed_at` and writes no audit row. `locked` is
 * documented as "nothing posts, ever", and this walks straight through it.
 *
 * Months, not entries, lead the sentence. "3 months" is a thing an owner can go
 * and look at; "412 entries" is a number they can only nod at.
 */
export function describeShutMonths(exposure: PeriodExposure): string | null {
  const parts: string[] = [];
  if (exposure.closedMonths > 0) parts.push(`${exposure.closedMonths} you have closed`);
  if (exposure.lockedMonths > 0) parts.push(`${exposure.lockedMonths} you have locked`);
  if (parts.length === 0) return null;

  const months = exposure.closedMonths + exposure.lockedMonths;
  const entries = exposure.closedEntries + exposure.lockedEntries;
  return (
    `${months === 1 ? 'One month' : `${months} months`} that ${months === 1 ? 'is' : 'are'} no longer open — ` +
    // "1 of these entries" is right, so no singular form is needed here.
    `${parts.join(' and ')} — will receive ${entries.toLocaleString()} of these entries. ` +
    `Posting does not re-open ${months === 1 ? 'it' : 'them'}, does not close ${months === 1 ? 'it' : 'them'} again and leaves nothing on the record to say why ` +
    `${months === 1 ? 'its' : 'their'} figures moved` +
    (exposure.lockedMonths > 0 ? ', and a locked month is meant to be final.' : '.') +
    ' Check them before you press.'
  );
}

// Date columns are 'YYYY-MM-DD', so a string compare is a date compare. Never
// `new Date(dateColumn)` -- that parses as UTC midnight and reads as the day
// before anywhere west of Greenwich.
function earlier(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}
