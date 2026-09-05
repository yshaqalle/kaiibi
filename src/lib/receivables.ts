// The collections list's arithmetic, kept out of the component so it can be
// tested: importing receivables-tab.tsx pulls in use-auth and therefore the
// Supabase client, which throws under Jest without an env file.
import type { CustomerBalance } from '@/lib/balances';
import { fromDateColumn, startOfDay } from '@/lib/period';

// One row per person, not per sale. `customer_balances` reports a row per
// unsettled sale, which is the right shape for arithmetic and the wrong one for
// a collections list: nobody rings a customer about sale #3 of 4.
export type Receivable = {
  customerId: string;
  customerName: string;
  owedCents: number;
  oldestAt: string;
  saleCount: number;
  // The EARLIEST due date across this customer's unpaid sales, not the latest.
  // The row is a prompt to make one phone call, and what justifies the call is
  // the most overdue sale in it -- taking the latest would let a fresh sale
  // hide a debt that has been late for two months.
  //
  // Null only in theory: 20261026000000 backfilled every unsettled sale and
  // stamps every new one. Kept nullable because the column is, and because a
  // screen that crashes on a null is worse than one that prints a dash.
  dueOn: string | null;
  // When the shop last opened a reminder for this person. Carried on every row
  // of theirs by the view (it is a customers column), so any row can supply it.
  lastRemindedAt: string | null;
  // Their current number, for the reminder button. Null hides the button
  // rather than opening an empty chat -- see WhatsAppButton.
  customerPhone: string | null;
};

// Exported for its test. Pure, so the grouping and the ordering can be checked
// without a database -- and the ordering is the whole value of the screen:
// biggest debt first is what a shop acts on.
export function groupByCustomer(rows: CustomerBalance[]): Receivable[] {
  const byCustomer = new Map<string, Receivable>();
  for (const row of rows) {
    const existing = byCustomer.get(row.customerId);
    if (existing) {
      existing.owedCents += row.owedCents;
      existing.saleCount += 1;
      if (row.saleCreatedAt < existing.oldestAt) existing.oldestAt = row.saleCreatedAt;
      // Earliest wins, and a row without a date never displaces one that has
      // it -- `null < '2026-10-05'` is false in JS but the guard is explicit
      // rather than relying on that.
      if (row.dueOn && (!existing.dueOn || row.dueOn < existing.dueOn)) existing.dueOn = row.dueOn;
      // A name is only missing when the reader cannot see `customers` -- keep
      // whichever row did carry one rather than letting a later blank win.
      if (!existing.customerName && row.customerName) existing.customerName = row.customerName;
      // Same reasoning: every row of one customer's carries the same stamp,
      // so keep the first non-null rather than letting a null overwrite it.
      if (!existing.lastRemindedAt && row.lastRemindedAt) existing.lastRemindedAt = row.lastRemindedAt;
      if (!existing.customerPhone && row.customerPhone) existing.customerPhone = row.customerPhone;
    } else {
      byCustomer.set(row.customerId, {
        customerId: row.customerId,
        customerName: row.customerName ?? '',
        owedCents: row.owedCents,
        oldestAt: row.saleCreatedAt,
        saleCount: 1,
        dueOn: row.dueOn,
        lastRemindedAt: row.lastRemindedAt,
        customerPhone: row.customerPhone,
      });
    }
  }
  return [...byCustomer.values()].sort((a, b) => {
    if (b.owedCents !== a.owedCents) return b.owedCents - a.owedCents;
    // Tiebreak on age, then id: two customers owing the same amount would
    // otherwise swap places between reads.
    if (a.oldestAt !== b.oldestAt) return a.oldestAt < b.oldestAt ? -1 : 1;
    return a.customerId < b.customerId ? -1 : 1;
  });
}

// Whole days, floored: "owed 3 days" is a fact a shopkeeper acts on, and
// rounding it up to 4 would make a debt taken this morning read as older than it
// is. Clamped at zero so a clock skew never prints a negative age.
export function daysOwed(oldestAt: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(oldestAt).getTime()) / 86_400_000));
}

