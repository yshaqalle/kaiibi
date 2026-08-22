import {
  assetRegister,
  assetRegisterTotals,
  periodDepreciationCents,
  periodDisposalResultCents,
} from '@/lib/asset-depreciation';
import { listOutstanding } from '@/lib/balances';
import { listCashAccounts } from '@/lib/cash-budgets';
import { feedForExpenseCategory } from '@/lib/chart-of-accounts';
import { listExpensesInRange } from '@/lib/expenses';
import { listFixedAssets } from '@/lib/fixed-assets';
import { listOpenInvoices } from '@/lib/invoices';
import { invoiceTotals } from '@/lib/invoice-reporting';
import { scopeToLocation } from '@/lib/location-reporting';
import { valueInventory } from '@/lib/inventory-valuation';
import { toDateColumn } from '@/lib/period';
import { listProducts } from '@/lib/products';
import { getSalesAndRefundsInRange } from '@/lib/sales';
import { costOfGoodsSold, netRevenueCents, netTaxCollectedCents } from '@/lib/sales-reporting';
import type { FeedFigures } from '@/lib/trial-balance';
import type { CashAccount, Expense, FixedAsset, Invoice, Product } from '@/types/models';

// Where every fed account's balance comes from.
//
// This is the module that makes the ledger's central claim true: the balance
// sheet does not re-record anything, it REPORTS what the shop already keeps.
// One function per stream, each built out of the same helpers the rest of
// Accounting already uses, so a figure on the balance sheet and the same figure
// on the tab it came from cannot disagree.
//
// **What "as of" means here**, because it is the one thing a reader must not
// get wrong. This produces a PERIOD-END picture:
//
//   Balance-sheet accounts -- cash, receivables, inventory, assets, payables --
//   are facts about RIGHT NOW. There is no history to draw them from: a cash
//   account holds a single confirmed balance (see 20260804000500) and stock
//   holds a single count, so "inventory on 31 March" is not a question this
//   app can answer, and inventing an answer would be worse than saying so.
//
//   Income and expense accounts are for the SELECTED PERIOD.
//
// That mix is not a compromise, it is what a period-end trial balance is: the
// standing balances as they stand, and the period's trading against them. It
// does mean the balance sheet's "as of" is today whatever range is picked, and
// the screen says so rather than leaving the reader to infer it.

export type LedgerSnapshotInput = {
  shopId: string;
  since: Date;
  /**
   * The end of the window, or undefined for "through today" — the shape
   * `DateRange` uses everywhere in Accounting. Left open rather than defaulted
   * by the caller, so an open-ended range means the same thing here as it does
   * to `listExpensesInRange`.
   */
  until?: Date;
  /** null = the combined business view, as everywhere else in Accounting. */
  locationFilter: string | null;
  /**
   * Wages earned in the period with no pay run posted yet. Zero when the
   * reader has no payroll access -- the caller decides, because it is the
   * caller that knows, and a wages line quietly missing its accrual is the
   * kind of wrong that looks right.
   */
  accruedLaborCents?: number;
};

/** Everything the statements are built from, fetched once. */
export type LedgerSnapshot = {
  feeds: FeedFigures;
  /** Kept so the screens can show the detail behind a line without refetching. */
  cashAccounts: CashAccount[];
  products: Product[];
  assets: FixedAsset[];
  openInvoices: Invoice[];
  expenses: Expense[];
  receivablesOwedCents: number;
  /** What "right now" meant when this was read — printed on the statements. */
  asOf: string;
};

// A cash account's `other` type sits with cash on hand rather than getting an
// account of its own. A shop with a safe, a float tin and a petty-cash box
// does not want three balance-sheet lines for them, and "other" was never a
// claim about where the money is -- only that it is not a bank or a wallet.
function cashByType(accounts: CashAccount[]): { cash: number; bank: number; mobile: number } {
  let cash = 0;
  let bank = 0;
  let mobile = 0;
  for (const account of accounts) {
    if (account.accountType === 'bank') bank += account.balanceCents;
    else if (account.accountType === 'mobile_money') mobile += account.balanceCents;
    else cash += account.balanceCents;
  }
  return { cash, bank, mobile };
}

/**
 * Expense totals per feed, for one period.
 *
 * `inventory_purchase` falls out here, silently and correctly: it has no feed
 * (see EXPENSE_CATEGORY_FEEDS), because the stock it bought is already on the
 * balance sheet through `inventory`. Wages get the accrual added on top, which
 * is what makes the ledger's wages line agree with the P&L's.
 */
