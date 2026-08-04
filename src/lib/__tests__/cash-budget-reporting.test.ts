import {
  billDueState,
  budgetRows,
  expectedChangeSinceCents,
  monthlyBillCommitmentCents,
  totalCashCents,
} from '@/lib/cash-budget-reporting';
import type { Budget, CashAccount, Expense, RecurringBill } from '@/types/models';

const TODAY = new Date(2026, 7, 15, 11, 0, 0);

function makeAccount(overrides: Partial<CashAccount> = {}): CashAccount {
  return {
    id: 'a1',
    shopId: 'shop1',
    locationId: 'loc1',
    name: 'Cash drawer',
    accountType: 'cash',
    balanceCents: 18000,
    notes: null,
    balanceAsOf: '2026-08-15T09:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-15T09:00:00.000Z',
    ...overrides,
  };
}

function makeBill(overrides: Partial<RecurringBill> = {}): RecurringBill {
  return {
    id: 'b1',
    shopId: 'shop1',
    locationId: null,
    name: 'Wadaadiid Mall rent',
    category: 'rent',
    frequency: 'monthly',
    amountCents: 40000,
    paymentMethod: 'cash',
    nextDueDate: '2026-08-20',
    vendorId: null,
    active: true,
    notes: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'e1',
    shopId: 'shop1',
    locationId: null,
    occurredOn: '2026-08-10',
    amountCents: 10000,
    category: 'rent',
    vendorId: null,
    vendorName: null,
    paymentMethod: 'cash',
    note: null,
    invoiceId: null,
    payrollRunId: null,
    createdBy: null,
    createdAt: '2026-08-10T10:00:00.000Z',
    updatedAt: '2026-08-10T10:00:00.000Z',
    ...overrides,
  };
}

