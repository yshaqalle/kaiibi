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

// Not date-range scoped: the outstanding-balance tiles need every unpaid bill
// regardless of when it was raised, and a shop's bill list is small enough
// that filtering the visible rows client-side beats a second round trip.
export async function listInvoices(shopId: string): Promise<Invoice[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select(SELECT_WITH_PAYMENTS)
    .eq('shop_id', shopId)
    .order('due_on', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapInvoiceRow);
}

// The linked expense row is created by a database trigger, not here -- see the
// invoices migration for why that isn't done client-side.
export async function createInvoice(shopId: string, input: NewInvoiceInput): Promise<Invoice> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('invoices')
    .insert({ shop_id: shopId, ...toRow(input), created_by: userData.user?.id ?? null })
    .select(SELECT_WITH_PAYMENTS)
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

// Undoes a mis-keyed payment. paid_cents is recomputed from what's left rather
// than decremented, so a double-undo can't drive it negative.
export async function deleteInvoicePayment(paymentId: string, invoiceId: string): Promise<void> {
  const { error: deleteError } = await supabase.from('invoice_payments').delete().eq('id', paymentId);
  if (deleteError) throw deleteError;

  const { data: remaining, error: readError } = await supabase
    .from('invoice_payments')
    .select('amount_cents')
    .eq('invoice_id', invoiceId);
  if (readError) throw readError;

  const paidCents = (remaining ?? []).reduce((sum, row: any) => sum + row.amount_cents, 0);
  const { error: updateError } = await supabase
    .from('invoices')
    .update({ paid_cents: paidCents, updated_at: new Date().toISOString() })
    .eq('id', invoiceId);
  if (updateError) throw updateError;
}
