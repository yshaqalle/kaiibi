import type {
  ExpenseCategory,
  LedgerAccount,
  LedgerAccountSubtype,
  LedgerAccountType,
  LedgerFeed,
} from '@/types/models';

// The vocabulary of the ledger: what an account type means, which way it
// normally leans, where each one prints on a statement, and which expense
// category maps to which account.
//
// Pure, and deliberately separate from `ledger.ts` — that module imports the
// Supabase client, which pulls in AsyncStorage and cannot load outside a
// native runtime, so anything importing it is untestable under Jest. The same
// split expenses.ts / expense-reporting.ts already makes, and for the same
// reason: these are the rules a balance sheet is built out of, and they should
// be checkable with no database in the room.

export const LEDGER_ACCOUNT_TYPES: { key: LedgerAccountType; label: string; blurb: string }[] = [
  { key: 'asset', label: 'Asset', blurb: 'Things the business owns or is owed.' },
  { key: 'liability', label: 'Liability', blurb: 'What the business owes to someone else.' },
  { key: 'equity', label: 'Equity', blurb: "The owner's stake in what is left." },
  { key: 'income', label: 'Income', blurb: 'What the business earns.' },
  { key: 'expense', label: 'Expense', blurb: 'What it costs to earn it.' },
];

// Which side of the ledger increases the account.
//
// This is the one piece of double-entry arithmetic everything else rests on. A
// debit adds to an asset and takes away from a liability; a credit does the
// opposite. Getting it wrong does not throw — it silently reports a profit as
// a loss.
export function normalBalance(type: LedgerAccountType): 'debit' | 'credit' {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

// A balance expressed in the account's own direction, from raw debit and
// credit totals. An asset with $500 debited and $200 credited holds $300; a
// liability with the same figures owes -$300, which is to say it is $300 in
// hand rather than owed.
export function signedBalanceCents(
  type: LedgerAccountType,
  debitCents: number,
  creditCents: number
): number {
  return normalBalance(type) === 'debit' ? debitCents - creditCents : creditCents - debitCents;
}

/**
 * The side an account actually leans, contra flag included.
 *
 * A contra account sits under its parent and leans the OTHER way: accumulated
 * depreciation is filed as an asset but carries a credit balance, and the
 * owner's draw is filed as equity but carries a debit. Judging either by
 * `type` alone puts it in the wrong column of the trial balance -- and the
 * trial balance is then out by twice the figure, which sends someone looking
 * for an error that is not there.
 */
export function accountNormalBalance(
  account: Pick<LedgerAccount, 'type' | 'contra'>
): 'debit' | 'credit' {
  const base = normalBalance(account.type);
  if (!account.contra) return base;
  return base === 'debit' ? 'credit' : 'debit';
}

/** `signedBalanceCents`, judged by the side the account actually leans. */
export function accountSignedBalanceCents(
  account: Pick<LedgerAccount, 'type' | 'contra'>,
  debitCents: number,
  creditCents: number
): number {
  return accountNormalBalance(account) === 'debit' ? debitCents - creditCents : creditCents - debitCents;
}

export const LEDGER_SUBTYPES: { key: LedgerAccountSubtype; label: string; type: LedgerAccountType }[] = [
  { key: 'current_asset', label: 'Current assets', type: 'asset' },
  { key: 'fixed_asset', label: 'Fixed assets', type: 'asset' },
  { key: 'other_asset', label: 'Other assets', type: 'asset' },
  { key: 'current_liability', label: 'Current liabilities', type: 'liability' },
  { key: 'long_term_liability', label: 'Long-term liabilities', type: 'liability' },
  { key: 'equity', label: 'Equity', type: 'equity' },
  { key: 'operating_income', label: 'Revenue', type: 'income' },
  { key: 'other_income', label: 'Other income', type: 'income' },
  { key: 'cost_of_sales', label: 'Cost of sales', type: 'expense' },
  { key: 'operating_expense', label: 'Operating expenses', type: 'expense' },
  { key: 'other_expense', label: 'Other expenses', type: 'expense' },
];

const SUBTYPE_LABELS = new Map(LEDGER_SUBTYPES.map((s) => [s.key, s.label]));

export function subtypeLabel(subtype: LedgerAccountSubtype): string {
  return SUBTYPE_LABELS.get(subtype) ?? subtype;
}

export function subtypesForType(type: LedgerAccountType): LedgerAccountSubtype[] {
  return LEDGER_SUBTYPES.filter((s) => s.type === type).map((s) => s.key);
}

export function accountTypeLabel(type: LedgerAccountType): string {
  return LEDGER_ACCOUNT_TYPES.find((t) => t.key === type)?.label ?? type;
}

// What a fed account is telling the reader. Shown wherever the account is
// editable, because "why can't I type a balance in here" is the first question
// this design provokes.
const FEED_BLURBS: Record<LedgerFeed, string> = {
  cash_on_hand: 'Every till and cash drawer, at its last counted balance.',
  bank: 'Every bank account, at its last confirmed balance.',
  mobile_money: 'Every mobile-money wallet, at its last confirmed balance.',
  accounts_receivable: 'What customers still owe on unsettled sales.',
  inventory: 'Stock on hand, valued at what it cost.',
  fixed_assets: 'The asset register, at cost.',
  accumulated_depreciation: 'Depreciation charged on those assets to date.',
  accounts_payable: 'What is still outstanding on vendor bills.',
  sales_tax_payable: 'Tax collected on sales, net of tax handed back with refunds.',
  sales_revenue: 'Takings net of sales tax and refunds.',
  cost_of_goods_sold: 'What the goods sold in the period cost the shop.',
  asset_disposal_result: 'What disposed assets fetched, less what they were still worth.',
  expense_rent: 'Expenses logged as rent.',
  expense_utilities: 'Expenses logged as utilities.',
  expense_salaries_wages: 'Wages: posted pay runs, plus pay earned and not yet run.',
  expense_marketing: 'Expenses logged as marketing.',
  expense_supplies: 'Expenses logged as supplies.',
  expense_transport_delivery: 'Expenses logged as transport and delivery.',
  expense_maintenance_repairs: 'Expenses logged as maintenance and repairs.',
  expense_fees_charges: 'Expenses logged as fees and charges.',
  expense_other: 'Expenses logged as other.',
  expense_depreciation: 'Depreciation on the asset register for the period.',
  owner_draw: "Money the owner took out, logged as owner's draw.",
};

export function feedBlurb(feed: LedgerFeed): string {
  return FEED_BLURBS[feed];
}

// Which account each expense category reports through.
//
// Two categories are deliberately absent, and both absences are load-bearing:
//
//   `inventory_purchase` — buying stock is one asset becoming another, not a
//   cost. The goods are already counted by the `inventory` feed, and giving
//   restock spend an expense account would count them twice.
//
//   `owner_draw` — taking money out is not a cost of trading. It reduces
//   equity, through the contra account of the same name, which is where the
//   feed of that name sends it.
//
// Both already sit outside the P&L's operating subtotal
// (`NON_OPERATING_CATEGORIES` in expense-reporting.ts); this is the same rule
// stated in the ledger's vocabulary, and the two must agree.
export const EXPENSE_CATEGORY_FEEDS: Partial<Record<ExpenseCategory, LedgerFeed>> = {
  rent: 'expense_rent',
  utilities: 'expense_utilities',
  salaries_wages: 'expense_salaries_wages',
  marketing: 'expense_marketing',
  supplies: 'expense_supplies',
  transport_delivery: 'expense_transport_delivery',
  maintenance_repairs: 'expense_maintenance_repairs',
  fees_charges: 'expense_fees_charges',
  other: 'expense_other',
  owner_draw: 'owner_draw',
};

export function feedForExpenseCategory(category: ExpenseCategory): LedgerFeed | null {
  return EXPENSE_CATEGORY_FEEDS[category] ?? null;
}

// A stable order for the whole chart: type first in the order a statement
// reads them, then the shop's own code within it.
//
// `localeCompare` with `numeric`, so '1000' sorts before '1010' and before
// '20' — a plain string compare puts '1000' after '20', which makes a chart
// look shuffled to the person who numbered it.
const TYPE_ORDER: LedgerAccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];

