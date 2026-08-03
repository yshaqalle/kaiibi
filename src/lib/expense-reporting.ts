import { isDateColumnInRange } from '@/lib/period';
import type { Expense, ExpenseCategory } from '@/types/models';

// The expense category catalog and the pure roll-ups built on it.
//
// Deliberately separate from `expenses.ts`: that module imports the Supabase
// client, which pulls in AsyncStorage and can't load outside a native runtime,
// so anything importing it is untestable under Jest. Keeping the arithmetic
// here -- as pure functions over already-fetched rows -- means the numbers that
// feed the P&L can be unit-tested with no mocking, matching how cart.ts and
// tax.ts sit alongside sales.ts.

export const EXPENSE_CATEGORIES: { key: ExpenseCategory; label: string }[] = [
  { key: 'inventory_purchase', label: 'Inventory restock' },
  { key: 'rent', label: 'Rent' },
  { key: 'utilities', label: 'Utilities' },
  { key: 'salaries_wages', label: 'Salaries and wages' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'supplies', label: 'Supplies' },
  { key: 'transport_delivery', label: 'Transport and delivery' },
  { key: 'maintenance_repairs', label: 'Maintenance and repairs' },
  { key: 'fees_charges', label: 'Fees and charges' },
  { key: 'owner_draw', label: "Owner's draw" },
  { key: 'other', label: 'Other' },
];

const CATEGORY_LABELS = new Map(EXPENSE_CATEGORIES.map((c) => [c.key, c.label]));

export function expenseCategoryLabel(category: ExpenseCategory): string {
  return CATEGORY_LABELS.get(category) ?? category;
}

// Neither is an operating expense, for different reasons (see the expenses
// migration): stock becomes COGS when it sells, and an owner's draw is equity,
// not a cost of trading. Both are still real cash going out, so they belong in
// the expense list and in any cash view -- just not in the operating subtotal
// that feeds Net profit.
export const NON_OPERATING_CATEGORIES: ExpenseCategory[] = ['inventory_purchase', 'owner_draw'];

export function isOperatingExpense(category: ExpenseCategory): boolean {
  return !NON_OPERATING_CATEGORIES.includes(category);
}

export function totalExpenseCents(expenses: Expense[]): number {
  return expenses.reduce((sum, e) => sum + e.amountCents, 0);
}

// What actually hits Operating expenses on the P&L.
export function operatingExpenseCents(expenses: Expense[]): number {
  return expenses.filter((e) => isOperatingExpense(e.category)).reduce((sum, e) => sum + e.amountCents, 0);
}

export function expenseTotalsByCategory(expenses: Expense[]): { category: ExpenseCategory; totalCents: number }[] {
  const totals = new Map<ExpenseCategory, number>();
  for (const expense of expenses) {
    totals.set(expense.category, (totals.get(expense.category) ?? 0) + expense.amountCents);
  }
  // Catalog order rather than insertion or magnitude order, so a category
  // doesn't jump around between periods.
  return EXPENSE_CATEGORIES.filter((c) => totals.has(c.key)).map((c) => ({ category: c.key, totalCents: totals.get(c.key)! }));
}

// For callers holding a wider set of rows than the window they're reporting on
// (the budgets view compares a month against a screen-level range).
export function filterExpensesToRange(expenses: Expense[], since: Date, until?: Date): Expense[] {
  return expenses.filter((e) => isDateColumnInRange(e.occurredOn, since, until));
}
