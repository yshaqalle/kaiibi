import { EXPENSE_CATEGORIES } from '@/lib/expense-reporting';
import { fromDateColumn, startOfDay } from '@/lib/period';
import type { Budget, CashAccount, Expense, ExpenseCategory, RecurringBill } from '@/types/models';

// Pure arithmetic for the planning surfaces, kept out of cash-budgets.ts so it
// stays testable without the Supabase client.

export function totalCashCents(accounts: CashAccount[]): number {
  return accounts.reduce((sum, a) => sum + a.balanceCents, 0);
}

export const CASH_ACCOUNT_TYPE_LABELS: Record<CashAccount['accountType'], string> = {
  cash: 'Cash',
  bank: 'Bank',
  mobile_money: 'Mobile money',
  other: 'Other',
};

export const BILL_FREQUENCY_LABELS: Record<RecurringBill['frequency'], string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
};

export type BillDueState = 'overdue' | 'due-soon' | 'upcoming';

// Due "on" a day means it isn't late until that day has passed — same rule as
// vendor bills, so the two surfaces don't disagree about what "overdue" means.
export function billDueState(bill: RecurringBill, today: Date = new Date(), soonWithinDays = 7): BillDueState {
  const due = fromDateColumn(bill.nextDueDate).getTime();
  const start = startOfDay(today).getTime();
  if (due < start) return 'overdue';
  if (due <= start + soonWithinDays * 86_400_000) return 'due-soon';
  return 'upcoming';
}

// What the active bills will cost over one month, normalised so a weekly and a
// yearly commitment can be compared. An approximation by design — it answers
// "roughly what do I owe every month", not "what will leave the account in
// March".
export function monthlyBillCommitmentCents(bills: RecurringBill[]): number {
  return bills
    .filter((b) => b.active)
    .reduce((sum, bill) => {
      switch (bill.frequency) {
        case 'weekly':
          return sum + Math.round((bill.amountCents * 52) / 12);
        case 'biweekly':
          return sum + Math.round((bill.amountCents * 26) / 12);
        case 'monthly':
          return sum + bill.amountCents;
        case 'quarterly':
          return sum + Math.round(bill.amountCents / 3);
        case 'yearly':
          return sum + Math.round(bill.amountCents / 12);
      }
    }, 0);
}

export type BudgetRow = {
  category: ExpenseCategory;
  spentCents: number;
  limitCents: number | null;
  // Null when there's no budget to measure against, rather than 0 — an unset
  // budget isn't the same as a budget of nothing.
  pctUsed: number | null;
  overBy: number;
};

// One row per category that either has a budget or saw spending, so the list
// doesn't show eleven untouched categories to a shop that uses three.
export function budgetRows(expenses: Expense[], budgets: Budget[]): BudgetRow[] {
  const spentByCategory = new Map<ExpenseCategory, number>();
  for (const expense of expenses) {
    spentByCategory.set(expense.category, (spentByCategory.get(expense.category) ?? 0) + expense.amountCents);
  }
  const limitByCategory = new Map(budgets.map((b) => [b.category, b.limitCents]));

  return EXPENSE_CATEGORIES.filter((c) => spentByCategory.has(c.key) || limitByCategory.has(c.key)).map((c) => {
    const spentCents = spentByCategory.get(c.key) ?? 0;
    const limitCents = limitByCategory.get(c.key) ?? null;
    return {
      category: c.key,
      spentCents,
      limitCents,
      // Guard the divide: a zero limit would otherwise produce Infinity and
      // render a bar of nonsense width.
      pctUsed: limitCents !== null && limitCents > 0 ? Math.round((spentCents / limitCents) * 100) : null,
      overBy: limitCents !== null ? Math.max(0, spentCents - limitCents) : 0,
    };
  });
}

// Cash movement since each balance was last confirmed, so a mismatch between
// the counted figure and what the books imply is at least visible. Advisory
// only -- it never rewrites the balance, because the counted number is the one
// the owner actually trusts.
export function expectedChangeSinceCents(expenses: Expense[], since: string): number {
  const from = new Date(since).getTime();
  const spent = expenses
    .filter((e) => new Date(e.createdAt).getTime() >= from)
    .filter((e) => e.paymentMethod === 'cash')
    .reduce((sum, e) => sum + e.amountCents, 0);
  // `0 - spent` rather than `-spent`: negating zero yields -0, which is equal
  // to 0 under `===` but not under Object.is, and reads oddly anywhere the
  // value is inspected directly.
  return 0 - spent;
}
