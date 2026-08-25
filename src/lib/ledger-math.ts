import type { Account } from '@/types/models';

// The arithmetic of the ledger, as pure functions over already-fetched rows.
//
// Deliberately separate from `ledger.ts`, for the reason `expense-reporting.ts`
// gives for sitting apart from `expenses.ts`: that module imports the Supabase
// client, which pulls in AsyncStorage and cannot load outside a native runtime,
// so anything importing it is untestable under Jest. The numbers that decide
// whether the books balance are exactly the numbers that must be testable with
// no mocking at all.

// A journal line stores ONE signed amount, debit positive. These two are the
// projection into the pair of columns a statement shows. See the note on
// JournalLine in src/types/models.ts for why the storage is not two fields.
export function debitOf(amountCents: number): number {
  return amountCents > 0 ? amountCents : 0;
}

export function creditOf(amountCents: number): number {
  return amountCents < 0 ? -amountCents : 0;
}

// Signed on purpose: the sign tells the UI which side is short, which is the
// difference between "you are 839.99 out" and "add 839.99 to the credit side".
export function entryDifferenceCents(lines: { amountCents: number }[]): number {
  return lines.reduce((sum, line) => sum + line.amountCents, 0);
}

// Two lines is part of the definition, not a nicety. One line summing to zero
// is a zero line, which records nothing -- and the database refuses both, so a
// UI that called a single line balanced would offer a Post button that fails.
export function isBalanced(lines: { amountCents: number }[]): boolean {
  return lines.length >= 2 && entryDifferenceCents(lines) === 0;
}

export type PostedLine = { accountId: string; amountCents: number };

// HOW FAR ACCOUNTS PAYABLE HAS GONE THE WRONG WAY IS NOT COMPUTED HERE, AND
// PUTTING IT BACK WOULD REINTRODUCE THE DEFECT IT WAS REMOVED FOR.
//
// It used to be `payableDebitCents(accounts, lines)` over the rows
// `listPostedLines()` returned -- which is EVERY journal line the shop has ever
// posted, and PostgREST caps a response at `max-rows` (1000 by default) with no
// error and no marker. Past that the netting ran over an arbitrary prefix of the
// journal and the Bills screen showed a confident `wrong` accusation, with a
// destructive action attached, to shops whose payable was perfectly healthy.
//
// The sum now happens where the rows are: public.accounts_payable_debit()
// (20260908001700), reached through getPayableState() in ledger.ts. It also
// returns whether the shop has unposted history, because the amount alone cannot
// tell a missing DELIVERY from a bill that simply has not been replayed yet, and
// the two have opposite remedies.

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: Account['type'];
  debitCents: number;
  creditCents: number;
};

// Net first, then choose a side. Doing it the other way round -- summing debits
// and credits separately per account -- would report an overdrawn bank account
// as both a large debit and a slightly larger credit, and the reader would have
// to subtract to find out it was overdrawn at all.
export function trialBalance(accounts: Account[], lines: PostedLine[]): TrialBalanceRow[] {
  const balances = new Map<string, number>();
  for (const line of lines) {
    balances.set(line.accountId, (balances.get(line.accountId) ?? 0) + line.amountCents);
  }

  return accounts
    .filter((a) => (balances.get(a.id) ?? 0) !== 0)
    .map((a) => {
      const balance = balances.get(a.id) ?? 0;
      return {
        accountId: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        debitCents: debitOf(balance),
        creditCents: creditOf(balance),
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}
