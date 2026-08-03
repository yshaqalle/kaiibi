import {
  expenseTotalsByCategory,
  filterExpensesToRange,
  isOperatingExpense,
  operatingExpenseCents,
  totalExpenseCents,
} from '@/lib/expense-reporting';
import type { Expense, ExpenseCategory } from '@/types/models';

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'e1',
    shopId: 's1',
    occurredOn: '2026-08-02',
    amountCents: 1000,
    category: 'rent',
    vendorId: null,
    vendorName: null,
    paymentMethod: 'cash',
    note: null,
    invoiceId: null,
    createdBy: null,
    createdAt: '2026-08-02T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z',
    ...overrides,
  };
}

describe('isOperatingExpense', () => {
  // Stock is an asset until it sells (it becomes COGS then), and an owner's
  // draw is equity, not a cost of trading -- counting either as an operating
  // expense would understate profit and, for stock, double-count against COGS.
  it.each<ExpenseCategory>(['inventory_purchase', 'owner_draw'])('excludes %s', (category) => {
    expect(isOperatingExpense(category)).toBe(false);
  });

  it.each<ExpenseCategory>(['rent', 'utilities', 'salaries_wages', 'marketing', 'other'])('includes %s', (category) => {
    expect(isOperatingExpense(category)).toBe(true);
  });
});

describe('totals', () => {
  const expenses = [
    makeExpense({ id: 'a', category: 'rent', amountCents: 40000 }),
    makeExpense({ id: 'b', category: 'marketing', amountCents: 12000 }),
    makeExpense({ id: 'c', category: 'inventory_purchase', amountCents: 145000 }),
    makeExpense({ id: 'd', category: 'owner_draw', amountCents: 20000 }),
  ];

  it('counts every category toward the cash total', () => {
    expect(totalExpenseCents(expenses)).toBe(217000);
  });

  it('counts only operating categories toward the P&L subtotal', () => {
    expect(operatingExpenseCents(expenses)).toBe(52000);
  });

  it('returns zero for an empty list rather than NaN', () => {
    expect(totalExpenseCents([])).toBe(0);
    expect(operatingExpenseCents([])).toBe(0);
  });
});

describe('expenseTotalsByCategory', () => {
  it('sums each category', () => {
    const totals = expenseTotalsByCategory([
      makeExpense({ id: 'a', category: 'rent', amountCents: 40000 }),
      makeExpense({ id: 'b', category: 'rent', amountCents: 5000 }),
      makeExpense({ id: 'c', category: 'marketing', amountCents: 12000 }),
    ]);
    expect(totals).toEqual([
      { category: 'rent', totalCents: 45000 },
      { category: 'marketing', totalCents: 12000 },
    ]);
  });

  // Catalog order, not magnitude or insertion order, so a category doesn't
  // move around the report between periods.
  it('returns catalog order regardless of input order', () => {
    const totals = expenseTotalsByCategory([
      makeExpense({ id: 'a', category: 'other', amountCents: 100 }),
      makeExpense({ id: 'b', category: 'inventory_purchase', amountCents: 100 }),
      makeExpense({ id: 'c', category: 'rent', amountCents: 100 }),
    ]);
    expect(totals.map((t) => t.category)).toEqual(['inventory_purchase', 'rent', 'other']);
  });

  it('omits categories with no expenses', () => {
    const totals = expenseTotalsByCategory([makeExpense({ category: 'rent' })]);
    expect(totals).toHaveLength(1);
  });
});

describe('filterExpensesToRange', () => {
  const expenses = [
    makeExpense({ id: 'jul', occurredOn: '2026-07-31' }),
    makeExpense({ id: 'aug1', occurredOn: '2026-08-01' }),
    makeExpense({ id: 'aug31', occurredOn: '2026-08-31' }),
    makeExpense({ id: 'sep', occurredOn: '2026-09-01' }),
  ];

  it('includes both boundary days whatever time the range carries', () => {
    const kept = filterExpensesToRange(expenses, new Date(2026, 7, 1, 14, 0, 0), new Date(2026, 7, 31, 9, 0, 0));
    expect(kept.map((e) => e.id)).toEqual(['aug1', 'aug31']);
  });

  it('treats an omitted end as open-ended', () => {
    const kept = filterExpensesToRange(expenses, new Date(2026, 7, 1));
    expect(kept.map((e) => e.id)).toEqual(['aug1', 'aug31', 'sep']);
  });
});
