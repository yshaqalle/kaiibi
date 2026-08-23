import { creditOf, debitOf, entryDifferenceCents, isBalanced, trialBalance } from '@/lib/ledger-math';
import type { Account } from '@/types/models';

const account = (code: string, type: Account['type'], id = code): Account => ({
  id,
  shopId: 'shop',
  code,
  name: code,
  type,
  isContra: false,
  archivedAt: null,
});

describe('debitOf / creditOf', () => {
  it('splits one signed amount into the two columns a reader expects', () => {
    expect(debitOf(84000)).toBe(84000);
    expect(creditOf(84000)).toBe(0);
    expect(debitOf(-84000)).toBe(0);
    expect(creditOf(-84000)).toBe(84000);
  });

  it('never reports the same amount in both columns', () => {
    for (const n of [-1, 1, -99999, 99999]) {
      expect(Math.min(debitOf(n), creditOf(n))).toBe(0);
    }
  });
});

describe('entryDifferenceCents', () => {
  it('is zero for a balanced entry', () => {
    expect(entryDifferenceCents([{ amountCents: 84000 }, { amountCents: -84000 }])).toBe(0);
    expect(isBalanced([{ amountCents: 84000 }, { amountCents: -84000 }])).toBe(true);
  });

  it('reports the signed gap so the UI can say which side is short', () => {
    expect(entryDifferenceCents([{ amountCents: 84000 }, { amountCents: -1 }])).toBe(83999);
    expect(entryDifferenceCents([{ amountCents: 1 }, { amountCents: -84000 }])).toBe(-83999);
    expect(isBalanced([{ amountCents: 84000 }, { amountCents: -1 }])).toBe(false);
  });

  it('treats a single line as unbalanced even when it sums to zero', () => {
    // An entry of one zero line sums to zero and is still not an entry. The
    // database refuses both, so a UI that called this balanced would offer a
    // Post button that fails.
    expect(isBalanced([{ amountCents: 0 }])).toBe(false);
    expect(isBalanced([])).toBe(false);
  });
});

describe('trialBalance', () => {
  const accounts = [account('1000', 'asset'), account('4000', 'revenue'), account('6000', 'expense')];

  it('puts each account on the side its balance falls', () => {
    const rows = trialBalance(accounts, [
      { accountId: '1000', amountCents: 500000 },
      { accountId: '4000', amountCents: -800000 },
      { accountId: '6000', amountCents: 300000 },
    ]);
    expect(rows.find((r) => r.code === '1000')).toMatchObject({ debitCents: 500000, creditCents: 0 });
    expect(rows.find((r) => r.code === '4000')).toMatchObject({ debitCents: 0, creditCents: 800000 });
    expect(rows.find((r) => r.code === '6000')).toMatchObject({ debitCents: 300000, creditCents: 0 });
  });

  it('nets multiple lines against one account before choosing a side', () => {
    const rows = trialBalance(accounts, [
      { accountId: '1000', amountCents: 500000 },
      { accountId: '1000', amountCents: -600000 },
    ]);
    // Overdrawn: an asset with a credit balance is a real thing and must not be
    // reported as a 100000 debit.
    expect(rows.find((r) => r.code === '1000')).toMatchObject({ debitCents: 0, creditCents: 100000 });
  });

  it('omits accounts with no movement, so the statement is readable', () => {
    const rows = trialBalance(accounts, [{ accountId: '1000', amountCents: 1 }, { accountId: '4000', amountCents: -1 }]);
    expect(rows.map((r) => r.code)).toEqual(['1000', '4000']);
  });

  it('omits an account whose lines cancel out, not just one never touched', () => {
    const rows = trialBalance(accounts, [
      { accountId: '6000', amountCents: 5000 },
      { accountId: '6000', amountCents: -5000 },
      { accountId: '1000', amountCents: 1 },
      { accountId: '4000', amountCents: -1 },
    ]);
    expect(rows.map((r) => r.code)).toEqual(['1000', '4000']);
  });

  it('sorts by code, because that is the order every accountant reads', () => {
    const rows = trialBalance(accounts, [
      { accountId: '6000', amountCents: 1 },
      { accountId: '1000', amountCents: 1 },
      { accountId: '4000', amountCents: -2 },
    ]);
    expect(rows.map((r) => r.code)).toEqual(['1000', '4000', '6000']);
  });

  it('totals to the same figure on both sides, which is what makes it a proof', () => {
    const rows = trialBalance(accounts, [
      { accountId: '1000', amountCents: 500000 },
      { accountId: '4000', amountCents: -800000 },
      { accountId: '6000', amountCents: 300000 },
    ]);
    const debits = rows.reduce((sum, r) => sum + r.debitCents, 0);
    const credits = rows.reduce((sum, r) => sum + r.creditCents, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(800000);
  });
});
