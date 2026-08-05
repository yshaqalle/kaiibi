import { profitAndLoss } from '@/lib/pnl';
import type { Expense, ExpenseCategory } from '@/types/models';

function expense(category: ExpenseCategory, amountCents: number): Expense {
  return {
    id: `${category}-${amountCents}`,
    shopId: 'shop',
    locationId: null,
    occurredOn: '2026-09-11',
    amountCents,
    category,
    vendorId: null,
    vendorName: null,
    paymentMethod: 'cash',
    note: null,
    invoiceId: null,
    payrollRunId: null,
    createdBy: null,
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
  } as Expense;
}

describe('profitAndLoss', () => {
  const expenses = [
    expense('salaries_wages', 52_000),
    expense('rent', 20_000),
    expense('utilities', 9_600),
    expense('supplies', 7_400),
    // Neither of these is an operating cost, but both are real cash out.
    expense('inventory_purchase', 42_200),
    expense('owner_draw', 10_000),
  ];

  it('takes only operating expenses off gross profit', () => {
    const pnl = profitAndLoss({ revenueCents: 384_720, cogsCents: 241_260, expenses });

    expect(pnl.grossProfitCents).toBe(143_460);
    // 52,000 + 20,000 + 9,600 + 7,400 -- stock and the draw are excluded.
    expect(pnl.postedOperatingCents).toBe(89_000);
    expect(pnl.netProfitCents).toBe(54_460);
  });

  it('reports stock purchases and owner draws separately rather than dropping them', () => {
    const pnl = profitAndLoss({ revenueCents: 384_720, cogsCents: 241_260, expenses });

    expect(pnl.nonOperatingCents).toBe(52_200);
    // The non-operating rows must not leak into the operating subtotal, or the
    // shop is charged for its stock twice -- once here and again as COGS.
    expect(pnl.postedOperatingCents + pnl.nonOperatingCents).toBe(141_200);
  });

  it('charges accrued wages to the period they were worked in', () => {
    const withoutAccrual = profitAndLoss({ revenueCents: 384_720, cogsCents: 241_260, expenses });
    const withAccrual = profitAndLoss({
      revenueCents: 384_720,
      cogsCents: 241_260,
      expenses,
      accruedLaborCents: 31_200,
    });

    expect(withAccrual.operatingCents - withoutAccrual.operatingCents).toBe(31_200);
    expect(withAccrual.netProfitCents).toBe(23_260);
    // The accrual has no expense row behind it, so it must not move this.
    expect(withAccrual.nonOperatingCents).toBe(withoutAccrual.nonOperatingCents);
  });

  it('states a loss as a negative rather than clamping it', () => {
    const pnl = profitAndLoss({ revenueCents: 40_650, cogsCents: 0, expenses: [expense('rent', 100_000)] });

    expect(pnl.netProfitCents).toBe(-59_350);
    expect(pnl.netMarginPct).toBe(-146);
  });

  it('has no margin to report when nothing sold', () => {
    const pnl = profitAndLoss({ revenueCents: 0, cogsCents: 0, expenses: [expense('rent', 20_000)] });

    // Not 0%: a shop that took nothing has no margin, and printing "0%" states
    // something false about a quiet day.
    expect(pnl.grossMarginPct).toBeNull();
    expect(pnl.netMarginPct).toBeNull();
    expect(pnl.netProfitCents).toBe(-20_000);
  });

  it('is unaffected by expense ordering', () => {
    const forwards = profitAndLoss({ revenueCents: 384_720, cogsCents: 241_260, expenses });
    const backwards = profitAndLoss({ revenueCents: 384_720, cogsCents: 241_260, expenses: [...expenses].reverse() });

    expect(backwards).toEqual(forwards);
  });
});
