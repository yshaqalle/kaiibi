import {
  accumulatedDepreciationCents,
  assetRegister,
  assetRegisterTotals,
  bookValueCents,
  depreciationForPeriodCents,
  monthsElapsed,
  periodDepreciationCents,
  periodDisposalResultCents,
} from '@/lib/asset-depreciation';
import type { FixedAsset } from '@/types/models';

// Nothing stores a depreciation figure, so these functions ARE the numbers on
// the balance sheet, the asset register and the P&L. A bug here is not a stale
// figure somewhere — it is the wrong figure in three places at once.

function asset(overrides: Partial<FixedAsset> = {}): FixedAsset {
  return {
    id: 'asset-1',
    shopId: 'shop',
    locationId: null,
    name: 'Display fridge',
    category: 'equipment',
    acquiredOn: '2026-01-15',
    costCents: 300_000,
    salvageValueCents: 0,
    usefulLifeMonths: 60,
    vendorId: null,
    vendorName: null,
    reference: null,
    notes: null,
    disposedOn: null,
    disposalProceedsCents: null,
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('monthsElapsed', () => {
  it('counts from the month after acquisition, so the month of purchase is free', () => {
    expect(monthsElapsed('2026-01-15', '2026-01-31', 60)).toBe(0);
    expect(monthsElapsed('2026-01-15', '2026-02-01', 60)).toBe(1);
  });

  it('does not care which day of the month either date falls on', () => {
    // The whole point of counting whole months: a fridge delivered on the 31st
    // must not claim a full month of wear the next day.
    expect(monthsElapsed('2026-01-01', '2026-04-30', 60)).toBe(3);
    expect(monthsElapsed('2026-01-31', '2026-04-01', 60)).toBe(3);
  });

  it('is capped at the asset’s life, so a fully written-down asset stops', () => {
    expect(monthsElapsed('2020-01-01', '2026-01-01', 60)).toBe(60);
  });

  it('is never negative for a date before the asset existed', () => {
    expect(monthsElapsed('2026-06-01', '2026-01-01', 60)).toBe(0);
  });

  it('returns zero rather than throwing on a malformed date', () => {
    // A register that refuses to render is a worse way to report a data
    // problem than one showing an asset at full cost.
    expect(monthsElapsed('not-a-date', '2026-06-01', 60)).toBe(0);
  });
});

describe('accumulatedDepreciationCents', () => {
  it('spreads cost evenly over the life', () => {
    // $3,000 over 60 months is $50/month; 12 months in is $600.
    expect(accumulatedDepreciationCents(asset(), '2027-01-15')).toBe(60_000);
  });

  it('leaves the salvage value behind', () => {
    // ($3,000 − $600) over 60 months is $40/month.
    const van = asset({ salvageValueCents: 60_000 });
    expect(accumulatedDepreciationCents(van, '2027-01-15')).toBe(48_000);
  });

  it('never writes an asset below its salvage value', () => {
    const van = asset({ salvageValueCents: 60_000 });
    expect(accumulatedDepreciationCents(van, '2099-01-01')).toBe(240_000);
    expect(bookValueCents(van, '2099-01-01')).toBe(60_000);
  });

  it('rounds once at the end, so the months always sum to the whole', () => {
    // A cost that does not divide evenly: 100 cents over 3 months. Rounding a
    // monthly 33.33 and multiplying would land on 99 and leave a cent adrift.
    const odd = asset({ costCents: 100, usefulLifeMonths: 3, acquiredOn: '2026-01-01' });
    expect(accumulatedDepreciationCents(odd, '2026-02-01')).toBe(33);
    expect(accumulatedDepreciationCents(odd, '2026-03-01')).toBe(67);
    expect(accumulatedDepreciationCents(odd, '2026-04-01')).toBe(100);
  });

  it('stops on disposal, whatever today’s date is', () => {
    const sold = asset({ disposedOn: '2026-07-15' });
    // Six months of wear, and no more, however long ago that was.
    expect(accumulatedDepreciationCents(sold, '2027-06-01')).toBe(30_000);
  });
});

describe('depreciationForPeriodCents', () => {
  it('is the difference between each end, not a monthly rate times months', () => {
    // The asset was bought mid-window, so it has taken only part of it.
    expect(depreciationForPeriodCents(asset(), '2026-01-01', '2026-04-01')).toBe(15_000);
  });

  it('consecutive periods sum to the whole', () => {
    const first = depreciationForPeriodCents(asset(), '2026-01-01', '2026-07-01');
    const second = depreciationForPeriodCents(asset(), '2026-07-01', '2027-01-01');
    expect(first + second).toBe(accumulatedDepreciationCents(asset(), '2027-01-01'));
  });

  it('charges nothing once the asset is fully written down', () => {
    expect(depreciationForPeriodCents(asset(), '2032-01-01', '2032-12-01')).toBe(0);
  });
});

describe('assetRegisterTotals', () => {
  it('drops a disposed asset from BOTH the cost and the depreciation line', () => {
    // The whole reason a disposal needs no journal entry: the two sides leave
    // together, so the balance sheet stays balanced without anything posted.
    const rows = assetRegister(
      [asset(), asset({ id: 'asset-2', costCents: 100_000, disposedOn: '2026-05-01' })],
      '2027-01-15'
    );
    const totals = assetRegisterTotals(rows);
    expect(totals.costCents).toBe(300_000);
    expect(totals.accumulatedCents).toBe(60_000);
    expect(totals.bookValueCents).toBe(240_000);
    expect(totals.liveCount).toBe(1);
    expect(totals.disposedCount).toBe(1);
  });
});

describe('periodDepreciationCents', () => {
  it('adds up every asset’s charge for the window', () => {
    const assets = [asset(), asset({ id: 'asset-2', costCents: 120_000, usefulLifeMonths: 12 })];
    // $50/month plus $100/month, over three months.
    expect(periodDepreciationCents(assets, '2026-01-01', '2026-04-01')).toBe(45_000);
  });
});

describe('periodDisposalResultCents', () => {
  it('is positive when an asset fetched more than it was still worth', () => {
    // Six months of wear on a $3,000 fridge is $300, so book value is $2,700.
    const sold = asset({ disposedOn: '2026-07-15', disposalProceedsCents: 280_000 });
    expect(periodDisposalResultCents([sold], '2026-07-01', '2026-07-31')).toBe(10_000);
  });

  it('is negative when it fetched less', () => {
    const scrapped = asset({ disposedOn: '2026-07-15', disposalProceedsCents: 0 });
    expect(periodDisposalResultCents([scrapped], '2026-07-01', '2026-07-31')).toBe(-270_000);
  });

  it('only counts disposals inside the window', () => {
    // A one-off reported every period afterwards would look like a trend
    // nobody could find the cause of.
    const sold = asset({ disposedOn: '2026-07-15', disposalProceedsCents: 280_000 });
    expect(periodDisposalResultCents([sold], '2026-08-01', '2026-08-31')).toBe(0);
  });
});
