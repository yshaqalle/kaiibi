import { containsPattern, orFilterValue } from '@/lib/like-pattern';
import { toDateColumn } from '@/lib/period';
import { supabase } from '@/lib/supabase';
import type { Expense, NewExpenseInput } from '@/types/models';

// Data access only. The category catalog and the pure roll-ups live in
// expense-reporting.ts so they stay testable -- importing this module pulls in
// the Supabase client, which needs a native runtime.

function mapExpenseRow(row: any): Expense {
  return {
    id: row.id,
    shopId: row.shop_id,
    locationId: row.location_id ?? null,
    occurredOn: row.occurred_on,
    amountCents: row.amount_cents,
    category: row.category,
    vendorId: row.vendor_id,
    vendorName: row.vendor?.name ?? null,
    paymentMethod: row.payment_method,
    note: row.note,
    invoiceId: row.invoice_id ?? null,
    payrollRunId: row.payroll_run_id ?? null,
    stockReceiptId: row.stock_receipt_id ?? null,
    stockCountId: row.stock_count_id ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(input: Partial<NewExpenseInput>) {
  return {
    // `null` is a real value here -- business-wide, not "unset" -- so this is
    // keyed off `undefined`, like every other field, rather than off falsiness.
    // Without this line the column added by migration 20260816000000 was never
    // written by anything the APP inserts: the expense editor's store picker
    // set it, `createExpense` dropped it, and per-store reporting then read
    // every hand-entered cost as unattributed business-wide overhead. (The
    // rows that migration generates itself -- from a vendor bill, from a pay
    // run -- always had it, which is what made the gap easy to miss.)
    ...(input.locationId !== undefined && { location_id: input.locationId }),
    ...(input.occurredOn !== undefined && { occurred_on: input.occurredOn }),
    ...(input.amountCents !== undefined && { amount_cents: input.amountCents }),
    ...(input.category !== undefined && { category: input.category }),
    ...(input.vendorId !== undefined && { vendor_id: input.vendorId }),
    ...(input.paymentMethod !== undefined && { payment_method: input.paymentMethod }),
    ...(input.note !== undefined && { note: input.note }),
    // What the row POSTS turns on these, not just what it is linked to:
    // a receipt-linked row settles the payable the delivery raised (Dr 2000 /
    // Cr the wallet) instead of debiting 1200 a second time, and a count-linked
    // row posts nothing because save_stock_count already posted both sides.
    // Dropping either here — the exact bug migration 20260816000000's comment
    // above records for location_id — would send both straight back to the
    // double-count they were added to stop, silently, with every entry still
    // balancing.
    ...(input.stockReceiptId !== undefined && { stock_receipt_id: input.stockReceiptId }),
    ...(input.stockCountId !== undefined && { stock_count_id: input.stockCountId }),
  };
}

const SELECT_WITH_VENDOR = '*, vendor:vendors(name)';

export async function listExpensesInRange(shopId: string, since: Date, until?: Date): Promise<Expense[]> {
  let query = supabase
    .from('expenses')
    .select(SELECT_WITH_VENDOR)
    .eq('shop_id', shopId)
    .gte('occurred_on', toDateColumn(since))
    .order('occurred_on', { ascending: false })
    .order('created_at', { ascending: false });
  // An open-ended range means "through today"; leaving the upper bound off
  // entirely would also pick up expenses post-dated into the future, quietly
  // inflating the current period.
  if (until) query = query.lte('occurred_on', toDateColumn(until));
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapExpenseRow);
}

// Type-ahead for global search.
//
// Matches the note and the category only -- NOT the vendor name, which lives
// on the joined `vendors` row. PostgREST cannot filter a top-level `or` across
// an embedded table, and turning this into a two-query merge to reach it is
// not worth it: an expense is found by what it was for, and a search for the
// vendor itself already returns the vendor and its bills.
export async function searchExpenses(shopId: string, query: string): Promise<Expense[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  // Quoted for the `or` list -- a note with a comma in it would otherwise
  // break the filter rather than match. See orFilterValue.
  const pattern = orFilterValue(containsPattern(q));
  const { data, error } = await supabase
    .from('expenses')
    .select(SELECT_WITH_VENDOR)
    .eq('shop_id', shopId)
    .or(`note.ilike.${pattern},category.ilike.${pattern}`)
    .order('occurred_on', { ascending: false })
    .limit(6);
  if (error) throw error;
  return (data ?? []).map(mapExpenseRow);
}

export async function createExpense(shopId: string, input: NewExpenseInput): Promise<Expense> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('expenses')
    .insert({ shop_id: shopId, ...toRow(input), created_by: userData.user?.id ?? null })
    .select(SELECT_WITH_VENDOR)
    .single();
  if (error) throw error;
  return mapExpenseRow(data);
}

export async function updateExpense(id: string, patch: Partial<NewExpenseInput>): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('expenses')
    .update({ ...toRow(patch), updated_at: new Date().toISOString(), updated_by: userData.user?.id ?? null })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteExpense(id: string): Promise<void> {
  const { error } = await supabase.from('expenses').delete().eq('id', id);
  if (error) throw error;
}
