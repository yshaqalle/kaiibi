import { accountBalances, sumBalances, trialBalance, type FeedFigures } from '@/lib/trial-balance';
import { balanceSheet, incomeStatement } from '@/lib/financial-statements';
import type { LedgerAccount } from '@/types/models';

// The arithmetic the whole ledger rests on: an account is FED or POSTED, never
// both, and a contra account leans the other way from its type. Getting either
// wrong does not throw — it silently prints a profit as a loss, or throws the
// trial balance out by exactly twice a figure and sends someone hunting for an
// arithmetic slip that is not there.

function account(overrides: Partial<LedgerAccount> = {}): LedgerAccount {
  return {
    // Defaults to the code, so a fixture that names one need not name both —
    // and every id in a chart stays distinct without the caller thinking about
    // it.
    id: overrides.id ?? overrides.code ?? 'acct',
    shopId: 'shop',
    code: '1000',
    name: 'Cash on hand',
    type: 'asset',
    subtype: 'current_asset',
    feed: null,
    contra: false,
    openingBalanceCents: 0,
    openingBalanceOn: null,
    isSystem: true,
    archived: false,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const CASH = account({ id: 'cash', code: '1000', name: 'Cash on hand', feed: 'cash_on_hand' });
const AP = account({
  id: 'ap',
  code: '2000',
  name: 'Accounts payable',
  type: 'liability',
  subtype: 'current_liability',
  feed: 'accounts_payable',
});
const ACCUM = account({
  id: 'accum',
  code: '1510',
  name: 'Accumulated depreciation',
  subtype: 'fixed_asset',
  feed: 'accumulated_depreciation',
  contra: true,
});
const FIXED = account({ id: 'fixed', code: '1500', name: 'Fixed assets', subtype: 'fixed_asset', feed: 'fixed_assets' });
const EQUITY = account({ id: 'equity', code: '3000', name: "Owner's equity", type: 'equity', subtype: 'equity' });
const LOAN = account({
  id: 'loan',
  code: '2500',
  name: 'Loans',
  type: 'liability',
  subtype: 'long_term_liability',
});
const REVENUE = account({ id: 'rev', code: '4000', name: 'Sales revenue', type: 'income', subtype: 'operating_income', feed: 'sales_revenue' });
const COGS = account({ id: 'cogs', code: '5000', name: 'Cost of goods sold', type: 'expense', subtype: 'cost_of_sales', feed: 'cost_of_goods_sold' });
const RENT = account({ id: 'rent', code: '6000', name: 'Rent', type: 'expense', subtype: 'operating_expense', feed: 'expense_rent' });

describe('accountBalances', () => {
  it('takes a fed account’s balance from its feed', () => {
    const [row] = accountBalances([CASH], { cash_on_hand: 50_000 }, []);
    expect(row.balanceCents).toBe(50_000);
    expect(row.basis).toBe('feed');
    expect(row.debitCents).toBe(50_000);
    expect(row.creditCents).toBe(0);
  });

  it('ignores movement posted against a fed account rather than adding it', () => {
    // The database refuses such a line, so its presence means something
    // bypassed both checks — and quietly adding it to the feed is exactly the
    // double-count the design exists to prevent.
    const [row] = accountBalances([CASH], { cash_on_hand: 50_000 }, [
      { accountId: 'cash', debitCents: 999_999, creditCents: 0 },
    ]);
    expect(row.balanceCents).toBe(50_000);
  });

  it('takes a posted account’s balance from its opening figure plus its journal', () => {
    const withOpening = { ...EQUITY, openingBalanceCents: 100_000 };
    const [row] = accountBalances([withOpening], {}, [{ accountId: 'equity', debitCents: 0, creditCents: 20_000 }]);
    // Equity is credit-normal, so a credit adds to it.
    expect(row.balanceCents).toBe(120_000);
    expect(row.basis).toBe('posted');
    expect(row.creditCents).toBe(120_000);
  });

  it('reports a missing feed as zero rather than dropping the account', () => {
    // The chart is the list of questions; an account reading zero is an answer.
    const [row] = accountBalances([CASH], {}, []);
    expect(row.balanceCents).toBe(0);
  });

  it('puts a contra asset in the CREDIT column', () => {
    // Judged by type alone this lands in debits and the trial balance is out
    // by twice the depreciation charged.
    const [row] = accountBalances([ACCUM], { accumulated_depreciation: 40_000 }, []);
    expect(row.creditCents).toBe(40_000);
    expect(row.debitCents).toBe(0);
  });

  it('puts a balance that has gone the wrong way in the opposite column, still positive', () => {
    // An overdrawn bank account. Printing a negative debit would stop the two
    // columns summing to anything a reader can check by hand.
    const [row] = accountBalances([CASH], { cash_on_hand: -5_000 }, []);
    expect(row.debitCents).toBe(0);
    expect(row.creditCents).toBe(5_000);
  });
});

describe('sumBalances', () => {
  it('subtracts a contra account from its group', () => {
    // Adding it would report a fridge as worth MORE the longer it had run.
    const rows = accountBalances([FIXED, ACCUM], { fixed_assets: 300_000, accumulated_depreciation: 40_000 }, []);
    expect(sumBalances(rows)).toBe(260_000);
  });
});

describe('trialBalance', () => {
  const FEEDS: FeedFigures = {
    cash_on_hand: 120_000,
    accounts_payable: 30_000,
    sales_revenue: 200_000,
    cost_of_goods_sold: 80_000,
    expense_rent: 40_000,
  };

  it('balances once the opening equity has been stated', () => {
    // Assets 120,000 + costs 120,000 = 240,000 debits.
    // Payables 30,000 + revenue 200,000 = 230,000 credits, so 10,000 of equity
    // closes it.
    const equity = { ...EQUITY, openingBalanceCents: 10_000 };
    const result = trialBalance([CASH, AP, EQUITY, REVENUE, COGS, RENT].map((a) => (a.id === 'equity' ? equity : a)), FEEDS, []);
    expect(result.totalDebitCents).toBe(240_000);
    expect(result.totalCreditCents).toBe(240_000);
    expect(result.balanced).toBe(true);
    expect(result.differenceCents).toBe(0);
  });

  it('names the missing equity rather than leaving a bare difference', () => {
    const result = trialBalance([CASH, AP, EQUITY, REVENUE, COGS, RENT], FEEDS, []);
    expect(result.balanced).toBe(false);
    expect(result.differenceCents).toBe(10_000);
    expect(result.suggestedEquityCents).toBe(10_000);
  });

  it('drops an archived account sitting at zero but keeps one still holding a balance', () => {
    const emptyArchive = account({ id: 'old', code: '6900', name: 'Old', type: 'expense', subtype: 'operating_expense', archived: true });
    const heldArchive = { ...LOAN, archived: true, openingBalanceCents: 5_000 };
    const result = trialBalance([CASH, emptyArchive, heldArchive], { cash_on_hand: 1 }, []);
    expect(result.rows.map((row) => row.account.id)).toEqual(['cash', 'loan']);
  });
});

describe('the statements agree with each other', () => {
  const ACCOUNTS = [CASH, FIXED, ACCUM, AP, LOAN, EQUITY, REVENUE, COGS, RENT];
  const FEEDS: FeedFigures = {
    cash_on_hand: 120_000,
    fixed_assets: 300_000,
    accumulated_depreciation: 40_000,
    accounts_payable: 30_000,
    sales_revenue: 200_000,
    cost_of_goods_sold: 80_000,
    expense_rent: 40_000,
  };

  const balances = accountBalances(ACCOUNTS, FEEDS, []);

  it('computes profit the same way in both places', () => {
    // The balance sheet calls the income statement rather than re-summing, so
    // the two cannot drift. This pins that it stays that way.
    expect(balanceSheet(balances).retainedEarningsCents).toBe(incomeStatement(balances).netProfitCents);
  });

  it('reads gross profit as revenue less cost of sales', () => {
    const statement = incomeStatement(balances);
    expect(statement.grossProfitCents).toBe(120_000);
    expect(statement.netProfitCents).toBe(80_000);
    expect(statement.grossMarginPct).toBe(60);
  });

  it('states no margin at all when there was no revenue', () => {
    // "0% margin" on a quiet day says something false about the shop; no
    // figure says nothing.
    const quiet = accountBalances(ACCOUNTS, { expense_rent: 40_000 }, []);
    expect(incomeStatement(quiet).grossMarginPct).toBeNull();
    expect(incomeStatement(quiet).netMarginPct).toBeNull();
  });

  it('carries fixed assets net of depreciation', () => {
    expect(balanceSheet(balances).fixedAssets.totalCents).toBe(260_000);
  });

  it('shows the gap rather than plugging it into equity', () => {
    // Assets 380,000; liabilities 30,000; equity 0 + profit 80,000. The
    // 270,000 difference is the opening capital nobody has stated, and folding
    // it in silently would give a sheet that always balanced and never said
    // why.
    const sheet = balanceSheet(balances);
    expect(sheet.totalAssetsCents).toBe(380_000);
    expect(sheet.balanced).toBe(false);
    expect(sheet.differenceCents).toBe(270_000);
  });

  it('balances once that opening capital is entered', () => {
    const withCapital = accountBalances(
      ACCOUNTS.map((a) => (a.id === 'equity' ? { ...a, openingBalanceCents: 270_000 } : a)),
      FEEDS,
      []
    );
    expect(balanceSheet(withCapital).balanced).toBe(true);
  });
});
