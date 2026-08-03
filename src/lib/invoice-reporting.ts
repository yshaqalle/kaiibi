import { fromDateColumn, startOfDay } from '@/lib/period';
import type { Invoice } from '@/types/models';

// Pure status/roll-up logic for vendor bills, kept out of invoices.ts so it
// can be unit-tested (that module imports the Supabase client, which needs a
// native runtime).

export type InvoiceStatus = 'paid' | 'partial' | 'overdue' | 'open';

export function balanceCents(invoice: Invoice): number {
  return invoice.amountCents - invoice.paidCents;
}

// Derived on read rather than stored: "overdue" is a function of today's date,
// so a stored flag would be wrong the morning after it was written unless
// something walked the table to update it.
export function invoiceStatus(invoice: Invoice, today: Date = new Date()): InvoiceStatus {
  if (balanceCents(invoice) <= 0) return 'paid';
  // Due *on* a day means it isn't late until that day has passed.
  if (fromDateColumn(invoice.dueOn).getTime() < startOfDay(today).getTime()) return 'overdue';
  return invoice.paidCents > 0 ? 'partial' : 'open';
}

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  paid: 'Paid',
  partial: 'Part paid',
  overdue: 'Overdue',
  open: 'Open',
};

// Maps onto Badge's tones: an overdue bill is the one that needs action.
export const INVOICE_STATUS_TONES: Record<InvoiceStatus, 'default' | 'success' | 'warning' | 'danger'> = {
  paid: 'success',
  partial: 'warning',
  overdue: 'danger',
  open: 'default',
};

export type InvoiceTotals = {
  outstandingCents: number;
  overdueCents: number;
  openCount: number;
};

// Deliberately not scoped to the screen's date range: what you still owe is a
// fact about right now, not about a reporting window. A bill raised four
// months ago and never paid is exactly the one worth surfacing.
export function invoiceTotals(invoices: Invoice[], today: Date = new Date()): InvoiceTotals {
  let outstandingCents = 0;
  let overdueCents = 0;
  let openCount = 0;

  for (const invoice of invoices) {
    const balance = balanceCents(invoice);
    if (balance <= 0) continue;
    outstandingCents += balance;
    openCount += 1;
    if (invoiceStatus(invoice, today) === 'overdue') overdueCents += balance;
  }

  return { outstandingCents, overdueCents, openCount };
}

// Unpaid first (they need action), then by due date. Settled bills sink to the
// bottom in reverse date order, so recent history stays reachable.
export function sortInvoicesForDisplay(invoices: Invoice[], today: Date = new Date()): Invoice[] {
  return [...invoices].sort((a, b) => {
    const aSettled = balanceCents(a) <= 0;
    const bSettled = balanceCents(b) <= 0;
    if (aSettled !== bSettled) return aSettled ? 1 : -1;
    if (aSettled) return b.issuedOn.localeCompare(a.issuedOn);
    const aOverdue = invoiceStatus(a, today) === 'overdue';
    const bOverdue = invoiceStatus(b, today) === 'overdue';
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
    return a.dueOn.localeCompare(b.dueOn);
  });
}
