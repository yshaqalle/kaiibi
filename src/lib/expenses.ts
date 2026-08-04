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
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(input: Partial<NewExpenseInput>) {
  return {
    ...(input.occurredOn !== undefined && { occurred_on: input.occurredOn }),
    ...(input.amountCents !== undefined && { amount_cents: input.amountCents }),
    ...(input.category !== undefined && { category: input.category }),
    ...(input.vendorId !== undefined && { vendor_id: input.vendorId }),
    ...(input.paymentMethod !== undefined && { payment_method: input.paymentMethod }),
    ...(input.note !== undefined && { note: input.note }),
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
