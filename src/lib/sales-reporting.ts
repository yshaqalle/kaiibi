import { dayKeyFor, startOfDay } from '@/lib/period';
import type { Sale } from '@/types/models';

// Pure arithmetic behind every revenue and profit figure. Separate from
// sales.ts for the same reason expense-reporting.ts is separate from
// expenses.ts: that module imports the Supabase client, which needs a native
// runtime and so can't be loaded under Jest. These are the numbers most worth
// testing, so they live where they can be.

// A refund attributed to the period it happened in, carrying enough of the
// original line to reverse its cost. `refunds.total_cents` is built from
// `sale_items.line_total_cents` (see refund_sale_items), so it is a *pre-tax*
// figure and nets directly against pre-tax revenue.
export type PeriodRefund = {
  id: string;
  createdAt: string;
  totalCents: number;
  items: { quantity: number; unitCostCents: number | null }[];
};

// What the customer handed over, tax included. Rarely the number you want on
// its own -- it's the starting point for netRevenueCents, and is kept separate
// so a screen can show "took $X, of which $Y is tax" without recomputing.
export function grossSalesCents(sales: Sale[]): number {
  return sales.reduce((sum, sale) => sum + sale.totalCents, 0);
}

// Sales tax collected on the shop's behalf. This is a liability owed onward,
// not income -- it belongs in its own block on a report, never inside revenue.
export function taxCollectedCents(sales: Sale[]): number {
  return sales.reduce((sum, sale) => sum + sale.taxCents, 0);
}

export function refundedCents(refunds: PeriodRefund[]): number {
  return refunds.reduce((sum, refund) => sum + refund.totalCents, 0);
}

// Revenue proper: what the shop actually earned. Excludes tax (not the shop's
// money) and refunds (money handed back).
//
// Refunds are subtracted in the period they *happened*, not the period of the
// original sale -- so a closed month's revenue never changes retroactively.
// The trade-off is that a refund can push a quiet period negative, which is
// accurate rather than a bug.
export function netRevenueCents(sales: Sale[], refunds: PeriodRefund[] = []): number {
  return grossSalesCents(sales) - taxCollectedCents(sales) - refundedCents(refunds);
}

export type CogsResult = {
  cogsCents: number;
  // Sold line items with no cost recorded -- either sold before costs were
  // captured, or a product that never had one set. Surfaced so a report can
  // say COGS is understated rather than implying precision it doesn't have.
  uncostedItemCount: number;
  uncostedRevenueCents: number;
};

// Cost of the goods actually sold in the period, from the cost frozen on each
// line at sale time (sale_items.unit_cost_cents) rather than the product's
// current cost -- otherwise editing a product's cost would silently rewrite
// every past period's profit.
//
// Refunded quantities are reversed out: the goods came back into stock, so
// their cost is no longer a cost of sale.
export function costOfGoodsSold(sales: Sale[], refunds: PeriodRefund[] = []): CogsResult {
  let cogsCents = 0;
  let uncostedItemCount = 0;
  let uncostedRevenueCents = 0;

  for (const sale of sales) {
    for (const item of sale.items ?? []) {
      if (item.unitCostCents === null) {
        uncostedItemCount += 1;
        uncostedRevenueCents += item.lineTotalCents;
        continue;
      }
      cogsCents += item.unitCostCents * item.quantity;
    }
  }

  for (const refund of refunds) {
    for (const item of refund.items) {
      if (item.unitCostCents === null) continue;
      cogsCents -= item.unitCostCents * item.quantity;
    }
  }

  return { cogsCents, uncostedItemCount, uncostedRevenueCents };
}

export type DailyBucket = {
  day: string;
  // Kept alongside net revenue so a caller can show either without refetching.
  grossCents: number;
  taxCents: number;
  refundCents: number;
  netRevenueCents: number;
  orderCount: number;
  discountCents: number;
};

// One bucket per day in the range, including days with no activity, so a chart
// shows a flat stretch rather than silently compressing the x-axis.
export function bucketDailyTotals(sales: Sale[], refunds: PeriodRefund[], sinceDate: Date, untilDate?: Date): DailyBucket[] {
  const since = startOfDay(sinceDate);
  const until = untilDate ? new Date(untilDate) : new Date();
  const dayCount = Math.max(1, Math.floor((until.getTime() - since.getTime()) / 86_400_000) + 1);

  const buckets = new Map<string, DailyBucket>();
  for (let i = 0; i < dayCount; i++) {
    const day = new Date(since);
    day.setDate(since.getDate() + i);
    buckets.set(dayKeyFor(day), {
      day: dayKeyFor(day),
      grossCents: 0,
      taxCents: 0,
      refundCents: 0,
      netRevenueCents: 0,
      orderCount: 0,
      discountCents: 0,
    });
  }

  for (const sale of sales) {
    const bucket = buckets.get(dayKeyFor(sale.createdAt));
    if (!bucket) continue;
    bucket.grossCents += sale.totalCents;
    bucket.taxCents += sale.taxCents;
    bucket.orderCount += 1;
    bucket.discountCents += sale.discountCents + (sale.items ?? []).reduce((sum, item) => sum + item.discountCents, 0);
  }

  // Bucketed by the refund's own date, matching netRevenueCents.
  for (const refund of refunds) {
    const bucket = buckets.get(dayKeyFor(refund.createdAt));
    if (!bucket) continue;
    bucket.refundCents += refund.totalCents;
  }

  for (const bucket of buckets.values()) {
    bucket.netRevenueCents = bucket.grossCents - bucket.taxCents - bucket.refundCents;
  }

  return Array.from(buckets.values());
}
