import { containsPattern } from '@/lib/like-pattern';
import { toDateColumn } from '@/lib/period';
import { supabase } from '@/lib/supabase';
import type { Invoice, InvoicePayment, NewInvoiceInput } from '@/types/models';

// Data access for vendor bills. Status/roll-up logic lives in
// invoice-reporting.ts so it stays testable.

function mapPaymentRow(row: any): InvoicePayment {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    amountCents: row.amount_cents,
    paidOn: row.paid_on,
    method: row.method,
    note: row.note,
    createdAt: row.created_at,
  };
}

function mapInvoiceRow(row: any): Invoice {
  return {
    id: row.id,
    shopId: row.shop_id,
    locationId: row.location_id ?? null,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    vendorPhone: row.vendor_phone,
    invoiceNumber: row.invoice_number,
    category: row.category,
    description: row.description,
    issuedOn: row.issued_on,
    dueOn: row.due_on,
    amountCents: row.amount_cents,
    paidCents: row.paid_cents ?? 0,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    payments: (row.invoice_payments ?? []).map(mapPaymentRow),
  };
}

function toRow(input: Partial<NewInvoiceInput>) {
  return {
    ...(input.vendorId !== undefined && { vendor_id: input.vendorId }),
    ...(input.vendorName !== undefined && { vendor_name: input.vendorName }),
    ...(input.vendorPhone !== undefined && { vendor_phone: input.vendorPhone }),
    ...(input.invoiceNumber !== undefined && { invoice_number: input.invoiceNumber }),
    ...(input.category !== undefined && { category: input.category }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.issuedOn !== undefined && { issued_on: input.issuedOn }),
    ...(input.dueOn !== undefined && { due_on: input.dueOn }),
    ...(input.amountCents !== undefined && { amount_cents: input.amountCents }),
  };
}

const SELECT_WITH_PAYMENTS = '*, invoice_payments(*)';

// Payment history is only read when the record-payment modal is open, so it's
// left off the list queries below -- it's per-bill nested data that would
// otherwise grow the payload with every payment ever made. Status and balance
// come from `paid_cents` on the bill itself and need none of it.
const SELECT_LIST = '*';

// Every bill still owed, whenever it was raised. Deliberately not date-scoped:
// a bill from four months ago that was never paid is exactly the one the
// outstanding and overdue totals must not hide, and truncating this query
// would silently understate the debt.
//
// Bounded by how much the shop actually owes rather than by how long it has
// been trading, so it stays small as history accumulates.
export async function listOpenInvoices(shopId: string): Promise<Invoice[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select(SELECT_LIST)
    .eq('shop_id', shopId)
    .eq('settled', false)
    .order('due_on', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapInvoiceRow);
}

// Bills issued inside the selected window, for the visible list. Bounded by
// the range; `limit` is a backstop for someone picking a very wide custom
// range, not the primary bound.
export async function listInvoicesInRange(shopId: string, since: Date, until?: Date, limit = 200): Promise<Invoice[]> {
  let query = supabase
    .from('invoices')
    .select(SELECT_LIST)
    .eq('shop_id', shopId)
    .gte('issued_on', toDateColumn(since))
    .order('issued_on', { ascending: false })
    .limit(limit);
  if (until) query = query.lte('issued_on', toDateColumn(until));
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapInvoiceRow);
}

// Type-ahead for global search. Not date-scoped, for the same reason
// listOpenInvoices isn't: someone searching a supplier's name wants the bill
// they are arguing about, and it is usually the old unpaid one.
export async function searchInvoices(shopId: string, query: string): Promise<Invoice[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const pattern = containsPattern(q);
  const { data, error } = await supabase
    .from('invoices')
    .select(SELECT_LIST)
    .eq('shop_id', shopId)
    .or(`vendor_name.ilike.${pattern},invoice_number.ilike.${pattern},description.ilike.${pattern}`)
    .order('due_on', { ascending: true })
    .limit(6);
  if (error) throw error;
  return (data ?? []).map(mapInvoiceRow);
}

// One bill with its payment history — for the record-payment modal, which is
// the only place that needs it.
export async function getInvoiceWithPayments(id: string): Promise<Invoice> {
  const { data, error } = await supabase.from('invoices').select(SELECT_WITH_PAYMENTS).eq('id', id).single();
  if (error) throw error;
  return mapInvoiceRow(data);
}

// The linked expense row is created by a database trigger, not here -- see the
// invoices migration for why that isn't done client-side.
export async function createInvoice(shopId: string, input: NewInvoiceInput): Promise<Invoice> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('invoices')
    .insert({ shop_id: shopId, ...toRow(input), created_by: userData.user?.id ?? null })
    .select(SELECT_LIST)
    .single();
  if (error) throw error;
  return mapInvoiceRow(data);
}

export async function updateInvoice(id: string, patch: Partial<NewInvoiceInput>): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('invoices')
    .update({ ...toRow(patch), updated_at: new Date().toISOString(), updated_by: userData.user?.id ?? null })
    .eq('id', id);
  if (error) throw error;
}

// Cascades to the bill's payments and its generated expense row.
export async function deleteInvoice(id: string): Promise<void> {
  const { error } = await supabase.from('invoices').delete().eq('id', id);
  if (error) throw error;
}

// Goes through the RPC rather than inserting directly: paid_cents has to move
// in the same transaction, under a row lock, or two concurrent payments can
// both pass a stale balance check.
export async function recordInvoicePayment(
  invoiceId: string,
  amountCents: number,
  opts?: { paidOn?: string; method?: InvoicePayment['method']; note?: string | null }
): Promise<string> {
  const { data, error } = await supabase.rpc('record_invoice_payment', {
    p_invoice_id: invoiceId,
    p_amount_cents: amountCents,
    p_paid_on: opts?.paidOn ?? undefined,
    p_method: opts?.method ?? 'cash',
    p_note: opts?.note ?? null,
  });
  if (error) throw error;
  return data as string;
}

// Undoes a mis-keyed payment. Goes through an RPC for the same reason
// recording one does: the delete and the recount of `paid_cents` have to
// happen together under a lock, or two concurrent undos can leave the total
// disagreeing with the payments actually on the bill.
export async function deleteInvoicePayment(paymentId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_invoice_payment', { p_payment_id: paymentId });
  if (error) throw error;
}