function expenseFeeds(expenses: Expense[], accruedLaborCents: number): FeedFigures {
  const feeds: FeedFigures = {};
  for (const expense of expenses) {
    const feed = feedForExpenseCategory(expense.category);
    if (!feed) continue;
    feeds[feed] = (feeds[feed] ?? 0) + expense.amountCents;
  }
  if (accruedLaborCents > 0) {
    feeds.expense_salaries_wages = (feeds.expense_salaries_wages ?? 0) + accruedLaborCents;
  }
  return feeds;
}

/**
 * Reads every stream a fed account reports, and returns them signed in each
 * account's normal direction (see `FeedFigures`).
 *
 * One round of parallel fetches. Six sequential awaits would be six round
 * trips before the first figure appears, on a screen that is already the
 * slowest in Accounting.
 */
export async function fetchLedgerSnapshot({
  shopId,
  since,
  until,
  locationFilter,
  accruedLaborCents = 0,
}: LedgerSnapshotInput): Promise<LedgerSnapshot> {
  const [cashAccounts, receivables, products, assets, openInvoices, expenseRows, { sales, refunds }] =
    await Promise.all([
      listCashAccounts(shopId),
      listOutstanding(shopId),
      // Scoped at the source: `listProducts` counts a store's own stock when
      // given a store, which is a different (and correct) figure from
      // filtering shop-wide rows afterwards.
      listProducts(shopId, locationFilter),
      listFixedAssets(shopId),
      listOpenInvoices(shopId),
      listExpensesInRange(shopId, since, until),
      getSalesAndRefundsInRange(shopId, since, until, locationFilter),
    ]);

  const asOf = toDateColumn(new Date());
  const sinceColumn = toDateColumn(since);
  // An open-ended range runs to today. Leaving it open here instead would give
  // the depreciation and disposal windows no upper bound, so an asset sold with
  // a post-dated disposal would report its gain before it happened.
  const untilColumn = until ? toDateColumn(until) : asOf;

  // Everything not already scoped at the source. Business-wide rows drop out
  // of a per-store view rather than being apportioned -- see
  // location-reporting.ts, and note the consequence it states: per-store
  // figures do not sum to the business's.
  const scopedCash = locationFilter
    ? cashAccounts.filter((account) => account.locationId === locationFilter)
    : cashAccounts;
  const expenses = scopeToLocation(expenseRows, locationFilter);
  const scopedAssets = scopeToLocation(assets, locationFilter);
  const scopedInvoices = scopeToLocation(openInvoices, locationFilter);

  const { cash, bank, mobile } = cashByType(scopedCash);
  const registerTotals = assetRegisterTotals(assetRegister(scopedAssets, asOf));
  const receivablesOwedCents = receivables.reduce((sum, row) => sum + row.owedCents, 0);

  const feeds: FeedFigures = {
    cash_on_hand: cash,
    bank,
    mobile_money: mobile,
    // Deliberately not scoped by store: a customer owes the BUSINESS, and the
    // sale that created the debt may have been rung up anywhere. There is no
    // store dimension on `customer_balances` to filter by even if there were
    // an argument for one.
    accounts_receivable: receivablesOwedCents,
    inventory: valueInventory(products).totalAtCostCents,
    fixed_assets: registerTotals.costCents,
    accumulated_depreciation: registerTotals.accumulatedCents,
    accounts_payable: invoiceTotals(scopedInvoices).outstandingCents,
    // For the PERIOD, not all time. The app records tax collected but not tax
    // remitted, so a running total would climb forever and describe a debt no
    // shop has. What a filing needs is the period's figure, which is this.
    sales_tax_payable: netTaxCollectedCents(sales, refunds),
    sales_revenue: netRevenueCents(sales, refunds),
    cost_of_goods_sold: costOfGoodsSold(sales, refunds).cogsCents,
    asset_disposal_result: periodDisposalResultCents(scopedAssets, sinceColumn, untilColumn),
    expense_depreciation: periodDepreciationCents(scopedAssets, sinceColumn, untilColumn),
    ...expenseFeeds(expenses, accruedLaborCents),
  };

  return {
    feeds,
    cashAccounts: scopedCash,
    products,
    assets: scopedAssets,
    openInvoices: scopedInvoices,
    expenses,
    receivablesOwedCents,
    asOf,
  };
}

/** What the tills, banks and wallets hold — the cash-flow statement's closing figure. */
export function cashHeldCents(accounts: CashAccount[]): number {
  return accounts.reduce((sum, account) => sum + account.balanceCents, 0);
}
