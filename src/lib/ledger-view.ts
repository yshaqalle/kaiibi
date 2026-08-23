import { creditOf, debitOf, type PostedLine } from '@/lib/ledger-math';
import type { Account, AccountType } from '@/types/models';

// What the ledger screens need that is arithmetic rather than rendering. Kept
// out of the components so it can be tested without a render, and out of
// ledger.ts so it can be tested without a runtime.

// Statement order, not alphabetical and not enum order. This is the sequence a
// balance sheet and a P&L are read in, and every screen that groups by type
// wants the same one.
const SECTIONS: { type: AccountType; label: string }[] = [
  { type: 'asset', label: 'Assets' },
  { type: 'liability', label: 'Liabilities' },
  { type: 'equity', label: 'Equity' },
  { type: 'revenue', label: 'Revenue' },
  { type: 'cost_of_sales', label: 'Cost of sales' },
  { type: 'expense', label: 'Expenses' },
];

export type AccountGroup = {
  type: AccountType;
  label: string;
  accounts: Account[];
  subtotalCents: number;
};

// Assets and expenses carry debit balances; the other four carry credit
// balances. Reporting each section as a POSITIVE number is what lets the screen
// say "Liabilities 31,905.40" rather than "-31,905.40", which is the sentence
// an owner would say out loud.
//
// A contra account is netted into its own section rather than given one. A
// section called "Contra" would leave the reader adding it back by hand, and
// there is no statement anywhere that has such a section.
const DEBIT_SIDE: AccountType[] = ['asset', 'cost_of_sales', 'expense'];

export function groupAccountsByType(accounts: Account[], lines: PostedLine[]): AccountGroup[] {
  const balances = new Map<string, number>();
  for (const line of lines) {
    balances.set(line.accountId, (balances.get(line.accountId) ?? 0) + line.amountCents);
  }

  return SECTIONS.map(({ type, label }) => {
    const inSection = accounts.filter((a) => a.type === type);
    const signed = inSection.reduce((sum, a) => sum + (balances.get(a.id) ?? 0), 0);
    return {
      type,
      label,
      accounts: inSection,
      subtotalCents: DEBIT_SIDE.includes(type) ? debitOf(signed) - creditOf(signed) : creditOf(signed) - debitOf(signed),
    };
  });
}

export function accountingEquation(groups: AccountGroup[]): {
  assetsCents: number;
  liabilitiesCents: number;
  equityCents: number;
  differenceCents: number;
} {
  const of = (type: AccountType) => groups.find((g) => g.type === type)?.subtotalCents ?? 0;
  const assetsCents = of('asset');
  const liabilitiesCents = of('liability');
  const equityCents = of('equity');
  return {
    assetsCents,
    liabilitiesCents,
    equityCents,
    differenceCents: assetsCents - (liabilitiesCents + equityCents),
  };
}

export type DraftLine = { code: string; amountText: string; isCredit: boolean };

// The field holds the raw string and is classified once, from the whole string.
// Never normalise inside onChangeText on a controlled TextInput -- three silent
// 100x cost bugs on the Restock branch came from exactly that.
function readCents(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
}

// Throws on an unreadable amount, because this runs on SAVE and a row reading
// "abc" is a mistake rather than a decision. Blank is different: a blank row is
// one nobody filled in, and is dropped.
export function draftToLines(draft: DraftLine[]): { code: string; amountCents: number }[] {
  const out: { code: string; amountCents: number }[] = [];
  for (const row of draft) {
    if (!row.code) continue;
    if (row.amountText.trim().length === 0) continue;
    const cents = readCents(row.amountText);
    if (cents === null) {
      throw new Error(`"${row.amountText}" is not an amount. Use digits, like 840.00.`);
    }
    out.push({ code: row.code, amountCents: row.isCredit ? -cents : cents });
  }
  return out;
}

// Runs on every keystroke, so an unreadable amount counts as zero rather than
// throwing. The Post button is gated on draftToLines succeeding, which is where
// "abc" is caught.
export function draftDifferenceCents(draft: DraftLine[]): number {
  return draft.reduce((sum, row) => {
    if (!row.code) return sum;
    const cents = readCents(row.amountText);
    if (cents === null) return sum;
    return sum + (row.isCredit ? -cents : cents);
  }, 0);
}
