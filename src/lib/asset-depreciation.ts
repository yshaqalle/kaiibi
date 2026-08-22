import type { FixedAsset, FixedAssetCategory } from '@/types/models';

// Straight-line depreciation, and the register roll-ups built on it.
//
// Pure and free of the Supabase client on purpose (see chart-of-accounts.ts
// for the reasoning) — but here the reason is sharper. Nothing stores an
// asset's depreciation: the balance sheet, the asset register and the P&L all
// call these functions, so a bug here is not a stale figure somewhere, it is
// the wrong figure everywhere at once. These are the functions with the
// tightest tests in Accounting.

export const FIXED_ASSET_CATEGORIES: { key: FixedAssetCategory; label: string }[] = [
  { key: 'equipment', label: 'Equipment' },
  { key: 'furniture', label: 'Furniture' },
  { key: 'fittings', label: 'Fittings' },
  { key: 'vehicle', label: 'Vehicle' },
  { key: 'technology', label: 'Technology' },
  { key: 'building', label: 'Building' },
  { key: 'other', label: 'Other' },
];

const CATEGORY_LABELS = new Map(FIXED_ASSET_CATEGORIES.map((c) => [c.key, c.label]));

export function assetCategoryLabel(category: FixedAssetCategory): string {
  return CATEGORY_LABELS.get(category) ?? category;
}

// A date column ('2026-08-21') as whole months since year zero, which is all
// the arithmetic below needs and is immune to the two things that break date
// maths here: a timezone shifting a date column across midnight, and February.
//
// Parsed by hand rather than through `new Date(iso)`. That constructor reads a
// bare date as UTC midnight, so a shop east of Greenwich gets the previous
// month back from `getMonth()` — an asset acquired on the 1st would depreciate
// a month early, every month, for its whole life.
function monthIndex(dateColumn: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateColumn.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return year * 12 + (month - 1);
}

/**
 * Whole months of wear an asset has taken by `asOf`, capped at its life.
 *
 * Counted from the month AFTER acquisition — the convention a small business's
 * accountant expects, and the one that stops a fridge delivered on the 31st
 * claiming a full month of use. Mirrors `asset_months_elapsed` in
 * supabase/migrations/20260902000300_fixed_assets.sql.
 *
 * Returns 0 for an unparseable date rather than throwing: a malformed column
 * is a data problem, and a register that refuses to render is a worse way to
 * report one than a register showing an asset at full cost.
 */
export function monthsElapsed(acquiredOn: string, asOf: string, usefulLifeMonths: number): number {
  const from = monthIndex(acquiredOn);
  const to = monthIndex(asOf);
  if (from === null || to === null) return 0;
  return Math.max(0, Math.min(usefulLifeMonths, to - from));
}

/**
 * What the asset has depreciated by `asOf`, in cents.
 *
 * Cost less salvage, spread evenly, rounded ONCE at the end. Rounding a
 * monthly figure and multiplying it leaves the final month short by up to a
 * cent per month of life — on a five-year asset that is a 60-cent hole in the
 * balance sheet that nothing else will ever explain.
 *
 * Depreciation stops on disposal: an asset sold in March has taken March's
 * wear and no more, whatever today's date is.
 */
export function accumulatedDepreciationCents(asset: FixedAsset, asOf: string): number {
  const until = asset.disposedOn && asset.disposedOn < asOf ? asset.disposedOn : asOf;
  const months = monthsElapsed(asset.acquiredOn, until, asset.usefulLifeMonths);
  const depreciable = asset.costCents - asset.salvageValueCents;
  return Math.round((depreciable * months) / asset.usefulLifeMonths);
}

/** What the asset is still worth on the books: cost less depreciation to date. */
export function bookValueCents(asset: FixedAsset, asOf: string): number {
  return asset.costCents - accumulatedDepreciationCents(asset, asOf);
}

