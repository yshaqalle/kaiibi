// The collections list's arithmetic, kept out of the component so it can be
// tested: importing receivables-tab.tsx pulls in use-auth and therefore the
// Supabase client, which throws under Jest without an env file.
import type { CustomerBalance } from '@/lib/balances';

// One row per person, not per sale. `customer_balances` reports a row per
// unsettled sale, which is the right shape for arithmetic and the wrong one for
// a collections list: nobody rings a customer about sale #3 of 4.
export type Receivable = {
  customerId: string;
  customerName: string;
  owedCents: number;
  oldestAt: string;
  saleCount: number;
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
      // A name is only missing when the reader cannot see `customers` -- keep
      // whichever row did carry one rather than letting a later blank win.
      if (!existing.customerName && row.customerName) existing.customerName = row.customerName;
    } else {
      byCustomer.set(row.customerId, {
        customerId: row.customerId,
        customerName: row.customerName ?? '',
        owedCents: row.owedCents,
        oldestAt: row.saleCreatedAt,
        saleCount: 1,
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
