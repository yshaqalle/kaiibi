import { dayKeyFor, startOfDay } from '@/lib/period';
import type { PaymentMethod, Sale } from '@/types/models';

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

// How much of one sold line came back. Refund items point at the sale item
// they reverse, and a sale can be refunded more than once, so this sums across
// every refund on the sale.
export function refundedQuantityFor(sale: Sale, saleItemId: string): number {
  return (sale.refunds ?? [])
    .flatMap((refund) => refund.items)
    .filter((item) => item.saleItemId === saleItemId)
    .reduce((sum, item) => sum + item.quantity, 0);
}

// What refunding the selected quantities will actually hand back.
//
// Mirrors refund_sale_items (migration 20260820000200) exactly, and exists for
// the same reason tax.ts and loyalty.ts do: the cashier is shown a figure before
// confirming, and the server recomputes and is authoritative. If the two ever
// disagree, this is the one that's wrong.
//
// The subtlety worth keeping straight: a line's `lineTotalCents` is its own
// price net of its own discount, and knows nothing about the sale's order-level
// discount, points redeemed, or tax. So it sets the PROPORTION coming back, and
// the money is then scaled to `sale.totalCents` — the one figure the customer
// actually handed over.
export function refundPreviewCents(sale: Sale, selection: Record<string, number>): number {
  const items = sale.items ?? [];
  const saleGrossCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  if (saleGrossCents <= 0) return 0;

  const grossShare = (item: { lineTotalCents: number; quantity: number }, qty: number) =>
    Math.round((item.lineTotalCents * qty) / item.quantity);

  let priorGrossCents = 0;
  let thisGrossCents = 0;
  for (const item of items) {
    const refunded = refundedQuantityFor(sale, item.id);
    priorGrossCents += grossShare(item, refunded);

    const wanted = selection[item.id] ?? 0;
    if (wanted > 0) {
      thisGrossCents += grossShare(item, refunded + wanted) - grossShare(item, refunded);
    }
  }

  // Prior paid comes from what was actually handed back, never recomputed —
  // refunds issued before that migration used the old gross figure, and the
  // server deliberately doesn't restate them.
  const priorPaidCents = (sale.refunds ?? []).reduce((sum, refund) => sum + refund.totalCents, 0);
  const cumPaidCents = Math.round((sale.totalCents * (priorGrossCents + thisGrossCents)) / saleGrossCents);

  return Math.max(cumPaidCents - priorPaidCents, 0);
}

export type SaleProfit = {
  // What the shop kept on this sale: the total less the tax it is only
  // holding, less anything since refunded.
  netRevenueCents: number;
  costCents: number;
  profitCents: number;
  // Share of revenue kept, or null when the sale earned nothing — dividing by
  // zero would print NaN%, and a fully refunded sale has no margin to report.
  marginPercent: number | null;
  // Same admission costOfGoodsSold makes, at the scale of one receipt: these
  // lines have no cost on file, so the profit shown is an upper bound.
  uncostedItemCount: number;
  uncostedRevenueCents: number;
};

// Per-transaction profit, on the same terms as the period figures above:
// revenue excludes tax, cost comes from the snapshot frozen on each line, and
// refunded quantities reverse out of both sides.
export function saleProfit(sale: Sale): SaleProfit {
  const refundedCentsOnSale = (sale.refunds ?? []).reduce((sum, refund) => sum + refund.totalCents, 0);
  // totalCents is already after any sale-level discount, so the discount needs
  // no separate subtraction here.
  const netRevenueCents = sale.totalCents - sale.taxCents - refundedCentsOnSale;

  let costCents = 0;
  let uncostedItemCount = 0;
  let uncostedRevenueCents = 0;

  for (const item of sale.items ?? []) {
    const soldQuantity = item.quantity - refundedQuantityFor(sale, item.id);
    if (soldQuantity <= 0) continue;
    if (item.unitCostCents === null) {
      uncostedItemCount += 1;
      uncostedRevenueCents += item.lineTotalCents;
      continue;
    }
    costCents += item.unitCostCents * soldQuantity;
  }

  const profitCents = netRevenueCents - costCents;
  return {
    netRevenueCents,
    costCents,
    profitCents,
    marginPercent: netRevenueCents > 0 ? (profitCents / netRevenueCents) * 100 : null,
    uncostedItemCount,
    uncostedRevenueCents,
  };
}

