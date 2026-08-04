import { supabase } from '@/lib/supabase';
import type {
  Budget,
  CashAccount,
  ExpenseCategory,
  NewCashAccountInput,
  NewRecurringBillInput,
  RecurringBill,
} from '@/types/models';

// Data access for the three planning surfaces. They share a table-free module
// because they share one screen and one permission; the pure arithmetic lives
// in cash-budget-reporting.ts so it can be tested.

// --- Cash accounts ---

function mapCashAccountRow(row: any): CashAccount {
  return {
    id: row.id,
    shopId: row.shop_id,
    locationId: row.location_id,
    name: row.name,
    accountType: row.account_type,
    balanceCents: row.balance_cents,
    notes: row.notes,
    balanceAsOf: row.balance_as_of,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCashAccounts(shopId: string): Promise<CashAccount[]> {
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('*')
    .eq('shop_id', shopId)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapCashAccountRow);
}

export async function createCashAccount(shopId: string, input: NewCashAccountInput): Promise<CashAccount> {
  const { data, error } = await supabase
    .from('cash_accounts')
    .insert({
      shop_id: shopId,
      name: input.name,
      account_type: input.accountType,
      balance_cents: input.balanceCents,
      notes: input.notes,
    })
    .select('*')
    .single();
  if (error) throw error;
  return mapCashAccountRow(data);
}

// Confirming a balance stamps `balance_as_of`, which is what the
// "expected change since" hint measures from.
export async function updateCashAccount(id: string, patch: Partial<NewCashAccountInput>): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('cash_accounts')
    .update({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.accountType !== undefined && { account_type: patch.accountType }),
      ...(patch.balanceCents !== undefined && { balance_cents: patch.balanceCents, balance_as_of: now }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
      updated_at: now,
      updated_by: userData.user?.id ?? null,
    })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteCashAccount(id: string): Promise<void> {
  const { error } = await supabase.from('cash_accounts').delete().eq('id', id);
  if (error) throw error;
}

// --- Recurring bills ---

function mapRecurringBillRow(row: any): RecurringBill {
  return {
    id: row.id,
    shopId: row.shop_id,
    locationId: row.location_id ?? null,
    name: row.name,
    category: row.category,
    frequency: row.frequency,
    amountCents: row.amount_cents,
    paymentMethod: row.payment_method,
    nextDueDate: row.next_due_date,
    vendorId: row.vendor_id,
    active: row.active,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listRecurringBills(shopId: string): Promise<RecurringBill[]> {
  const { data, error } = await supabase
    .from('recurring_bills')
    .select('*')
    .eq('shop_id', shopId)
    .order('next_due_date', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapRecurringBillRow);
}

export async function createRecurringBill(shopId: string, input: NewRecurringBillInput): Promise<RecurringBill> {
  const { data, error } = await supabase
    .from('recurring_bills')
    .insert({
      shop_id: shopId,
      name: input.name,
      category: input.category,
      frequency: input.frequency,
      amount_cents: input.amountCents,
      payment_method: input.paymentMethod,
      next_due_date: input.nextDueDate,
      vendor_id: input.vendorId,
      active: input.active,
      notes: input.notes,
    })
    .select('*')
    .single();
  if (error) throw error;
  return mapRecurringBillRow(data);
}

export async function updateRecurringBill(id: string, patch: Partial<NewRecurringBillInput>): Promise<void> {
  const { error } = await supabase
    .from('recurring_bills')
    .update({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.category !== undefined && { category: patch.category }),
      ...(patch.frequency !== undefined && { frequency: patch.frequency }),
      ...(patch.amountCents !== undefined && { amount_cents: patch.amountCents }),
      ...(patch.paymentMethod !== undefined && { payment_method: patch.paymentMethod }),
      ...(patch.nextDueDate !== undefined && { next_due_date: patch.nextDueDate }),
      ...(patch.vendorId !== undefined && { vendor_id: patch.vendorId }),
      ...(patch.active !== undefined && { active: patch.active }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteRecurringBill(id: string): Promise<void> {
  const { error } = await supabase.from('recurring_bills').delete().eq('id', id);
  if (error) throw error;
}

// Posts the bill as a real expense and advances its due date, atomically --
// see log_recurring_bill in the migration for why this can't be two client
// calls.
export async function logRecurringBill(billId: string, occurredOn?: string): Promise<string> {
  const { data, error } = await supabase.rpc('log_recurring_bill', {
    p_bill_id: billId,
    p_occurred_on: occurredOn ?? null,
  });
  if (error) throw error;
  return data as string;
}

// --- Budgets ---

function mapBudgetRow(row: any): Budget {
  return {
    id: row.id,
    shopId: row.shop_id,
    locationId: row.location_id ?? null,
    category: row.category,
    limitCents: row.limit_cents,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listBudgets(shopId: string): Promise<Budget[]> {
  const { data, error } = await supabase.from('budgets').select('*').eq('shop_id', shopId);
  if (error) throw error;
  return (data ?? []).map(mapBudgetRow);
}

// Upsert rather than insert-or-update from the client: the unique constraint
// on (shop_id, category) is the thing keeping one category to one budget, and
// racing two edits through a read-then-write would defeat it.
export async function upsertBudget(shopId: string, category: ExpenseCategory, limitCents: number): Promise<void> {
  const { error } = await supabase
    .from('budgets')
    .upsert(
      { shop_id: shopId, category, limit_cents: limitCents, updated_at: new Date().toISOString() },
      { onConflict: 'shop_id,category' }
    );
  if (error) throw error;
}

export async function deleteBudget(shopId: string, category: ExpenseCategory): Promise<void> {
  const { error } = await supabase.from('budgets').delete().eq('shop_id', shopId).eq('category', category);
  if (error) throw error;
}
