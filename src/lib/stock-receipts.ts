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

export async function listUnbilledDeliveries(shopId: string, limit = 25): Promise<UnbilledDelivery[]> {
  const { data, error } = await supabase.rpc('unbilled_stock_receipts', {
    p_shop_id: shopId,
    p_limit: limit,
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
