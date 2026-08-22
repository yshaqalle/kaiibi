import { subtypeLabel } from '@/lib/chart-of-accounts';
import { balancesForSubtypes, sumBalances, type AccountBalance } from '@/lib/trial-balance';
import type { LedgerAccountSubtype } from '@/types/models';

// The three statements: income, balance sheet, cash flow.
//
// All pure, all built on `AccountBalance[]` from trial-balance.ts, so a
// statement is a rearrangement of figures that have already been reconciled
// rather than a fresh set of sums that can disagree with them. That is the
// point of routing everything through the chart: the P&L on the Reports tab
// and the income statement here CANNOT differ, because there is one set of
// balances underneath both.

export type StatementLine = {
  key: string;
  label: string;
  amountCents: number;
  /** An account's own code, where the line is one account. */
  code?: string;
  /** Prints as a deduction from its group — accumulated depreciation, owner's draw. */
  contra?: boolean;
};

export type StatementSection = {
  key: string;
  title: string;
  lines: StatementLine[];
  totalLabel: string;
  totalCents: number;
};

function sectionFrom(
  key: string,
  title: string,
  totalLabel: string,
  balances: AccountBalance[],
  subtypes: LedgerAccountSubtype[]
): StatementSection {
  const rows = balancesForSubtypes(balances, subtypes);
  return {
    key,
    title,
    lines: rows.map((row) => ({
      key: row.account.id,
      label: row.account.name,
      code: row.account.code,
      contra: row.account.contra,
      // Printed as the deduction it is. Storing the sign here rather than
      // leaving the renderer to work it out from `contra` means the section
      // total and the lines above it always agree — a contra line shown
      // positive under a total that subtracted it is the single most confusing
      // thing a statement can do.
      amountCents: row.account.contra ? -row.balanceCents : row.balanceCents,
    })),
    totalLabel,
    totalCents: sumBalances(rows),
  };
}

// ---------------------------------------------------------------------------
// Income statement
// ---------------------------------------------------------------------------

export type IncomeStatement = {
  revenue: StatementSection;
  costOfSales: StatementSection;
  grossProfitCents: number;
  operatingExpenses: StatementSection;
  operatingProfitCents: number;
  otherIncome: StatementSection;
  otherExpenses: StatementSection;
  netProfitCents: number;
  /** Gross profit over revenue. Null with no revenue — "0%" states something false. */
  grossMarginPct: number | null;
  netMarginPct: number | null;
};

/**
 * Profit for a WINDOW. `balances` must have been built from period feed
 * figures, not cumulative ones — see `trialBalance` for why the two are
 * different reports and must not be mixed.
 *
 * "Income statement" and "Profit and loss statement" are the same document
 * under two names, and both names appear in the app because both are what a
 * reader looked for. This is the one that computes it.
 */
