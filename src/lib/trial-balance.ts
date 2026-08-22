import { accountNormalBalance, accountSignedBalanceCents, sortAccounts } from '@/lib/chart-of-accounts';
import type { LedgerAccount, LedgerFeed } from '@/types/models';

// Turning a chart of accounts into balances, and balances into a trial
// balance.
//
// This is where the ledger's central rule becomes arithmetic. An account is
// fed or it is posted (see the chart-of-accounts migration), and the two are
// measured in completely different ways:
//
//   **A fed account's balance IS its operational stream.** `1000 Cash on hand`
//   holds whatever the tills hold. Nothing was posted for it and nothing needs
//   to be; the figure is read from the rows the shop already keeps.
//
//   **A posted account's balance is its opening figure plus its journal.**
//   Nothing else touches it, so debits less credits is the whole story.
//
// Pure, and free of the Supabase client, so every number a statement prints
// can be checked without a database. The fetching half lives in
// ledger-feeds.ts.

/**
 * What each operational stream came to, signed in its account's NORMAL
 * direction — positive means "the account holds what it is supposed to hold".
 *
 * So `cash_on_hand: 50_000` is $500 in the till, and `accounts_payable: 30_000`
 * is $300 owed to suppliers, even though one is a debit balance and the other
 * a credit. Callers work in the shopkeeper's direction and the sign conversion
 * happens once, here.
 *
 * A missing feed is zero, not an error: a shop with no bank account has no
 * `bank` figure, and that is a fact rather than a gap.
 */
export type FeedFigures = Partial<Record<LedgerFeed, number>>;

/** Posted movement on one account, as `ledger_account_movement` returns it. */
export type AccountMovement = { accountId: string; debitCents: number; creditCents: number };

export type AccountBalance = {
  account: LedgerAccount;
  /** Signed in the account's normal direction — see FeedFigures. */
  balanceCents: number;
  /** Which of the two rules above produced it, so the UI can say so. */
  basis: 'feed' | 'posted';
  /** The trial balance's two columns. Exactly one is non-zero. */
  debitCents: number;
  creditCents: number;
};

function toColumns(
  account: LedgerAccount,
  balanceCents: number
): { debitCents: number; creditCents: number } {
  // A balance sitting on the side the account leans lands in that column; one
  // that has gone the other way lands in the opposite column, still as a
  // positive figure. Printing a negative debit instead would stop the two
  // columns summing to anything a reader can check by hand, which is the only
  // thing a trial balance is for.
  //
  // `accountNormalBalance`, not `normalBalance`: accumulated depreciation is
  // filed as an asset and leans credit, and putting it in the debit column
  // throws the trial balance out by twice its size.
  const landsOnDebit = (accountNormalBalance(account) === 'debit') === (balanceCents >= 0);
  const magnitude = Math.abs(balanceCents);
  return landsOnDebit
    ? { debitCents: magnitude, creditCents: 0 }
    : { debitCents: 0, creditCents: magnitude };
}

/**
 * Every account's balance, by whichever rule applies to it.
 *
 * `movements` is keyed by account id. A posted account with no movement and no
 * opening figure comes back at zero rather than being dropped — the chart is
 * the list of questions, and an account reading zero is an answer.
 */
export function accountBalances(
  accounts: LedgerAccount[],
  feeds: FeedFigures,
  movements: AccountMovement[]
): AccountBalance[] {
  const byAccount = new Map(movements.map((m) => [m.accountId, m]));

  return sortAccounts(accounts).map((account) => {
    if (account.feed) {
      // Deliberately ignores both the opening balance and any movement. The
      // database refuses an opening figure on a fed account and refuses a
      // hand-posted line against one, so either would mean the row arrived
      // from somewhere that bypassed both -- and quietly adding it to the feed
      // is exactly the double-count the whole design exists to prevent.
      const balanceCents = feeds[account.feed] ?? 0;
      return { account, balanceCents, basis: 'feed' as const, ...toColumns(account, balanceCents) };
    }
    const movement = byAccount.get(account.id);
    const balanceCents =
      account.openingBalanceCents +
      accountSignedBalanceCents(account, movement?.debitCents ?? 0, movement?.creditCents ?? 0);
    return { account, balanceCents, basis: 'posted' as const, ...toColumns(account, balanceCents) };
  });
}

export type TrialBalance = {
  rows: AccountBalance[];
  totalDebitCents: number;
  totalCreditCents: number;
  /**
   * Debits less credits. Zero is a balanced set of books.
   *
   * A hand-kept ledger can only be out through arithmetic, so a non-zero
   * figure there means a mistake. Here it means something else, and the
   * distinction is the difference between a useful screen and an alarming one:
   * the feeds report what the shop HAS, and if nobody has ever stated what the
   * owner PUT IN -- capital, and the profit kept from before these books
   * started -- the two sides cannot meet. The difference is almost always
   * those missing opening figures, which is why `suggestedEquityCents` names
   * it rather than leaving the reader hunting for an arithmetic slip that is
   * not there.
   */
  differenceCents: number;
  /**
   * What an opening equity entry would have to be for the books to balance.
   *
   * Offered, not applied. Posting it is a decision about the business -- money
   * the owner put in, profit from before the books started, or a mistake
   * somewhere else entirely -- and an app that quietly plugged the gap would be
   * making that decision on the owner's behalf and hiding it.
   */
  suggestedEquityCents: number;
  balanced: boolean;
};

/**
 * The trial balance: every account, both columns, and whether they meet.
 *
 * A PERIOD-END trial balance, which is the standard shape and worth naming
 * because the two halves are measured over different windows: balance-sheet
 * accounts stand where they stand today, and income and expense accounts cover
 * the selected period. `fetchLedgerSnapshot` in ledger-feeds.ts explains why
 * the first half cannot be anything else here -- a cash account holds one
 * confirmed balance, not a history.
 *
 * Archived accounts sitting at zero are dropped: they are history the shop has
 * already put away, and a chart that grows forever is one nobody scans.
 */
export function trialBalance(
  accounts: LedgerAccount[],
  feeds: FeedFigures,
  movements: AccountMovement[]
): TrialBalance {
  const rows = accountBalances(accounts, feeds, movements).filter(
    (row) => !row.account.archived || row.balanceCents !== 0
  );
  const totalDebitCents = rows.reduce((sum, row) => sum + row.debitCents, 0);
  const totalCreditCents = rows.reduce((sum, row) => sum + row.creditCents, 0);
  const differenceCents = totalDebitCents - totalCreditCents;
  return {
    rows,
    totalDebitCents,
    totalCreditCents,
    differenceCents,
    // Equity is a credit-normal account, so a debit-heavy trial balance needs
    // that much MORE equity to close.
    suggestedEquityCents: differenceCents,
    balanced: differenceCents === 0,
  };
}

/** The balances of one subtype, in chart order, with zero-balance rows dropped. */
export function balancesForSubtypes(
  balances: AccountBalance[],
  subtypes: LedgerAccount['subtype'][]
): AccountBalance[] {
  return balances.filter((row) => subtypes.includes(row.account.subtype) && row.balanceCents !== 0);
}

/**
 * The signed sum of a group, with contra accounts subtracting.
 *
 * The contra handling is the point. `1510 Accumulated depreciation` holds a
 * positive figure -- $4,000 of wear charged -- and the fixed-asset group is
 * cost LESS that, so adding it would report a fridge as being worth more the
 * longer it had been running.
 */
export function sumBalances(balances: AccountBalance[]): number {
  return balances.reduce(
    (sum, row) => sum + (row.account.contra ? -row.balanceCents : row.balanceCents),
    0
  );
}
