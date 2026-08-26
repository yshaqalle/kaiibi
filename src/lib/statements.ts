import { supabase } from '@/lib/supabase';

// The three financial statements, as the database returns them.
//
// NOTHING HERE DECIDES ANYTHING. Every figure is computed by statement_lines(),
// balance_sheet() and cash_flow(); this module names the columns in camelCase
// and coerces the counts. It performs no arithmetic at all -- not a subtotal,
// not a sign flip, not a re-sort. The same split ledger.ts draws, and for the
// same reason: two derivations of one figure agree until they don't, and then
// nobody knows which report is right.
//
// All three functions are `security definer` and gate on
// has_shop_permission(shop, 'ledger.view'), so a reader without it gets a
// raised error rather than a zero. That is deliberate: a zero is a claim.

/**
 * One line of a statement, exactly as `statement_lines()` and `balance_sheet()`
 * return it.
 *
 * `section` is what the screen keys off; the values differ per statement and
 * are listed on each function below. `isTotal` marks a row the FUNCTION
 * computed as a subtotal -- a screen never works one out for itself.
 *
 * `sortOrder` is the order the rows already arrive in. It is carried so a
 * screen can read it, not so a screen can re-sort by it.
 */
export type StatementLine = {
  section: string;
  /** The account code, on per-account detail rows only. Null on every total. */
  code: string | null;
  label: string;
  amountCents: number;
  isTotal: boolean;
  sortOrder: number;
};

/**
 * A cash flow row, which has FIVE columns and not six.
 *
 * cash_flow() returns no `code`: every line of an indirect cash flow is a
 * movement across a named GROUP of accounts ("Increase in tax & wages payable"
 * spans 2100 and 2200), so there is no one account to name. Typed separately
 * rather than given a `code: null` that the database never sends.
 */
export type CashFlowLine = Omit<StatementLine, 'code'>;

// bigint arrives as a STRING over PostgREST, so a bare `+` on it would
// concatenate rather than add -- see ledger.ts:121-123, where the same coercion
// is load-bearing. `sort_order` is a plain integer and arrives as a number, but
// goes through the same door so there is one rule here rather than two.
function cents(value: unknown): number {
  return Number(value ?? 0);
}

function mapLine(row: any): StatementLine {
  return {
    section: row.section,
    code: row.code ?? null,
    label: row.label,
    amountCents: cents(row.amount_cents),
    isTotal: row.is_total === true,
    sortOrder: cents(row.sort_order),
  };
}

function mapCashLine(row: any): CashFlowLine {
  return {
    section: row.section,
    label: row.label,
    amountCents: cents(row.amount_cents),
    isTotal: row.is_total === true,
    sortOrder: cents(row.sort_order),
  };
}

/**
 * Whether a statement has anything on it at all.
 *
 * A PREDICATE, not a computation: it adds nothing up and produces no figure, so
 * it does not breach the rule above. It exists because all three functions
 * always emit their total rows -- a shop that has never traded gets a complete,
 * correctly-shaped balance sheet in which every figure is zero -- and a wall of
 * $0.00 tells that shop nothing while looking exactly like a bug.
 *
 * Zero rows counts as empty too, which is what a reader without `ledger.view`
 * would see if the gate were ever loosened from a raise to an empty result.
 */
export function hasFigures(rows: { amountCents: number }[]): boolean {
  return rows.some((row) => row.amountCents !== 0);
}

/**
 * The income statement between two dates, in `sort_order`.
 *
 * Sections: `revenue`, `cost_of_sales`, `gross_profit`, `operating_expenses`,
 * `net_profit`. Every figure is in PRESENTATION sign -- income positive, costs
 * positive -- because the function already flipped the ledger's debit-positive
 * convention. A caller that negates a cost line is flipping it twice.
 *
 * `detail` is the same aggregation at a finer grain, not a second report: with
 * it, each section also carries a row per account. Built as one query with a
 * flag precisely so the owner's five lines and the accountant's forty can never
 * disagree.
 *
 * `from` and `to` are `date` COLUMNS -- 'YYYY-MM-DD', from `toDateColumn` --
 * never `Date.toISOString()`, which converts to UTC first and so asks for the
 * wrong day from an evening west of Greenwich.
 */
export async function listStatementLines(
  shopId: string,
  from: string,
  to: string,
  detail = false
): Promise<StatementLine[]> {
  const { data, error } = await supabase.rpc('statement_lines', {
    p_shop_id: shopId,
    p_from: from,
    p_to: to,
    p_detail: detail,
  });
  if (error) throw error;
  return (data ?? []).map(mapLine);
}

/**
 * The balance sheet AS AT one date, in `sort_order`.
 *
 * One date, not a range: a balance sheet is a position, and there is no such
 * thing as one "over the last 7 days". The caller passes the END of whatever
 * window the screen is showing.
 *
 * Sections: `current_assets`, `fixed_assets`, `total_assets`, `liabilities`,
 * `equity`, `total_liabilities_equity`. Assets present as they sit in the
 * ledger; liabilities and equity are negated out of their credit balances by
 * the function.
 */
export async function getBalanceSheet(shopId: string, asOf: string): Promise<StatementLine[]> {
  const { data, error } = await supabase.rpc('balance_sheet', { p_shop_id: shopId, p_as_of: asOf });
  if (error) throw error;
  return (data ?? []).map(mapLine);
}

/**
 * The cash flow between two dates, indirect method, in `sort_order`.
 *
 * Sections: `operating`, `investing`, `financing`, `net_change`, `proof`.
 *
 * The `proof` section is not decoration and must never be dropped by a caller
 * shortening the screen. `Movement in cash accounts` is the OBSERVED movement
 * in 1000/1010/1020/1021, reached by no part of the arithmetic above it; net
 * change must equal it, and any sign slip anywhere in the statement lands
 * there.
 */
export async function getCashFlow(shopId: string, from: string, to: string): Promise<CashFlowLine[]> {
  const { data, error } = await supabase.rpc('cash_flow', { p_shop_id: shopId, p_from: from, p_to: to });
  if (error) throw error;
  return (data ?? []).map(mapCashLine);
}
