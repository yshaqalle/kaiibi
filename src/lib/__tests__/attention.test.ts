import { attentionCounts, buildAttentionItems, type AttentionInput } from '@/lib/attention';
import type { Customer, Invoice, Product, RecurringBill, RegisterSession, TimeEntry, TimeOffRequest } from '@/types/models';

const TODAY = new Date('2026-08-04T12:00:00Z');

function emptyInput(): AttentionInput {
  return {
    openInvoices: [],
    recurringBills: [],
    budgetRows: [],
    pendingTimeOff: [],
    staleShifts: [],
    onLeave: [],
    lowStock: [],
    expiringSoon: [],
    dormant: [],
    closedSessions: [],
    today: TODAY,
  };
}

function closedSession(over: { varianceBaseCents: number | null; closingNote?: string | null }) {
  const session: RegisterSession = {
    id: `sess-${over.varianceBaseCents}`,
    shopId: 'shop',
    locationId: 'loc',
    registerId: 'reg-1',
    shopMemberId: 'member-1',
    openedBy: 'user-1',
    openedAt: '2026-08-04T08:12:00Z',
    closedAt: '2026-08-04T15:00:00Z',
    closedBy: 'user-1',
    varianceBaseCents: over.varianceBaseCents,
    openingNote: null,
    closingNote: over.closingNote ?? null,
    cash: [],
  };
  return { session, registerName: 'Register 1', personName: 'Amina H.' };
}

function invoice(over: { dueOn: string; amountCents: number; paidCents?: number; vendorName?: string }): Invoice {
  return {
    id: `inv-${over.dueOn}-${over.amountCents}`,
    shopId: 'shop',
    locationId: null,
    vendorId: null,
    vendorName: over.vendorName ?? 'Kaah Wholesale',
    vendorPhone: null,
    invoiceNumber: 'INV-4471',
    category: 'inventory_purchase',
    description: null,
    issuedOn: '2026-07-01',
    dueOn: over.dueOn,
    amountCents: over.amountCents,
    paidCents: over.paidCents ?? 0,
  } as Invoice;
}

function bill(over: { nextDueDate: string; active?: boolean; name?: string }): RecurringBill {
  return {
    id: `bill-${over.nextDueDate}`,
    shopId: 'shop',
    locationId: null,
    name: over.name ?? 'Rent',
    category: 'rent',
    frequency: 'monthly',
    amountCents: 25000,
    paymentMethod: 'cash',
    nextDueDate: over.nextDueDate,
    vendorId: null,
    active: over.active ?? true,
    notes: null,
    createdAt: '',
    updatedAt: '',
  };
}

describe('buildAttentionItems — ordering', () => {
  it('puts everything actionable ahead of everything merely worth knowing', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      dormant: [{ customer: { firstName: 'Ayaan', lastName: 'H.' } as Customer, lastOrderAt: '2026-06-03' }],
      lowStock: [{ name: 'Rice' } as Product],
      pendingTimeOff: [{ id: 'r1' } as TimeOffRequest],
      openInvoices: [invoice({ dueOn: '2026-07-29', amountCents: 34000 })],
    });

    // The whole reason this function exists: a quiet customer must not sit
    // above a late bill or a request someone is waiting on.
    expect(items.map((i) => i.severity)).toEqual(['act', 'act', 'soon', 'info']);
    expect(items[items.length - 1].area).toBe('customers');
  });

  it('keeps a predictable order within a severity', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      pendingTimeOff: [{ id: 'r1' } as TimeOffRequest],
      openInvoices: [invoice({ dueOn: '2026-07-29', amountCents: 34000 })],
    });
    // Money before team, load after load — not shuffling.
    expect(items.map((i) => i.area)).toEqual(['money', 'team']);
  });
});

describe('buildAttentionItems — money', () => {
  it('flags an overdue bill and totals what is owed', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      openInvoices: [
        invoice({ dueOn: '2026-07-29', amountCents: 34000 }),
        invoice({ dueOn: '2026-07-20', amountCents: 10000, paidCents: 4000 }),
      ],
    });
    const money = items.find((i) => i.key === 'invoices-overdue')!;
    expect(money.severity).toBe('act');
    expect(money.title).toContain('2 supplier bills');
    // 34000 + (10000 - 4000) = 40000
    expect(money.detail).toContain('$400.00');
  });

  it('ignores a bill that is settled or not yet due', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      openInvoices: [
        invoice({ dueOn: '2026-07-01', amountCents: 5000, paidCents: 5000 }),
        invoice({ dueOn: '2026-09-01', amountCents: 5000 }),
      ],
    });
    expect(items.find((i) => i.key === 'invoices-overdue')).toBeUndefined();
  });

  it('names the vendor when there is only one overdue bill', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      openInvoices: [invoice({ dueOn: '2026-07-29', amountCents: 34000, vendorName: 'Berbera Distributors' })],
    });
    expect(items[0].title).toContain('Berbera Distributors');
  });

  it('surfaces a recurring bill only while it is due soon', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      recurringBills: [
        bill({ nextDueDate: '2026-08-07', name: 'Rent' }), // within the 7-day window
        bill({ nextDueDate: '2026-12-01', name: 'Licence' }), // far off
      ],
    });
    const keys = items.map((i) => i.title);
    expect(keys.some((t) => t.includes('Rent'))).toBe(true);
    expect(keys.some((t) => t.includes('Licence'))).toBe(false);
  });

  it('ignores a deactivated recurring bill', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      recurringBills: [bill({ nextDueDate: '2026-08-07', active: false })],
    });
    expect(items).toHaveLength(0);
  });

  it('escalates a budget that is over, and stays quiet below 80%', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      budgetRows: [
        { category: 'utilities', spentCents: 16000, limitCents: 15000, pctUsed: 107, overBy: 1000 },
        { category: 'marketing', spentCents: 13800, limitCents: 15000, pctUsed: 92, overBy: 0 },
        { category: 'supplies', spentCents: 6000, limitCents: 15000, pctUsed: 40, overBy: 0 },
      ],
    });
    expect(items.find((i) => i.key === 'budget-utilities')?.severity).toBe('act');
    expect(items.find((i) => i.key === 'budget-marketing')?.severity).toBe('soon');
    // 40% used is not news.
    expect(items.find((i) => i.key === 'budget-supplies')).toBeUndefined();
  });

  it('ignores a category with no budget set', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      budgetRows: [{ category: 'rent', spentCents: 90000, limitCents: null, pctUsed: null, overBy: 0 }],
    });
    // Spending without a limit is not overspending.
    expect(items).toHaveLength(0);
  });
});