export function ageLabel(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days`;
}

// ── Lateness ───────────────────────────────────────────────────────────────
//
// Everything below measures against the DUE date, where everything above
// measures from the sale. Both are kept: "how long have they had this" and
// "how late are they" are different questions, and the tab now answers the
// second because that is the one a shop acts on.

/**
 * Whole days past the due date. Zero on the due date itself, negative before.
 *
 * "Due *on* a day means it isn't late until that day has passed" -- the same
 * sentence, and the same two helpers, that `invoiceStatus` uses for vendor
 * bills. Receivables and payables disagreeing about what overdue means would
 * be exactly the split that putting aging in one module avoided.
 *
 * `fromDateColumn` parses a `date` column as a LOCAL calendar day rather than
 * UTC midnight, so a shop three hours ahead of UTC does not read every due
 * date as a day early. Compared as whole days, so the answer cannot change
 * with the time of day the screen happens to be open.
 *
 * A null due date reads as zero -- not late -- rather than throwing or being
 * treated as infinitely overdue. It cannot happen after 20261026000000, and if
 * it somehow does, inventing lateness for it is the worse failure.
 */
export function daysPastDue(dueOn: string | null, today: Date = new Date()): number {
  if (!dueOn) return 0;
  const due = fromDateColumn(dueOn).getTime();
  return Math.floor((startOfDay(today).getTime() - due) / 86_400_000);
}

/**
 * What the badge beside the due date says. Null means no badge at all.
 *
 * A badge on every row is a badge on none, so a debt comfortably ahead of its
 * date gets nothing. `soon` is the one that lets a shop ring BEFORE the date
 * rather than chase after it, which is the cheaper phone call.
 */
export type DueStatus = 'late' | 'soon';

/** Within a week is "soon". Long enough to act on, short enough to mean it. */
const SOON_DAYS = 7;

export function dueStatus(dueOn: string | null, today: Date = new Date()): DueStatus | null {
  if (!dueOn) return null;
  const days = daysPastDue(dueOn, today);
  if (days > 0) return 'late';
  return days >= -SOON_DAYS ? 'soon' : null;
}

/**
 * The "Past due" column. Not yet due says so in words rather than printing a
 * negative number, which reads as a mistake.
 */
export function pastDueLabel(dueOn: string | null, today: Date = new Date()): string {
  if (!dueOn) return '—';
  const days = daysPastDue(dueOn, today);
  if (days <= 0) return 'not yet';
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * The age handed to the aging strip, which is the whole of what changes there.
 *
 * src/lib/aging.ts takes a days accessor and never knew where the number came
 * from, so repointing the strip from "days since the sale" to "days past due"
 * is this function replacing `daysOwed` at one call site. The bucketing, the
 * boundaries and the reconciliation are untouched.
 *
 * Clamped at zero so a debt not yet due lands in the newest bucket rather than
 * arriving as a negative -- `bucketForDays` would put it there anyway, but a
 * clamp at the source means the accessor never returns something the buckets
 * have to be trusted to interpret.
 */
export function agingDaysFor(row: Receivable, today: Date = new Date()): number {
  return Math.max(0, daysPastDue(row.dueOn, today));
}

/**
 * "Reminded 2 days ago", for the line under a customer's name.
 *
 * Says only what is true: the shop OPENED a reminder. WhatsApp deep links are
 * one-way, so nothing here can claim the message was sent, let alone read.
 */
export function remindedLabel(lastRemindedAt: string | null, now: number = Date.now()): string | null {
  if (!lastRemindedAt) return null;
  const days = Math.max(0, Math.floor((now - new Date(lastRemindedAt).getTime()) / 86_400_000));
  if (days === 0) return 'Reminded today';
  if (days === 1) return 'Reminded yesterday';
  return `Reminded ${days} days ago`;
}
