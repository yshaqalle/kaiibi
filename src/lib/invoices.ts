import { containsPattern, orFilterValue } from '@/lib/like-pattern';
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
    // Defaulted rather than trusted: a bill written before migration
    // 20260902000500 has no column, and every one of those was a credit bill.
    paymentTerms: row.payment_terms ?? 'credit',
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
    ...(input.paymentTerms !== undefined && { payment_terms: input.paymentTerms }),
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
  // Quoted for the `or` list -- a vendor name with a comma in it ("Ahmed, Ltd")
  // would otherwise break the filter rather than match. See orFilterValue.
  const pattern = orFilterValue(containsPattern(q));
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
//
// Goes through `record_bill` rather than inserting, and the reason is the cash
// bill: it has to be raised AND settled together, or a half-succeeded pair of
// calls leaves the shop looking as though it owes a supplier it has already
// paid. A credit bill takes the same path so there is one way a bill is
// created rather than two shapes of the same act.
export async function createInvoice(shopId: string, input: NewInvoiceInput): Promise<Invoice> {
  const { data: invoiceId, error } = await supabase.rpc('record_bill', {
    p_shop_id: shopId,
    p_invoice_number: input.invoiceNumber,
    p_amount_cents: input.amountCents,
    p_category: input.category,
    p_due_on: input.dueOn,
    p_issued_on: input.issuedOn,
    p_payment_terms: input.paymentTerms,
    p_vendor_id: input.vendorId,
    p_vendor_name: input.vendorName,
    p_vendor_phone: input.vendorPhone,
    p_description: input.description,
    p_location_id: input.locationId,
    p_payment_method: input.paymentMethod ?? 'cash',
  });
  if (error) throw error;

  const { data, error: readError } = await supabase
    .from('invoices')
    .select(SELECT_LIST)
    .eq('id', invoiceId as string)
    .single();
  if (readError) throw readError;
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

/**
 * Every payment made against a bill in a window.
 *
 * The cash-flow statement's "paid on vendor bills" line. Like customer
 * payments, it cannot be derived from the bills in the period: a bill raised
 * in March is paid in April, and April is when the money left.
 *
 * `!inner` on the bill so the shop filter applies -- `invoice_payments` has no
 * shop of its own.
 */
export async function billPaymentsInRange(
  shopId: string,
  since: Date,
  until?: Date,
  locationId?: string | null
): Promise<{ amountCents: number; paidOn: string }[]> {
  let query = supabase
    .from('invoice_payments')
    .select('amount_cents, paid_on, invoice:invoices!inner(shop_id, location_id)')
    .eq('invoice.shop_id', shopId)
    .gte('paid_on', toDateColumn(since));
  if (until) query = query.lte('paid_on', toDateColumn(until));
  if (locationId) query = query.eq('invoice.location_id', locationId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row: any) => ({ amountCents: row.amount_cents ?? 0, paidOn: row.paid_on }));
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