describe('buildAttentionItems — team and stock', () => {
  it('explains why a stale shift matters, not just that it exists', () => {
    const items = buildAttentionItems({ ...emptyInput(), staleShifts: [{ id: 't1' } as TimeEntry] });
    expect(items[0].detail).toContain('not counted');
  });

  it('pluralises', () => {
    const one = buildAttentionItems({ ...emptyInput(), lowStock: [{ name: 'Rice' } as Product] });
    const two = buildAttentionItems({
      ...emptyInput(),
      lowStock: [{ name: 'Rice' } as Product, { name: 'Sugar' } as Product],
    });
    expect(one[0].title).toContain('1 product low');
    expect(two[0].title).toContain('2 products low');
  });

  it('names only the first few products, so one row cannot run away', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      lowStock: ['a', 'b', 'c', 'd', 'e'].map((n) => ({ name: n }) as Product),
    });
    expect(items[0].detail).toBe('a, b, c');
  });

  it('groups quiet customers into one row rather than one row each', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      dormant: ['A', 'B', 'C', 'D'].map((n) => ({
        customer: { firstName: n, lastName: 'X' } as Customer,
        lastOrderAt: '2026-06-03',
      })),
    });
    const customerRows = items.filter((i) => i.area === 'customers');
    expect(customerRows).toHaveLength(1);
    expect(customerRows[0].title).toContain('4 regular customers have gone quiet');
  });

  it('is empty when nothing needs doing', () => {
    expect(buildAttentionItems(emptyInput())).toEqual([]);
  });
});

describe('attentionCounts', () => {
  it('counts per area and in total', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      openInvoices: [invoice({ dueOn: '2026-07-29', amountCents: 34000 })],
      pendingTimeOff: [{ id: 'r1' } as TimeOffRequest],
      staleShifts: [{ id: 't1' } as TimeEntry],
      lowStock: [{ name: 'Rice' } as Product],
    });
    expect(attentionCounts(items)).toEqual({ all: 4, money: 1, team: 2, stock: 1, customers: 0 });
  });
});


describe('register sessions on the attention list', () => {
  // The whole reason this is an attention row and not a dashboard card: on a
  // day when every drawer balanced, it contributes nothing at all.
  it('says nothing when every register balanced', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      closedSessions: [closedSession({ varianceBaseCents: 0 })],
    });
    expect(items).toEqual([]);
  });

  it('raises a short drawer as something to act on today', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      closedSessions: [closedSession({ varianceBaseCents: -500, closingNote: 'wrong change at 2pm' })],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: 'act', area: 'money', action: 'Review' });
    expect(items[0].title).toBe('Register 1 closed $5.00 short');
    expect(items[0].detail).toBe('Amina H. · wrong change at 2pm');
  });

  // Over is amber, not red: the shop is not out of pocket, but a drawer that
  // misses in either direction is one nobody can vouch for.
  it('raises an over drawer as this week rather than today', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      closedSessions: [closedSession({ varianceBaseCents: 200 })],
    });
    expect(items[0]).toMatchObject({ severity: 'soon', area: 'money' });
    expect(items[0].title).toBe('Register 1 closed $2.00 over');
  });

  it('reads a never-computed variance as balanced rather than as a gap', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      closedSessions: [closedSession({ varianceBaseCents: null })],
    });
    expect(items).toEqual([]);
  });

  it('falls back to the register alone when nobody is named', () => {
    const entry = closedSession({ varianceBaseCents: -100 });
    const items = buildAttentionItems({
      ...emptyInput(),
      closedSessions: [{ ...entry, personName: '' }],
    });
    expect(items[0].detail).toBeUndefined();
  });

  // Ordering is by actionability, not by area — a short drawer outranks a
  // budget nearing its limit, and both outrank anything merely informational.
  it('sorts a short drawer above softer money items', () => {
    const items = buildAttentionItems({
      ...emptyInput(),
      closedSessions: [closedSession({ varianceBaseCents: 200 }), closedSession({ varianceBaseCents: -500 })],
    });
    expect(items.map((item) => item.severity)).toEqual(['act', 'soon']);
  });
});
