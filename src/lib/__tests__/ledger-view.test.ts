import { accountingEquation, draftDifferenceCents, draftToLines, entryDateLabel, groupAccountsByType } from '@/lib/ledger-view';
import type { Account } from '@/types/models';

const acct = (id: string, code: string, type: Account['type'], isContra = false): Account => ({
  id, shopId: 'shop', code, name: `Account ${code}`, type, isContra, archivedAt: null,
});

describe('groupAccountsByType', () => {
  const accounts = [
    acct('a', '1000', 'asset'),
    acct('b', '2000', 'liability'),
    acct('c', '3000', 'equity'),
    acct('d', '1590', 'asset', true),
  ];

  it('returns the six sections in statement order, not alphabetical', () => {
    const groups = groupAccountsByType(accounts, []);
    expect(groups.map((g) => g.type)).toEqual([
      'asset', 'liability', 'equity', 'revenue', 'cost_of_sales', 'expense',
    ]);
  });

  it('subtotals each section from the posted lines', () => {
    const groups = groupAccountsByType(accounts, [
      { accountId: 'a', amountCents: 500000 },
      { accountId: 'b', amountCents: -300000 },
    ]);
    expect(groups.find((g) => g.type === 'asset')?.subtotalCents).toBe(500000);
    // Liabilities carry credit balances. The section subtotal is reported as a
    // POSITIVE figure, because "you owe 3,000" is the sentence, not "-3,000".
    expect(groups.find((g) => g.type === 'liability')?.subtotalCents).toBe(300000);
  });

  it('nets a contra account against its own section rather than giving it one', () => {
    const groups = groupAccountsByType(accounts, [
      { accountId: 'a', amountCents: 500000 },
      { accountId: 'd', amountCents: -80000 },
    ]);
    expect(groups.find((g) => g.type === 'asset')?.subtotalCents).toBe(420000);
    expect(groups.map((g) => g.type)).not.toContain('contra');
  });
});

describe('accountingEquation', () => {
  it('is satisfied when assets equal liabilities plus equity', () => {
    const accounts = [acct('a', '1000', 'asset'), acct('b', '2000', 'liability'), acct('c', '3000', 'equity')];
    const eq = accountingEquation(groupAccountsByType(accounts, [
      { accountId: 'a', amountCents: 900000 },
      { accountId: 'b', amountCents: -400000 },
      { accountId: 'c', amountCents: -500000 },
    ]));
    expect(eq).toMatchObject({ assetsCents: 900000, liabilitiesCents: 400000, equityCents: 500000, differenceCents: 0 });
  });

  it('reports the gap when they do not, rather than hiding it', () => {
    const accounts = [acct('a', '1000', 'asset'), acct('b', '2000', 'liability')];
    const eq = accountingEquation(groupAccountsByType(accounts, [
      { accountId: 'a', amountCents: 900000 },
      { accountId: 'b', amountCents: -400000 },
    ]));
    // 900000 assets against 400000 liabilities and no equity. Deliberately
    // asymmetric numbers: 500000 could not arise by accident from these.
    expect(eq.differenceCents).toBe(500000);
  });
});

describe('draftToLines', () => {
  it('turns a debit and a credit row into one signed amount each', () => {
    expect(draftToLines([
      { code: '5100', amountText: '840.00', isCredit: false },
      { code: '1200', amountText: '840.00', isCredit: true },
    ])).toEqual([
      { code: '5100', amountCents: 84000 },
      { code: '1200', amountCents: -84000 },
    ]);
  });

  it('drops rows with no account and rows with no amount, so a blank row is not an error', () => {
    expect(draftToLines([
      { code: '5100', amountText: '840.00', isCredit: false },
      { code: '', amountText: '', isCredit: false },
      { code: '1200', amountText: '', isCredit: true },
    ])).toEqual([{ code: '5100', amountCents: 84000 }]);
  });

  it('refuses an unreadable amount rather than treating it as zero', () => {
    expect(() => draftToLines([{ code: '5100', amountText: 'abc', isCredit: false }])).toThrow(/840|amount/i);
  });
});

describe('draftDifferenceCents', () => {
  it('is zero when the two sides match', () => {
    expect(draftDifferenceCents([
      { code: '5100', amountText: '840.00', isCredit: false },
      { code: '1200', amountText: '840.00', isCredit: true },
    ])).toBe(0);
  });

  it('reports the signed gap so the form can say which side is short', () => {
    expect(draftDifferenceCents([
      { code: '5100', amountText: '840.00', isCredit: false },
      { code: '1200', amountText: '100.00', isCredit: true },
    ])).toBe(74000);
  });

  it('treats an unreadable amount as zero rather than throwing while somebody types', () => {
    // draftToLines throws on save; this runs on every keystroke and must not.
    expect(draftDifferenceCents([{ code: '5100', amountText: 'ab', isCredit: false }])).toBe(0);
  });
});

describe('entryDateLabel', () => {
  it('renders a date column as the day it says, not the day before', () => {
    // `new Date('2026-08-23')` parses as UTC MIDNIGHT, so toLocaleDateString in
    // any western timezone renders "Aug 22". Every entry would read a day early
    // for every user west of Greenwich. period.ts documents this on
    // fromDateColumn; this pins it at the point the ledger screens format.
    // Compared against the LOCAL-time constructor rather than a hardcoded
    // string, so the test says "the same day this date names" instead of
    // pinning one locale's word order. The buggy version parses to the day
    // before, so this still distinguishes them.
    const local = (y: number, m: number, d: number) =>
      new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

    expect(entryDateLabel('2026-08-23')).toBe(local(2026, 8, 23));
    expect(entryDateLabel('2026-01-01')).toBe(local(2026, 1, 1));
    expect(entryDateLabel('2026-12-31')).toBe(local(2026, 12, 31));
  });

  it('is not the same as parsing the column with the Date constructor', () => {
    // The mutation guard. If entryDateLabel ever goes back to `new Date(col)`,
    // these two agree and the test above stops meaning anything.
    const naive = new Date('2026-08-23').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const correct = new Date(2026, 7, 23).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    // Only meaningful west of Greenwich; east of it the naive parse is right by
    // accident, so the assertion is skipped rather than made to lie.
    if (new Date().getTimezoneOffset() > 0) {
      expect(naive).not.toBe(correct);
      expect(entryDateLabel('2026-08-23')).toBe(correct);
    }
  });
});