// Takings per cashier. Gross rather than net: this ranks who rang up the most,
// which is a staff question, not a profit one — netting tax out of it would
// make the number harder to reconcile against a till without answering
// anything the P&L doesn't already.
export function cashierPerformance(sales: Sale[], limit = 5): { name: string; revenueCents: number }[] {
  const totals = new Map<string, number>();
  for (const sale of sales) {
    if (!sale.cashierName) continue;
    totals.set(sale.cashierName, (totals.get(sale.cashierName) ?? 0) + sale.totalCents);
  }
  return Array.from(totals.entries())
    .map(([name, revenueCents]) => ({ name, revenueCents }))
    .sort((a, b) => b.revenueCents - a.revenueCents)
    .slice(0, limit);
}

export type ProductSales = {
  // Null once the product itself is deleted. Kept in the key rather than
  // discarded: two deleted products can share a name, and folding those into
  // one row invents a product that never existed.
  productId: string | null;
  name: string;
  unitsSold: number;
  revenueCents: number;
};

// What sold, from the frozen line snapshots on each sale — so a product
// renamed or repriced later doesn't rewrite what last week sold for.
//
// Gross of refunds, deliberately. A `PeriodRefund` carries only
// `{ quantity, unitCostCents }` (see refund_sale_items), with no product
// identity on it, so a refund cannot be attributed to a line here. Any screen
// showing these figures beside net revenue has to say which it is showing.
export function productPerformance(sales: Sale[], limit = 5): ProductSales[] {
  const totals = new Map<string, ProductSales>();
  for (const sale of sales) {
    for (const item of sale.items ?? []) {
      const key = item.productId ?? `name:${item.productName}`;
      const row = totals.get(key);
      if (row) {
        row.unitsSold += item.quantity;
        row.revenueCents += item.lineTotalCents;
      } else {
        totals.set(key, {
          productId: item.productId,
          name: item.productName,
          unitsSold: item.quantity,
          revenueCents: item.lineTotalCents,
        });
      }
    }
  }
  return Array.from(totals.values())
    .sort((a, b) => b.revenueCents - a.revenueCents)
    .slice(0, limit);
}

export type ProductMover = {
  productId: string | null;
  name: string;
  revenueCents: number;
  previousCents: number;
  // Null when the product did not sell at all in the prior window. A rise
  // from zero has no percentage — reporting one would be dividing by nothing
  // and calling the result news.
  changePct: number | null;
};

// What moved, not what is biggest. `productPerformance` already answers which
// products are large; this answers which ones changed, against the same-length
// window immediately before.
export function productMovers(
  current: ProductSales[],
  previous: ProductSales[],
  options: {
    limit?: number;
    /**
     * Ignore products below this share of the period's revenue. A 400% jump on
     * 1% of takings is arithmetic, not news, and a card that leads with it
     * teaches people to stop reading the card. Expressed as a share rather
     * than an amount so it means the same thing in a kiosk and a supermarket.
     */
    minShareOfRevenue?: number;
    /**
     * False when no prior window was fetched. Returns nothing rather than
     * comparing against an empty array, which would report every product as
     * brand new — the same rule the delta badges follow.
     */
    hasPrevious?: boolean;
  } = {}
): ProductMover[] {
  const { limit = 3, minShareOfRevenue = 0.02, hasPrevious = true } = options;
  if (!hasPrevious) return [];

  const totalCents = current.reduce((sum, row) => sum + row.revenueCents, 0);
  const floorCents = totalCents * minShareOfRevenue;
  const priorByKey = new Map(previous.map((row) => [row.productId ?? `name:${row.name}`, row.revenueCents]));

  return current
    .filter((row) => row.revenueCents >= floorCents)
    .map((row) => {
      const previousCents = priorByKey.get(row.productId ?? `name:${row.name}`) ?? 0;
      return {
        productId: row.productId,
        name: row.name,
        revenueCents: row.revenueCents,
        previousCents,
        changePct: previousCents > 0 ? ((row.revenueCents - previousCents) / previousCents) * 100 : null,
      };
    })
    .sort((a, b) => {
      // A measured change always outranks an unmeasurable one, however large
      // the new product is — otherwise the top slot goes to whichever product
      // happens to be new, every time.
      if (a.changePct === null && b.changePct === null) return b.revenueCents - a.revenueCents;
      if (a.changePct === null) return 1;
      if (b.changePct === null) return -1;
      return Math.abs(b.changePct) - Math.abs(a.changePct);
    })
    .slice(0, limit);
}