/**
 * The charge that falls in a period — what the P&L's depreciation line is.
 *
 * The difference between accumulated depreciation at each end, rather than
 * `monthly × months`. The two agree in the middle of an asset's life and
 * disagree at both ends, and the difference is the right answer: an asset
 * acquired mid-period has taken only part of the period's wear, and one that
 * finished depreciating mid-period takes none of the rest.
 *
 * `since` is exclusive of its own prior wear and `until` inclusive, so
 * consecutive periods sum exactly to the whole.
 */
export function depreciationForPeriodCents(asset: FixedAsset, since: string, until: string): number {
  const opening = accumulatedDepreciationCents(asset, since);
  const closing = accumulatedDepreciationCents(asset, until);
  return Math.max(0, closing - opening);
}

export type AssetRegisterRow = {
  asset: FixedAsset;
  accumulatedCents: number;
  bookValueCents: number;
  /** Whole months left before it is fully written down. Zero once it is. */
  monthsRemaining: number;
  /** Sold, scrapped or written off on or before the reporting date. */
  disposed: boolean;
  /**
   * Proceeds less book value at disposal. Positive is a gain, negative a loss,
   * null while the asset is still held. Signed rather than split into two
   * fields, because the same disposal would otherwise appear on a different
   * line depending on which way it went.
   */
  disposalResultCents: number | null;
};

export function assetRegister(assets: FixedAsset[], asOf: string): AssetRegisterRow[] {
  return assets.map((asset) => {
    const accumulatedCents = accumulatedDepreciationCents(asset, asOf);
    const disposed = asset.disposedOn !== null && asset.disposedOn <= asOf;
    return {
      asset,
      accumulatedCents,
      bookValueCents: asset.costCents - accumulatedCents,
      monthsRemaining: Math.max(
        0,
        asset.usefulLifeMonths - monthsElapsed(asset.acquiredOn, asset.disposedOn ?? asOf, asset.usefulLifeMonths)
      ),
      disposed,
      disposalResultCents: disposed
        ? (asset.disposalProceedsCents ?? 0) - (asset.costCents - accumulatedCents)
        : null,
    };
  });
}

export type AssetRegisterTotals = {
  /** Assets still held, at what they cost. */
  costCents: number;
  /** Depreciation charged against those assets to date. */
  accumulatedCents: number;
  /** Cost less depreciation — what the balance sheet carries them at. */
  bookValueCents: number;
  liveCount: number;
  disposedCount: number;
};

/**
 * The register's contribution to the balance sheet.
 *
 * Disposed assets are excluded from all three figures. That is the whole
 * reason a disposal needs no journal entry: the moment an asset is marked
 * disposed it stops being reported, on both the cost line and the
 * accumulated-depreciation line, in step — see
 * supabase/migrations/20260902000400_cash_transfers.sql for the same argument
 * made about transfers.
 */
export function assetRegisterTotals(rows: AssetRegisterRow[]): AssetRegisterTotals {
  let costCents = 0;
  let accumulatedCents = 0;
  let liveCount = 0;
  let disposedCount = 0;
  for (const row of rows) {
    if (row.disposed) {
      disposedCount += 1;
      continue;
    }
    liveCount += 1;
    costCents += row.asset.costCents;
    accumulatedCents += row.accumulatedCents;
  }
  return { costCents, accumulatedCents, bookValueCents: costCents - accumulatedCents, liveCount, disposedCount };
}

/** Total depreciation across the register for one period — the P&L's line. */
export function periodDepreciationCents(assets: FixedAsset[], since: string, until: string): number {
  return assets.reduce((sum, asset) => sum + depreciationForPeriodCents(asset, since, until), 0);
}

/**
 * Gains and losses realised in a period, netted.
 *
 * Only disposals dated inside the window count. An asset sold last year has
 * already had its result reported, and reporting it again every period is how a
 * one-off becomes a trend nobody can find the cause of.
 */
export function periodDisposalResultCents(assets: FixedAsset[], since: string, until: string): number {
  return assets.reduce((sum, asset) => {
    if (!asset.disposedOn || asset.disposedOn < since || asset.disposedOn > until) return sum;
    const book = asset.costCents - accumulatedDepreciationCents(asset, asset.disposedOn);
    return sum + ((asset.disposalProceedsCents ?? 0) - book);
  }, 0);
}