export function compareAccounts(a: LedgerAccount, b: LedgerAccount): number {
  const byType = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
  if (byType !== 0) return byType;
  const byCode = a.code.localeCompare(b.code, undefined, { numeric: true });
  if (byCode !== 0) return byCode;
  return a.name.localeCompare(b.name);
}

export function sortAccounts(accounts: LedgerAccount[]): LedgerAccount[] {
  return [...accounts].sort(compareAccounts);
}

// The accounts a journal entry may name. Fed accounts are excluded because the
// database refuses them (see post_journal_entry), and offering a choice the
// server will reject is how a form becomes a guessing game.
export function postableAccounts(accounts: LedgerAccount[]): LedgerAccount[] {
  return sortAccounts(accounts.filter((a) => a.feed === null && !a.archived));
}

export function accountsByFeed(accounts: LedgerAccount[]): Map<LedgerFeed, LedgerAccount> {
  const map = new Map<LedgerFeed, LedgerAccount>();
  for (const account of accounts) {
    // The database holds one account per feed per shop (a partial unique
    // index), so a later row can only be a duplicate arriving from a stale
    // cache. First wins rather than last, so the picture does not flip between
    // reads.
    if (account.feed && !map.has(account.feed)) map.set(account.feed, account);
  }
  return map;
}

// The next free code in an account type's own thousand, for the "new account"
// form. A suggestion, not a rule — the shop can type anything unique.
export function suggestAccountCode(accounts: LedgerAccount[], type: LedgerAccountType): string {
  const base = { asset: 1000, liability: 2000, equity: 3000, income: 4000, expense: 6000 }[type];
  const taken = new Set(accounts.map((a) => a.code));
  // Tens, not ones: shops number in tens so there is room to slot an account
  // between two others later without renumbering the chart.
  for (let code = base; code < base + 1000; code += 10) {
    if (!taken.has(String(code))) return String(code);
  }
  // A thousand accounts of one type is not a chart anybody maintains, but the
  // form still has to put something in the box.
  return String(base);
}