export type HourBucket = { hour: number; grossCents: number; orderCount: number };

// Takings by hour of the day, bounded by the shop's posted opening hours so
// the chart stops where the shutter does instead of drawing twelve empty
// hours either side of the trading day.
//
// Gross, like `cashierPerformance`: this is a till question — when does money
// come through the door — not a profit one.
export function hourlyTakings(
  sales: Sale[],
  openHour: number,
  closeHour: number
): { buckets: HourBucket[]; outsideCents: number } {
  if (closeHour < openHour) return { buckets: [], outsideCents: 0 };

  const buckets: HourBucket[] = [];
  for (let hour = openHour; hour <= closeHour; hour++) buckets.push({ hour, grossCents: 0, orderCount: 0 });

  let outsideCents = 0;
  for (const sale of sales) {
    const hour = new Date(sale.createdAt).getHours();
    // Clamped into the nearest open hour rather than dropped. A sale rung up
    // before opening is real money: dropping it makes this chart disagree
    // with the P&L. `outsideCents` is returned so the caller can say so
    // instead of the total quietly landing on the first bar.
    const clamped = Math.min(Math.max(hour, openHour), closeHour);
    if (hour !== clamped) outsideCents += sale.totalCents;
    const bucket = buckets[clamped - openHour];
    bucket.grossCents += sale.totalCents;
    bucket.orderCount += 1;
  }
  return { buckets, outsideCents };
}

export type PaymentMixEntry = { method: PaymentMethod; amountCents: number; pct: number };

// How takings split across payment methods. Falls back to the sale's own
// `paymentMethod` when it carries no payment lines — sales predating split
// payments have the method on the sale itself, and dropping them would
// silently under-report the mix.
export function paymentMethodMix(sales: Sale[]): PaymentMixEntry[] {
  const totals = new Map<PaymentMethod, number>();
  for (const sale of sales) {
    if (sale.payments && sale.payments.length > 0) {
      for (const payment of sale.payments) {
        totals.set(payment.method, (totals.get(payment.method) ?? 0) + payment.amountCents);
      }
    } else {
      totals.set(sale.paymentMethod, (totals.get(sale.paymentMethod) ?? 0) + sale.totalCents);
    }
  }
  const grandTotal = Array.from(totals.values()).reduce((sum, cents) => sum + cents, 0);
  return Array.from(totals.entries())
    .map(([method, amountCents]) => ({ method, amountCents, pct: grandTotal > 0 ? (amountCents / grandTotal) * 100 : 0 }))
    .sort((a, b) => b.amountCents - a.amountCents);
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

// One product's day-by-day take, for the sparkline on a mover card. Answers
// the question a percentage raises but cannot settle: was this a steady climb
// or one unusual afternoon?
//
// Same day bucketing and the same product key as `bucketDailyTotals` and
// `productPerformance`, so the three cannot disagree about which day a sale
// landed on or which line belongs to which product.
export function productDailyRevenue(
  sales: Sale[],
  product: { productId: string | null; name: string },
  sinceDate: Date,
  untilDate?: Date
): number[] {
  const since = startOfDay(sinceDate);
  const until = untilDate ? new Date(untilDate) : new Date();
  const dayCount = Math.max(1, Math.floor((until.getTime() - since.getTime()) / 86_400_000) + 1);
  const wanted = product.productId ?? `name:${product.name}`;

  const byDay = new Map<string, number>();
  for (let i = 0; i < dayCount; i++) {
    const day = new Date(since);
    day.setDate(since.getDate() + i);
    byDay.set(dayKeyFor(day), 0);
  }
  for (const sale of sales) {
    const key = dayKeyFor(sale.createdAt);
    if (!byDay.has(key)) continue;
    for (const item of sale.items ?? []) {
      if ((item.productId ?? `name:${item.productName}`) !== wanted) continue;
      byDay.set(key, (byDay.get(key) ?? 0) + item.lineTotalCents);
    }
  }
  return Array.from(byDay.values());
}
