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

export const ACCOUNTS_PAYABLE_CODE = '2000';

// How far Accounts Payable has gone the WRONG WAY, in cents. Zero whenever it
// sits where a liability belongs (in credit) or has never moved.
//
// A liability in debit means the books are claiming suppliers owe the shop
// money. They do not. It happens for one reason, documented as residue in
// docs/superpowers/plans/2026-08-24-auto-posting.md: `receive_stock` is what
// raises the payable for goods (Cr 2000 when the delivery lands), so a bill
// categorised `inventory_purchase` deliberately posts NOTHING -- posting it too
// would raise the same payable twice. If the delivery was never recorded in
// Inventory, nothing ever credited 2000, and `record_invoice_payment`'s
// Dr 2000 then takes the account below zero.
//
// Debit positive, matching the sign convention every journal line is stored in
// (see JournalLine in src/types/models.ts). So a POSITIVE net balance on a
// liability account is the defect, and it is returned rather than a boolean
// because the sentence has to name the amount -- "your books are 412.50 the
// wrong way round" is actionable and "something is wrong" is not.
//
// Pure, and here rather than in the screen, for the reason this whole module
// exists: `ledger.ts` imports the Supabase client and cannot load under Jest.
export function payableDebitCents(accounts: Account[], lines: PostedLine[]): number {
  const payable = accounts.find((a) => a.code === ACCOUNTS_PAYABLE_CODE);
  if (!payable) return 0;
  // Net across every line first. Summing debits alone would report an ordinary
  // shop -- which debits 2000 on every supplier payment it has ever made -- as
  // permanently broken.
  const balance = lines.reduce((sum, line) => (line.accountId === payable.id ? sum + line.amountCents : sum), 0);
  return balance > 0 ? balance : 0;
}

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