export function incomeStatement(balances: AccountBalance[]): IncomeStatement {
  const revenue = sectionFrom('revenue', 'Revenue', 'Total revenue', balances, ['operating_income']);
  const costOfSales = sectionFrom('cogs', 'Cost of sales', 'Total cost of sales', balances, ['cost_of_sales']);
  const operatingExpenses = sectionFrom('opex', 'Operating expenses', 'Total operating expenses', balances, ['operating_expense']);
  const otherIncome = sectionFrom('other_income', 'Other income', 'Total other income', balances, ['other_income']);
  const otherExpenses = sectionFrom('other_expense', 'Other expenses', 'Total other expenses', balances, ['other_expense']);

  const grossProfitCents = revenue.totalCents - costOfSales.totalCents;
  const operatingProfitCents = grossProfitCents - operatingExpenses.totalCents;
  const netProfitCents = operatingProfitCents + otherIncome.totalCents - otherExpenses.totalCents;

  return {
    revenue,
    costOfSales,
    grossProfitCents,
    operatingExpenses,
    operatingProfitCents,
    otherIncome,
    otherExpenses,
    netProfitCents,
    grossMarginPct: revenue.totalCents > 0 ? Math.round((grossProfitCents / revenue.totalCents) * 100) : null,
    netMarginPct: revenue.totalCents > 0 ? Math.round((netProfitCents / revenue.totalCents) * 100) : null,
  };
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------

export type BalanceSheet = {
  currentAssets: StatementSection;
  fixedAssets: StatementSection;
  otherAssets: StatementSection;
  totalAssetsCents: number;
  currentLiabilities: StatementSection;
  longTermLiabilities: StatementSection;
  totalLiabilitiesCents: number;
  /** Accounts the shop has posted to: capital put in, owner's draw taken out. */
  postedEquity: StatementSection;
  /**
   * Profit earned in the reporting period — derived, never posted.
   *
   * A conventional set of books closes income and expenses into this account
   * at each year end. Nothing here runs a year-end routine, because a shop
   * that skipped one would find its balance sheet quietly wrong ever after.
   * The period's profit is computed instead, and anything kept from before it
   * is an opening balance on the `Retained earnings` account.
   */
  retainedEarningsCents: number;
  totalEquityCents: number;
  /**
   * Assets less liabilities and equity. Zero is a balance sheet that balances.
   *
   * Shown rather than absorbed. The gap is real -- it is almost always an
   * opening balance nobody has stated yet -- and folding it silently into
   * equity would produce a sheet that always balanced and never told the truth
   * about why.
   */
  differenceCents: number;
  balanced: boolean;
};

/**
 * The balance sheet as it stands.
 *
 * The asset and liability lines are today's facts whatever range is selected
 * (see ledger-feeds.ts for why they cannot be anything else), so the screen
 * labels them "as of today" rather than borrowing the range's dates.
 *
 * Retained earnings is the one line whose window matters, and it works the way
 * a real set of books does: the period's profit, on top of whatever the shop
 * entered as the opening balance of its `Retained earnings` account. A
 * business that has kept books elsewhere types that figure in once; one
 * starting here leaves it at zero and it is right by construction.
 */
export function balanceSheet(balances: AccountBalance[]): BalanceSheet {
  const currentAssets = sectionFrom('current_assets', subtypeLabel('current_asset'), 'Total current assets', balances, ['current_asset']);
  const fixedAssets = sectionFrom('fixed_assets', subtypeLabel('fixed_asset'), 'Total fixed assets', balances, ['fixed_asset']);
  const otherAssets = sectionFrom('other_assets', subtypeLabel('other_asset'), 'Total other assets', balances, ['other_asset']);
  const currentLiabilities = sectionFrom('current_liabilities', subtypeLabel('current_liability'), 'Total current liabilities', balances, ['current_liability']);
  const longTermLiabilities = sectionFrom('long_term_liabilities', subtypeLabel('long_term_liability'), 'Total long-term liabilities', balances, ['long_term_liability']);
  const postedEquity = sectionFrom('equity', 'Capital', 'Total capital', balances, ['equity']);

  const totalAssetsCents = currentAssets.totalCents + fixedAssets.totalCents + otherAssets.totalCents;
  const totalLiabilitiesCents = currentLiabilities.totalCents + longTermLiabilities.totalCents;

  // The period's profit, from the same balances. Built by calling the income
  // statement rather than by summing income and expense accounts again here,
  // so the two reports cannot drift apart. Profit kept from BEFORE the period
  // arrives through the posted equity section, as an opening balance somebody
  // typed.
  const retainedEarningsCents = incomeStatement(balances).netProfitCents;
  const totalEquityCents = postedEquity.totalCents + retainedEarningsCents;
  const differenceCents = totalAssetsCents - totalLiabilitiesCents - totalEquityCents;

  return {
    currentAssets,
    fixedAssets,
    otherAssets,
    totalAssetsCents,
    currentLiabilities,
    longTermLiabilities,
    totalLiabilitiesCents,
    postedEquity,
    retainedEarningsCents,
    totalEquityCents,
    differenceCents,
    balanced: differenceCents === 0,
  };
}

// ---------------------------------------------------------------------------
// Cash flow
// ---------------------------------------------------------------------------

/**
 * The movements a cash-flow statement is built from — every one of them a
 * figure the app records with a date on it.
 *
 * Direct method, not indirect. The indirect method starts at net profit and
 * adjusts it by the period's change in receivables, inventory and payables,
 * and this app cannot honestly compute those: `cash_accounts` holds a current
 * balance with no history, so there is no "receivables at the start of July"
 * to subtract from. Reconstructing one would mean inventing it.
 *
 * The direct method needs no history at all. Every figure below is a sum over
 * rows that carry the date they happened on, so each is either right or
 * missing, never guessed.
 */
export type CashMovements = {
  /** Every payment taken in the period — at the till and against old debts alike. */
  collectedFromCustomersCents: number;
  /** Money handed back with refunds in the period. */
  refundedToCustomersCents: number;
  /** Payments recorded against vendor bills in the period. */
  paidOnBillsCents: number;
  /**
   * Expenses paid as they were logged: everything with no bill and no pay run
   * behind it. Bill- and payroll-generated expense rows are excluded because
   * their cash goes out through the two streams either side of this one, and
   * counting the expense as well would double it.
   */
  paidDirectlyCents: number;
  /** Pay runs posted in the period. */
  paidToStaffCents: number;
  /** Owner's draw logged in the period. Financing, not a cost of trading. */
  ownerDrawCents: number;
  /** Assets acquired in the period, at cost. */
  assetsPurchasedCents: number;
  /** What assets disposed of in the period fetched. */
  assetProceedsCents: number;
  /** What the tills, banks and wallets hold right now. Not a period figure. */
  cashHeldNowCents: number;
};

export type CashFlowStatement = {
  operating: StatementSection;
  investing: StatementSection;
  financing: StatementSection;
  /** Operating plus investing plus financing: how much more (or less) cash the shop has. */
  netMovementCents: number;
  /** What is in the tills and accounts right now — a fact about today, not the window. */
  cashHeldNowCents: number;
};

/**
 * Cash in and out for a window.
 *
 * Money BETWEEN the shop's own accounts is absent by construction, and that is
 * correct: banking the day's takings moves cash from one pot to another and
 * changes nothing about how much the business has. See
 * supabase/migrations/20260902000400_cash_transfers.sql.
 */
export function cashFlowStatement(movements: CashMovements): CashFlowStatement {
  const operatingLines: StatementLine[] = [
    { key: 'collected', label: 'Collected from customers', amountCents: movements.collectedFromCustomersCents },
    { key: 'refunded', label: 'Refunds paid out', amountCents: -movements.refundedToCustomersCents },
    { key: 'bills', label: 'Paid on vendor bills', amountCents: -movements.paidOnBillsCents },
    { key: 'direct', label: 'Paid directly (expenses and stock)', amountCents: -movements.paidDirectlyCents },
    { key: 'staff', label: 'Paid to staff', amountCents: -movements.paidToStaffCents },
  ].filter((line) => line.amountCents !== 0);

  const investingLines: StatementLine[] = [
    { key: 'assets_bought', label: 'Assets bought', amountCents: -movements.assetsPurchasedCents },
    { key: 'assets_sold', label: 'Assets sold', amountCents: movements.assetProceedsCents },
  ].filter((line) => line.amountCents !== 0);

  const financingLines: StatementLine[] = [
    { key: 'draw', label: "Owner's draw", amountCents: -movements.ownerDrawCents },
  ].filter((line) => line.amountCents !== 0);

  const total = (lines: StatementLine[]) => lines.reduce((sum, line) => sum + line.amountCents, 0);

  const operating: StatementSection = {
    key: 'operating',
    title: 'Operating',
    lines: operatingLines,
    totalLabel: 'Cash from trading',
    totalCents: total(operatingLines),
  };
  const investing: StatementSection = {
    key: 'investing',
    title: 'Investing',
    lines: investingLines,
    totalLabel: 'Cash from investing',
    totalCents: total(investingLines),
  };
  const financing: StatementSection = {
    key: 'financing',
    title: 'Financing',
    lines: financingLines,
    totalLabel: 'Cash from financing',
    totalCents: total(financingLines),
  };

  return {
    operating,
    investing,
    financing,
    netMovementCents: operating.totalCents + investing.totalCents + financing.totalCents,
    cashHeldNowCents: movements.cashHeldNowCents,
  };
}
