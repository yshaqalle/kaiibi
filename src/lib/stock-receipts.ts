import { supabase } from '@/lib/supabase';
import type { UnbilledDelivery } from '@/types/models';

// Deliveries the shop has received, for the one place that has to choose one:
// the bill form, which must say which delivery a bill pays for.
//
// Why this is an RPC and not a `.from('stock_receipts')` query. "Not yet on a
// bill" is a NOT EXISTS against `invoices`, which PostgREST cannot express, and
// the value of a delivery is a sum over its items. Doing either client-side
// would mean fetching every delivery and every bill the shop has ever had —
// which PostgREST truncates at `max-rows` with no error, so past a thousand rows
// the picker would quietly start offering deliveries that are already billed.
// That is the same truncation `accounts_payable_debit` (20260908001700) was
// written to remove from the Bills screen.

// `search` goes to the database rather than filtering what came back, and the
// limit is 100 rather than a page a shop grows out of. NO EXISTING BILL CARRIES
// A LINK, so "not yet on a bill" starts as every delivery the shop has ever
// received — the list does not grow into being long, it begins that way, and a
// delivery past the end of the page is exactly the one the person is hunting
// for. The field is mandatory for a goods bill, so a delivery that cannot be
// found leaves mis-classifying the bill as the only way to save it.
export async function listUnbilledDeliveries(
  shopId: string,
  search: string | null = null,
  limit = 100
): Promise<UnbilledDelivery[]> {
  const { data, error } = await supabase.rpc('unbilled_stock_receipts', {
    p_shop_id: shopId,
    p_limit: limit,
    p_search: search,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    receivedAt: String(row.received_at),
    supplierName: (row.supplier_name as string | null) ?? null,
    reference: (row.reference as string | null) ?? null,
    locationId: (row.location_id as string | null) ?? null,
    // Both arrive as bigint, which PostgREST sends as a STRING — a bare `+` on
    // one would concatenate rather than add, and `valueCents` is compared
    // against the bill's amount below the picker.
    itemCount: Number(row.item_count ?? 0),
    valueCents: Number(row.value_cents ?? 0),
  }));
}
