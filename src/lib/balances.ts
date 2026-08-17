import { buildPaymentPayload } from '@/lib/sales';
import { supabase } from '@/lib/supabase';
import type { PaymentLine } from '@/types/models';

// One unsettled sale, as `public.customer_balances` reports it. A customer who
// owes on three sales is three of these -- there is no per-customer row,
// because the debt lives on the sales themselves rather than in a ledger of
// its own (see migration 20260831000000).
export type CustomerBalance = {
  customerId: string;
  customerName: string | null;
  saleId: string;
  saleCreatedAt: string;
  totalCents: number;
  paidCents: number;
  refundedCents: number;
  owedCents: number;
};

export type SettlementAllocation = { saleId: string; payments: PaymentLine[] };

function mapRow(row: any): CustomerBalance {
  return {
    customerId: row.customer_id,
    customerName: row.customer_name ?? null,
    saleId: row.sale_id,
    saleCreatedAt: row.sale_created_at,
    totalCents: row.total_cents ?? 0,
    paidCents: row.paid_cents ?? 0,
    refundedCents: row.refunded_cents ?? 0,
    owedCents: row.owed_cents ?? 0,
  };
}

// Ascending by when the sale was rung up, then by id. The tiebreak is not
// decoration: two sales can share a timestamp, and without it the order is
// whatever the query happened to return -- so the same settlement pays down a
// different sale each time a cashier retries it.
function oldestFirst(a: CustomerBalance, b: CustomerBalance): number {
  if (a.saleCreatedAt !== b.saleCreatedAt) return a.saleCreatedAt < b.saleCreatedAt ? -1 : 1;
  if (a.saleId !== b.saleId) return a.saleId < b.saleId ? -1 : 1;
  return 0;
}

/**
 * Which sale a settlement pays down, when a customer owes on more than one.
 *
 * Oldest debt first, never more than a sale owes, and never more than was
 * handed over -- a payment that outruns the debts is truncated rather than
 * over-applied, because `settle_sale_balance` refuses an overshoot and the
 * cashier is standing in front of the customer when it does.
 *
 * Pure, so the whole of this decision is testable without a database.
 */
export function allocate(payments: PaymentLine[], sales: CustomerBalance[]): SettlementAllocation[] {
  const debts = sales.filter((sale) => sale.owedCents > 0).sort(oldestFirst);
  const perSale = new Map<string, PaymentLine[]>();

  let index = 0;
  let owedOnThisSale = debts[0]?.owedCents ?? 0;

  for (const payment of payments) {
    const slices: { saleId: string; amountCents: number }[] = [];
    let unapplied = payment.amountCents;

    while (unapplied > 0 && index < debts.length) {
      const take = Math.min(unapplied, owedOnThisSale);
      if (take > 0) {
        slices.push({ saleId: debts[index].saleId, amountCents: take });
        unapplied -= take;
        owedOnThisSale -= take;
      }
      if (owedOnThisSale === 0) {
        index += 1;
        owedOnThisSale = debts[index]?.owedCents ?? 0;
      }
    }

    // A payment cut across two sales loses its tender and its foreign-currency
    // detail. Those describe one physical transaction -- a $50 note handed over
    // -- not either sale's share of it, and repeating "5000 tendered" against a
    // 3474 slice claims 1526 in change that nobody was given. The server reads
    // only amount_cents when working out what is still owed.
    const wasSplit = slices.length > 1;
    for (const slice of slices) {
      const line: PaymentLine = wasSplit
        ? {
            ...payment,
            amountCents: slice.amountCents,
            tenderedCents: null,
            foreignAmountCents: null,
            foreignChangeCents: null,
          }
        : { ...payment, amountCents: slice.amountCents };
      const existing = perSale.get(slice.saleId);
      if (existing) existing.push(line);
      else perSale.set(slice.saleId, [line]);
    }
  }

  // Map insertion order follows the debts in age order, so the caller settles
  // the oldest sale first without having to re-sort.
  return [...perSale.entries()].map(([saleId, lines]) => ({ saleId, payments: lines }));
}

// What one customer owes, across every sale of theirs that is still open.
//
// `oldest` is the sale a settlement lands on first, so a caller can say "paying
// off the 12 Aug sale" without re-sorting.
export async function customerBalance(
  shopId: string,
  customerId: string
): Promise<{ owedCents: number; oldest: CustomerBalance | null; sales: CustomerBalance[] }> {
  const { data, error } = await supabase
    .from('customer_balances')
    .select('*')
    .eq('shop_id', shopId)
    .eq('customer_id', customerId)
    .order('sale_created_at', { ascending: true });
  // Thrown rather than treated as "owes nothing": a screen that reads 0 owed
  // because the query failed is worse than one that says it could not load.
  if (error) throw error;
  const sales = ((data as any[] | null) ?? []).map(mapRow);
  return {
    owedCents: sales.reduce((sum, sale) => sum + sale.owedCents, 0),
    oldest: sales[0] ?? null,
    sales,
  };
}

// Everything the shop is owed, for the receivables list.
export async function listOutstanding(shopId: string): Promise<CustomerBalance[]> {
  const { data, error } = await supabase
    .from('customer_balances')
    .select('*')
    .eq('shop_id', shopId)
    .order('sale_created_at', { ascending: true });
  if (error) throw error;
  return ((data as any[] | null) ?? []).map(mapRow);
}

/**
 * Take money against a sale that is already rung up. Returns the cents still
 * owed on it afterwards, so a till can say "1200 to go" without a second read.
 *
 * `registerSessionId` is omitted rather than sent as null when absent, matching
 * `completeSale` -- a shop that never opens a register keeps working as it
 * does today. The server validates the session is open and belongs to this
 * shop; it is not taken on trust.
 */
export async function settleBalance(
  saleId: string,
  payments: PaymentLine[],
  registerSessionId: string | null
): Promise<number> {
  if (payments.length === 0) throw new Error('At least one payment is required');
  const { data, error } = await supabase.rpc('settle_sale_balance', {
    p_sale_id: saleId,
    p_payments: buildPaymentPayload(payments),
    ...(registerSessionId ? { p_register_session_id: registerSessionId } : {}),
  });
  if (error) throw error;
  return (data as number | null) ?? 0;
}