function makeBudget(category: Budget['category'], limitCents: number): Budget {
  return {
    id: `budget-${category}`,
    shopId: 'shop1',
    locationId: null,
    category,
    limitCents,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

describe('totalCashCents', () => {
  it('adds every account up', () => {
    expect(totalCashCents([makeAccount({ balanceCents: 18000 }), makeAccount({ id: 'a2', balanceCents: 124000 })])).toBe(142000);
  });

  // An overdrawn bank account is a real situation; refusing to represent it
  // would just push someone to type a wrong number.
  it('handles a negative balance', () => {
    expect(totalCashCents([makeAccount({ balanceCents: 5000 }), makeAccount({ id: 'a2', balanceCents: -2000 })])).toBe(3000);
  });

  it('is zero with no accounts', () => {
    expect(totalCashCents([])).toBe(0);
  });
});

describe('billDueState', () => {
  it('is overdue once the due date has passed', () => {
    expect(billDueState(makeBill({ nextDueDate: '2026-08-14' }), TODAY)).toBe('overdue');
  });

  // You have the whole due day to pay it.
  it('is not overdue on the due date itself', () => {
    expect(billDueState(makeBill({ nextDueDate: '2026-08-15' }), TODAY)).toBe('due-soon');
  });

  it('flags bills inside the next week', () => {
    expect(billDueState(makeBill({ nextDueDate: '2026-08-20' }), TODAY)).toBe('due-soon');
  });

  it('leaves further-off bills as upcoming', () => {
    expect(billDueState(makeBill({ nextDueDate: '2026-09-20' }), TODAY)).toBe('upcoming');
  });
});

describe('monthlyBillCommitmentCents', () => {
  it('passes a monthly bill through unchanged', () => {
    expect(monthlyBillCommitmentCents([makeBill({ frequency: 'monthly', amountCents: 40000 })])).toBe(40000);
  });

  // Normalised so a weekly and a yearly commitment are comparable — 52 weeks
  // over 12 months, not a flat ×4.
  it('normalises other frequencies to a month', () => {
    expect(monthlyBillCommitmentCents([makeBill({ frequency: 'weekly', amountCents: 1200 })])).toBe(5200);
    expect(monthlyBillCommitmentCents([makeBill({ frequency: 'biweekly', amountCents: 1200 })])).toBe(2600);
    expect(monthlyBillCommitmentCents([makeBill({ frequency: 'quarterly', amountCents: 30000 })])).toBe(10000);
    expect(monthlyBillCommitmentCents([makeBill({ frequency: 'yearly', amountCents: 120000 })])).toBe(10000);
  });

  it('ignores inactive bills', () => {
    expect(monthlyBillCommitmentCents([makeBill({ active: false })])).toBe(0);
  });
});

describe('expectedChangeSinceCents', () => {
  const confirmedAt = '2026-08-10T00:00:00.000Z';

  // Negative: spending takes money *out*, so the hint reads as a reduction.
  it('reports cash spending since the balance was confirmed as negative', () => {
    const expenses = [makeExpense({ createdAt: '2026-08-11T10:00:00.000Z', amountCents: 4000, paymentMethod: 'cash' })];
    expect(expectedChangeSinceCents(expenses, confirmedAt)).toBe(-4000);
  });

  it('ignores spending from before the balance was confirmed', () => {
    const expenses = [makeExpense({ createdAt: '2026-08-01T10:00:00.000Z', amountCents: 4000, paymentMethod: 'cash' })];
    expect(expectedChangeSinceCents(expenses, confirmedAt)).toBe(0);
  });

  // A Zaad or card payment never touched the drawer, so it can't explain a
  // discrepancy in it.
  it('ignores spending that did not come out of cash', () => {
    const expenses = [makeExpense({ createdAt: '2026-08-11T10:00:00.000Z', amountCents: 4000, paymentMethod: 'zaad' })];
    expect(expectedChangeSinceCents(expenses, confirmedAt)).toBe(0);
  });

  it('is zero when nothing has been spent', () => {
    expect(expectedChangeSinceCents([], confirmedAt)).toBe(0);
  });
});

describe('budgetRows', () => {
  it('measures spend against the limit', () => {
    const rows = budgetRows([makeExpense({ category: 'rent', amountCents: 40000 })], [makeBudget('rent', 50000)]);
    expect(rows).toEqual([{ category: 'rent', spentCents: 40000, limitCents: 50000, pctUsed: 80, overBy: 0 }]);
  });

  it('reports how far over a category has gone', () => {
    const rows = budgetRows([makeExpense({ category: 'marketing', amountCents: 18000 })], [makeBudget('marketing', 15000)]);
    expect(rows[0]).toMatchObject({ pctUsed: 120, overBy: 3000 });
  });

  // An unset budget isn't a budget of zero — showing 0% used would imply a
  // limit that was never agreed.
  it('leaves pctUsed null when no budget is set', () => {
    const rows = budgetRows([makeExpense({ category: 'supplies', amountCents: 5000 })], []);
    expect(rows[0]).toMatchObject({ category: 'supplies', spentCents: 5000, limitCents: null, pctUsed: null });
  });

  // A zero limit would otherwise divide to Infinity and render a nonsense bar.
  it('does not divide by a zero limit', () => {
    const rows = budgetRows([makeExpense({ category: 'other', amountCents: 5000 })], [makeBudget('other', 0)]);
    expect(rows[0].pctUsed).toBeNull();
    expect(rows[0].overBy).toBe(5000);
  });

  it('includes a budgeted category with no spending yet', () => {
    const rows = budgetRows([], [makeBudget('utilities', 6000)]);
    expect(rows[0]).toMatchObject({ category: 'utilities', spentCents: 0, limitCents: 6000, pctUsed: 0 });
  });

  it('omits categories with neither spend nor budget', () => {
    expect(budgetRows([], [])).toEqual([]);
  });

  it('returns catalog order so rows do not jump about between periods', () => {
    const rows = budgetRows(
      [makeExpense({ id: 'x', category: 'other' }), makeExpense({ id: 'y', category: 'inventory_purchase' })],
      []
    );
    expect(rows.map((r) => r.category)).toEqual(['inventory_purchase', 'other']);
  });
});
