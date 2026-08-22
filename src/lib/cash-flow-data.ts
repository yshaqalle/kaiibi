import { listCashAccounts } from '@/lib/cash-budgets';
import { cashHeldCents } from '@/lib/ledger-feeds';
import { listExpensesInRange } from '@/lib/expenses';
import { listFixedAssets } from '@/lib/fixed-assets';
import { billPaymentsInRange } from '@/lib/invoices';
import { scopeToLocation } from '@/lib/location-reporting';
import { listPayrollRuns } from '@/lib/payroll';
import { toDateColumn } from '@/lib/period';
import { listRefundsInRange, paymentsCollectedInRange } from '@/lib/sales';
import type { CashMovements } from '@/lib/financial-statements';

// Reading the five streams of money actually moving in and out.
//
// Direct method, and financial-statements.ts explains why: the indirect method
// needs each balance-sheet figure at BOTH ends of the period, and this app
// holds one confirmed balance per cash account with no history behind it. The
// figures below each come from rows that carry the date they happened on, so
// each one is either right or absent -- never reconstructed.
//
// The one thing to know before reading: an expense is recorded when it is
// INCURRED, and the money can leave at a different time. So spending is split
// three ways here, by how it was actually paid, and each stream is counted
// exactly once:
//
//   a bill      -> the cash left when the bill was paid (`billPaymentsInRange`)
//   a pay run   -> the cash left when the run was posted
//   anything else -> the cash left when the expense was logged
//
// Adding the expense rows for the first two would count the same money twice,
// which is why `paidDirectlyCents` excludes anything carrying an invoice or a
// pay run behind it.

export async function fetchCashMovements({
  shopId,
  since,
  until,
  locationFilter,
}: {
  shopId: string;
  since: Date;
  until?: Date;
  locationFilter: string | null;
}): Promise<CashMovements> {
  const [cashAccounts, payments, refunds, billPayments, expenseRows, payrollRuns, assets] = await Promise.all([
    listCashAccounts(shopId),
    paymentsCollectedInRange(shopId, since, until, locationFilter),
    listRefundsInRange(shopId, since, until, locationFilter),
    billPaymentsInRange(shopId, since, until, locationFilter),
    listExpensesInRange(shopId, since, until),
    listPayrollRuns(shopId),
    listFixedAssets(shopId),
  ]);

  const sinceColumn = toDateColumn(since);
  const untilColumn = until ? toDateColumn(until) : toDateColumn(new Date());

  const expenses = scopeToLocation(expenseRows, locationFilter);
  const scopedAssets = scopeToLocation(assets, locationFilter);
  const scopedRuns = scopeToLocation(payrollRuns, locationFilter);
  const scopedCash = locationFilter
    ? cashAccounts.filter((account) => account.locationId === locationFilter)
    : cashAccounts;

  // Only what the shop actually handed back. A refund of goods bought on
  // credit hands over no money -- `totalCents` is already capped at what was
  // collected (migration 20260831000200) -- so `goodsCents` would overstate
  // the outflow by whatever the customer had not paid.
  const refundedToCustomersCents = refunds.reduce((sum, refund) => sum + refund.totalCents, 0);

  // Neither a bill nor a pay run behind it, so it was paid when it was logged.
  const paidByHand = expenses.filter((expense) => expense.invoiceId === null && expense.payrollRunId === null);

  return {
    collectedFromCustomersCents: payments.reduce((sum, payment) => sum + payment.amountCents, 0),
    refundedToCustomersCents,
    paidOnBillsCents: billPayments.reduce((sum, payment) => sum + payment.amountCents, 0),
    // Owner draws are financing, not trading, so they come out of this stream
    // and go into their own below. Stock purchases stay: buying stock is not a
    // cost, but the money for it does leave the till.
    paidDirectlyCents: paidByHand
      .filter((expense) => expense.category !== 'owner_draw')
      .reduce((sum, expense) => sum + expense.amountCents, 0),
    // Posted runs only, and dated by when they were posted: a draft run has
    // paid nobody, and a run for March posted in April took April's cash.
    paidToStaffCents: scopedRuns
      .filter((run) => run.status === 'posted' && run.postedAt !== null)
      .filter((run) => {
        const postedOn = toDateColumn(new Date(run.postedAt!));
        return postedOn >= sinceColumn && postedOn <= untilColumn;
      })
      .reduce((sum, run) => sum + run.totalCents, 0),
    ownerDrawCents: paidByHand
      .filter((expense) => expense.category === 'owner_draw')
      .reduce((sum, expense) => sum + expense.amountCents, 0),
    assetsPurchasedCents: scopedAssets
      .filter((asset) => asset.acquiredOn >= sinceColumn && asset.acquiredOn <= untilColumn)
      .reduce((sum, asset) => sum + asset.costCents, 0),
    assetProceedsCents: scopedAssets
      .filter((asset) => asset.disposedOn !== null && asset.disposedOn >= sinceColumn && asset.disposedOn <= untilColumn)
      .reduce((sum, asset) => sum + (asset.disposalProceedsCents ?? 0), 0),
    cashHeldNowCents: cashHeldCents(scopedCash),
  };
}
