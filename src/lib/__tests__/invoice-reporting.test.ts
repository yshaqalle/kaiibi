import { balanceCents, invoiceStatus, invoiceTotals, sortInvoicesForDisplay } from '@/lib/invoice-reporting';
import type { Invoice } from '@/types/models';

const TODAY = new Date(2026, 7, 15, 11, 30, 0);

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv1',
    shopId: 'shop1',
    vendorId: 'v1',
    vendorName: 'Nairobi Beauty Distributors',
    vendorPhone: null,
    invoiceNumber: 'BILL-2201',
    category: 'inventory_purchase',
    description: null,
    issuedOn: '2026-08-01',
    dueOn: '2026-08-20',
    amountCents: 40000,
    paidCents: 0,
    createdBy: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    payments: [],
    ...overrides,
  };
}

describe('invoiceStatus', () => {
  it('is open when nothing is paid and the due date is ahead', () => {
    expect(invoiceStatus(makeInvoice(), TODAY)).toBe('open');
  });

  it('is partial once something is paid but a balance remains', () => {
    expect(invoiceStatus(makeInvoice({ paidCents: 12000 }), TODAY)).toBe('partial');
  });

  it('is paid when the balance is cleared', () => {
    expect(invoiceStatus(makeInvoice({ paidCents: 40000 }), TODAY)).toBe('paid');
  });

  it('is overdue when unpaid past the due date', () => {
    expect(invoiceStatus(makeInvoice({ dueOn: '2026-08-14' }), TODAY)).toBe('overdue');
  });

  // Due "on" a date means you have that whole day to pay it -- marking it late
  // at 00:01 on the due date would be wrong every single time.
  it('is not overdue on the due date itself', () => {
    expect(invoiceStatus(makeInvoice({ dueOn: '2026-08-15' }), TODAY)).toBe('open');
  });

  // Settled wins over late: a bill paid after its due date is done, not a
  // standing problem.
  it('reports a fully paid bill as paid even when the due date has passed', () => {
    expect(invoiceStatus(makeInvoice({ dueOn: '2026-07-01', paidCents: 40000 }), TODAY)).toBe('paid');
  });

  it('reports a part-paid overdue bill as overdue', () => {
    expect(invoiceStatus(makeInvoice({ dueOn: '2026-07-01', paidCents: 10000 }), TODAY)).toBe('overdue');
  });
});

describe('balanceCents', () => {
  it('is what is still owed', () => {
    expect(balanceCents(makeInvoice({ amountCents: 40000, paidCents: 15000 }))).toBe(25000);
  });
});

describe('invoiceTotals', () => {
  const invoices = [
    makeInvoice({ id: 'a', amountCents: 40000, paidCents: 12000, dueOn: '2026-08-20' }),
    makeInvoice({ id: 'b', amountCents: 12000, paidCents: 0, dueOn: '2026-07-24' }),
    makeInvoice({ id: 'c', amountCents: 20000, paidCents: 20000, dueOn: '2026-08-13' }),
  ];

  it('counts only what is still owed', () => {
    const totals = invoiceTotals(invoices, TODAY);
    expect(totals.outstandingCents).toBe(28000 + 12000);
    expect(totals.openCount).toBe(2);
  });

  it('counts only the overdue portion as overdue', () => {
    expect(invoiceTotals(invoices, TODAY).overdueCents).toBe(12000);
  });

  it('excludes settled bills entirely', () => {
    const totals = invoiceTotals([makeInvoice({ paidCents: 40000 })], TODAY);
    expect(totals).toEqual({ outstandingCents: 0, overdueCents: 0, openCount: 0 });
  });

  it('reports zeroes for a shop with no bills', () => {
    expect(invoiceTotals([], TODAY)).toEqual({ outstandingCents: 0, overdueCents: 0, openCount: 0 });
  });
});

describe('sortInvoicesForDisplay', () => {
  it('puts overdue first, then upcoming by due date, then settled', () => {
    const paid = makeInvoice({ id: 'paid', paidCents: 40000, dueOn: '2026-08-02' });
    const soon = makeInvoice({ id: 'soon', dueOn: '2026-08-18' });
    const later = makeInvoice({ id: 'later', dueOn: '2026-08-28' });
    const overdue = makeInvoice({ id: 'overdue', dueOn: '2026-07-30' });

    const sorted = sortInvoicesForDisplay([paid, later, overdue, soon], TODAY);
    expect(sorted.map((i) => i.id)).toEqual(['overdue', 'soon', 'later', 'paid']);
  });

  it('does not mutate the input', () => {
    const invoices = [makeInvoice({ id: 'a', dueOn: '2026-08-28' }), makeInvoice({ id: 'b', dueOn: '2026-07-01' })];
    sortInvoicesForDisplay(invoices, TODAY);
    expect(invoices.map((i) => i.id)).toEqual(['a', 'b']);
  });
});
