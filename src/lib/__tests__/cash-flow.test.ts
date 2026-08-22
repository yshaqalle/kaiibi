import { cashFlowStatement, type CashMovements } from '@/lib/financial-statements';
import { EXPENSE_CATEGORY_FEEDS, accountNormalBalance, suggestAccountCode } from '@/lib/chart-of-accounts';
import type { LedgerAccount } from '@/types/models';

function movements(overrides: Partial<CashMovements> = {}): CashMovements {
  return {
    collectedFromCustomersCents: 0,
    refundedToCustomersCents: 0,
    paidOnBillsCents: 0,
    paidDirectlyCents: 0,
    paidToStaffCents: 0,
    ownerDrawCents: 0,
    assetsPurchasedCents: 0,
    assetProceedsCents: 0,
    cashHeldNowCents: 0,
    ...overrides,
  };
}

describe('cashFlowStatement', () => {
  it('nets money in against money out', () => {
    const statement = cashFlowStatement(
      movements({
        collectedFromCustomersCents: 500_000,
        refundedToCustomersCents: 20_000,
        paidOnBillsCents: 150_000,
        paidDirectlyCents: 60_000,
        paidToStaffCents: 100_000,
      })
    );
    expect(statement.operating.totalCents).toBe(170_000);
    expect(statement.netMovementCents).toBe(170_000);
  });

  it('separates buying and selling assets from trading', () => {
    const statement = cashFlowStatement(
      movements({ collectedFromCustomersCents: 100_000, assetsPurchasedCents: 300_000, assetProceedsCents: 50_000 })
    );
    expect(statement.operating.totalCents).toBe(100_000);
    expect(statement.investing.totalCents).toBe(-250_000);
    // A profitable month that still emptied the till — the whole reason this
    // statement exists alongside the P&L.
    expect(statement.netMovementCents).toBe(-150_000);
  });

  it("puts an owner's draw under financing, not trading", () => {
    const statement = cashFlowStatement(movements({ collectedFromCustomersCents: 100_000, ownerDrawCents: 40_000 }));
    expect(statement.operating.totalCents).toBe(100_000);
    expect(statement.financing.totalCents).toBe(-40_000);
    expect(statement.netMovementCents).toBe(60_000);
  });

  it('leaves out the lines that did not happen', () => {
    // A statement that lists five zeroes is a statement nobody reads.
    const statement = cashFlowStatement(movements({ collectedFromCustomersCents: 100_000 }));
    expect(statement.operating.lines).toHaveLength(1);
    expect(statement.investing.lines).toHaveLength(0);
    expect(statement.financing.lines).toHaveLength(0);
  });

  it('reports cash in hand as a fact about today, apart from the movement', () => {
    const statement = cashFlowStatement(movements({ collectedFromCustomersCents: 10, cashHeldNowCents: 999_999 }));
    expect(statement.cashHeldNowCents).toBe(999_999);
    expect(statement.netMovementCents).toBe(10);
  });
});

describe('the ledger vocabulary', () => {
  function account(overrides: Partial<LedgerAccount>): Pick<LedgerAccount, 'type' | 'contra'> {
    return { type: 'asset', contra: false, ...overrides } as Pick<LedgerAccount, 'type' | 'contra'>;
  }

  it('knows which way each kind of account leans', () => {
    expect(accountNormalBalance(account({ type: 'asset' }))).toBe('debit');
    expect(accountNormalBalance(account({ type: 'expense' }))).toBe('debit');
    expect(accountNormalBalance(account({ type: 'liability' }))).toBe('credit');
    expect(accountNormalBalance(account({ type: 'income' }))).toBe('credit');
    expect(accountNormalBalance(account({ type: 'equity' }))).toBe('credit');
  });

  it('flips a contra account, which is what keeps the trial balance honest', () => {
    // Accumulated depreciation is filed as an asset and carries a credit;
    // an owner's draw is filed as equity and carries a debit.
    expect(accountNormalBalance(account({ type: 'asset', contra: true }))).toBe('credit');
    expect(accountNormalBalance(account({ type: 'equity', contra: true }))).toBe('debit');
  });

  it('gives stock purchases no expense account, so the goods are not counted twice', () => {
    // Buying stock is one asset becoming another. The goods are already on the
    // balance sheet through the `inventory` feed.
    expect(EXPENSE_CATEGORY_FEEDS.inventory_purchase).toBeUndefined();
    expect(EXPENSE_CATEGORY_FEEDS.rent).toBe('expense_rent');
    // An owner's draw reduces equity rather than being a cost of trading.
    expect(EXPENSE_CATEGORY_FEEDS.owner_draw).toBe('owner_draw');
  });
});

describe('suggestAccountCode', () => {
  function existing(codes: string[]): LedgerAccount[] {
    return codes.map((code) => ({
      id: code,
      shopId: 'shop',
      code,
      name: code,
      type: 'expense',
      subtype: 'operating_expense',
      feed: null,
      contra: false,
      openingBalanceCents: 0,
      openingBalanceOn: null,
      isSystem: false,
      archived: false,
      notes: null,
      createdAt: '',
      updatedAt: '',
    }));
  }

  it('suggests the first free code in the type’s own thousand', () => {
    expect(suggestAccountCode(existing([]), 'asset')).toBe('1000');
    expect(suggestAccountCode(existing([]), 'income')).toBe('4000');
  });

  it('steps in tens, so there is room to slot an account in later', () => {
    expect(suggestAccountCode(existing(['6000', '6010']), 'expense')).toBe('6020');
  });
});
