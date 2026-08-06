import { operatingExpenseCents, totalExpenseCents } from '@/lib/expense-reporting';
import type { Expense } from '@/types/models';

// The profit-and-loss arithmetic, in one place.
//
// It used to live inline in reports-tab.tsx. The Dashboard now shows a P&L
// card too, and two screens each doing this subtraction is exactly how they
// end up disagreeing -- which had already happened once: the Dashboard's
// "Expenses" tile read `totalExpenseCents`, which INCLUDES stock purchases and
// owner draws, while Reports used `operatingExpenseCents`, which does not. The
// same shop, the same range, two different answers to "what did we spend".
//
// So the rule is: nothing computes net profit by hand. Both screens call this,
// and a change to how profit is defined lands in both by construction.

export type PnlInput = {
  /** Net of sales tax and refunds. */
  revenueCents: number;
  cogsCents: number;
  /** Every expense row in range, operating and not. */
  expenses: Expense[];
  /**
   * Wages earned but not yet posted by a pay run. Zero when the reader has no
   * payroll access -- see `partialLabor` below, which is how the UI says the
   * figure is incomplete rather than quietly showing a rosier profit.
   */
  accruedLaborCents?: number;
};

export type Pnl = {
  revenueCents: number;
  cogsCents: number;
  grossProfitCents: number;
  /** Operating expenses with a real row behind them. */
  postedOperatingCents: number;
  accruedLaborCents: number;
  /** What comes off gross profit: posted operating plus accrued wages. */
  operatingCents: number;
  netProfitCents: number;
  /**
   * Stock purchases and owner draws. Excluded from profit -- stock becomes a
   * cost when it sells, and an owner draw isn't a business cost -- but both
   * still leave the bank account, which is why the UI says so rather than
   * silently dropping them.
   */
  nonOperatingCents: number;
  /** Revenue less cost of goods, as a percentage. Null when there's no revenue. */
  grossMarginPct: number | null;
  /** Net profit as a percentage of revenue. Null when there's no revenue. */
  netMarginPct: number | null;
};

export function profitAndLoss({ revenueCents, cogsCents, expenses, accruedLaborCents = 0 }: PnlInput): Pnl {
  const grossProfitCents = revenueCents - cogsCents;
  const postedOperatingCents = operatingExpenseCents(expenses);
  const operatingCents = postedOperatingCents + accruedLaborCents;
  const netProfitCents = grossProfitCents - operatingCents;

  // Against the POSTED figure, not the accrual-inclusive one: `expenses` holds
  // only real rows, so subtracting accrued labour (which has no row yet) would
  // understate this and could drive it negative.
  const nonOperatingCents = totalExpenseCents(expenses) - postedOperatingCents;

  return {
    revenueCents,
    cogsCents,
    grossProfitCents,
    postedOperatingCents,
    accruedLaborCents,
    operatingCents,
    netProfitCents,
    nonOperatingCents,
    // Null rather than 0 when there's no revenue: "0% margin" on a quiet day
    // states something false about the shop, where no figure states nothing.
    grossMarginPct: revenueCents > 0 ? Math.round((grossProfitCents / revenueCents) * 100) : null,
    netMarginPct: revenueCents > 0 ? Math.round((netProfitCents / revenueCents) * 100) : null,
  };
}
