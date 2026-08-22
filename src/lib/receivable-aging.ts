import { daysOwed, groupByCustomer, type Receivable } from '@/lib/receivables';
import type { CustomerBalance } from '@/lib/balances';

// Aged receivables: what is owed, sorted by how long it has been owed.
//
// The collections list in receivables.ts already answers "who owes the most".
// This answers the different and harder question a shop actually acts on:
// **how bad is it getting**. A shop owed $2,000 across this week's sales is
// healthy; one owed $2,000 from four months ago has largely lost the money,
// and both look identical on a list ordered by size.
//
// Pure, so the buckets can be pinned by test — importing `receivables-tab.tsx`
// pulls in the Supabase client, which will not load under Jest.

/**
 * The conventional buckets, and they are conventional for a reason: every
 * accountant, bank and factoring company reads a receivables report in 30-day
 * bands, and inventing our own would make the report unusable by the people a
 * shop shows it to.
 *
 * `maxDays` is inclusive; the last bucket has none.
 */
export const AGING_BUCKETS: { key: string; label: string; maxDays: number | null }[] = [
  { key: 'current', label: 'Not yet 30 days', maxDays: 29 },
  { key: '30', label: '30 – 59 days', maxDays: 59 },
  { key: '60', label: '60 – 89 days', maxDays: 89 },
  { key: '90', label: '90 days and over', maxDays: null },
];

export function bucketForDays(days: number): string {
  return AGING_BUCKETS.find((bucket) => bucket.maxDays === null || days <= bucket.maxDays)!.key;
}

export type AgedReceivable = Receivable & {
  days: number;
  bucketKey: string;
};

export type AgingBucketTotal = {
  key: string;
  label: string;
  owedCents: number;
  customerCount: number;
  /** Share of everything outstanding, 0–100. The figure a reader is actually after. */
  pct: number;
};

export type ReceivablesAging = {
  rows: AgedReceivable[];
  buckets: AgingBucketTotal[];
  totalOwedCents: number;
  /** 60 days and over — the part a shop should assume it may not collect. */
  atRiskCents: number;
};

/**
 * Ages every outstanding balance against a fixed clock.
 *
 * `now` is passed in rather than read here for the same reason the collections
 * table passes it: a report whose ages tick over mid-scroll is worse than one
 * that is a few seconds stale, and a pure function that reads the clock cannot
 * be tested.
 *
 * A customer with debts of different ages is ONE row, aged on their oldest.
 * Splitting them across buckets would be more precise and less useful --
 * nobody calls a customer about the part of their debt that is 40 days old.
 */
export function ageReceivables(balances: CustomerBalance[], now: number): ReceivablesAging {
  const rows: AgedReceivable[] = groupByCustomer(balances).map((row) => {
    const days = daysOwed(row.oldestAt, now);
    return { ...row, days, bucketKey: bucketForDays(days) };
  });

  const totalOwedCents = rows.reduce((sum, row) => sum + row.owedCents, 0);

  const buckets: AgingBucketTotal[] = AGING_BUCKETS.map((bucket) => {
    const inBucket = rows.filter((row) => row.bucketKey === bucket.key);
    const owedCents = inBucket.reduce((sum, row) => sum + row.owedCents, 0);
    return {
      key: bucket.key,
      label: bucket.label,
      owedCents,
      customerCount: inBucket.length,
      // Rounded, and only when there is something to be a share of. A shop
      // owed nothing would otherwise get four buckets each claiming NaN%.
      pct: totalOwedCents > 0 ? Math.round((owedCents / totalOwedCents) * 100) : 0,
    };
  });

  return {
    rows: rows.sort((a, b) => {
      // Oldest first, then largest. The opposite order to the collections
      // list, deliberately: that one is a call sheet ranked by what is worth
      // chasing, this one is a risk report ranked by what is going bad.
      if (b.days !== a.days) return b.days - a.days;
      return b.owedCents - a.owedCents;
    }),
    buckets,
    totalOwedCents,
    atRiskCents: rows.filter((row) => row.days >= 60).reduce((sum, row) => sum + row.owedCents, 0),
  };
}

export type CustomerBalanceSummaryRow = {
  customerId: string;
  customerName: string;
  saleCount: number;
  owedCents: number;
  oldestAt: string;
  days: number;
};

/**
 * The customer balance summary: one line per customer, largest debt first.
 *
 * Nearly the same data as the aging report and a genuinely different document.
 * This one is handed TO a customer or read down when reconciling an account --
 * so it is ordered by size, carries the number of unpaid sales behind each
 * balance, and does not bucket. The aging report is read by the shop about
 * itself.
 */
export function customerBalanceSummary(balances: CustomerBalance[], now: number): CustomerBalanceSummaryRow[] {
  return groupByCustomer(balances).map((row) => ({
    customerId: row.customerId,
    // The fallback matters here more than on the collections list: this report
    // gets exported, and a blank name in a column of names reads as a bug
    // rather than as a customer nobody named.
    customerName: row.customerName || 'Unnamed customer',
    saleCount: row.saleCount,
    owedCents: row.owedCents,
    oldestAt: row.oldestAt,
    days: daysOwed(row.oldestAt, now),
  }));
}
