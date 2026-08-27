import { supabase } from '@/lib/supabase';

// The fixed-asset register, as the database returns it.
//
// NOTHING HERE DECIDES ANYTHING. Accumulated depreciation, net book value and
// every total come from list_fixed_assets() and fixed_asset_summary()
// (20261007000000); this module names the columns in camelCase and coerces the
// bigints. It performs no arithmetic at all -- not a subtotal, not a
// subtraction, not a re-sort. The same split lib/statements.ts draws, and for
// the same reason: two derivations of one figure agree until they don't, and
// then nobody can say which screen is right.
//
// The four write doors gate on ledger.post in the database and this module does
// not check anything: the screen hides what a reader cannot press, and the
// database refuses what reaches it anyway. A check here would be a third
// opinion.

export type FixedAsset = {
  id: string;
  name: string;
  accountCode: string;
  /** The shop's OWN name for that account. Null if the code is not in its chart. */
  accountName: string | null;
  acquiredOn: string;
  lifeMonths: number;
  costCents: number;
  accumulatedCents: number;
  /**
   * NULL once the asset has been disposed of, and that is not a zero.
   *
   * A sold asset is off the balance sheet entirely -- its cost credited out of
   * its 15xx account at full cost, its depreciation debited out of 1590 -- so
   * it has no book value rather than a book value of nothing. Kept nullable all
   * the way to the cell that renders it, which draws an em dash.
   */
  netBookCents: number | null;
  monthsCharged: number;
  disposedOn: string | null;
  disposalProceedsCents: number | null;
  /**
   * The status of the entry that bought the asset: 'posted', 'reversed',
   * 'draft' or 'none'.
   *
   * Anything but 'posted' means the asset is in this register and NOT in the
   * shop's 15xx account, so its cost is in no statement. reverse_journal_entry
   * is a generic door that can do this to any entry and knows nothing about the
   * register.
   */
  acquisitionStatus: string;
};

export type FixedAssetSummary = {
  liveCount: number;
  disposedCount: number;
  /** Live assets only, so all three tie to the balance sheet's fixed-asset section. */
  costCents: number;
  accumulatedCents: number;
  netBookCents: number;
  /** Live assets whose purchase entry has been voided. The one legitimate divergence. */
  voidedCount: number;
  voidedCostCents: number;
  /** The most recent depreciation POSTED — never a prediction of the next one. */
  lastChargeMonth: string | null;
  lastChargeCents: number;
};

// bigint arrives as a STRING over PostgREST, so a bare `+` on one would
// concatenate rather than add. Null passes through: see netBookCents.
function cents(value: unknown): number {
  return Number(value ?? 0);
}

export async function listFixedAssets(shopId: string): Promise<FixedAsset[]> {
  const { data, error } = await supabase.rpc('list_fixed_assets', { p_shop_id: shopId });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    name: row.name,
    accountCode: row.account_code,
    accountName: row.account_name ?? null,
    acquiredOn: row.acquired_on,
    lifeMonths: Number(row.life_months ?? 0),
    costCents: cents(row.cost_cents),
    accumulatedCents: cents(row.accumulated_cents),
    // `?? null` and NOT `cents()`: Number(null) is 0, which would turn "this
    // asset is off the books" into "this asset is worth nothing" at the last
    // step, after the database went to the trouble of saying null.
    netBookCents: row.net_book_cents === null || row.net_book_cents === undefined ? null : cents(row.net_book_cents),
    monthsCharged: Number(row.months_charged ?? 0),
    disposedOn: row.disposed_on ?? null,
    disposalProceedsCents:
      row.disposal_proceeds_cents === null || row.disposal_proceeds_cents === undefined
        ? null
        : cents(row.disposal_proceeds_cents),
    acquisitionStatus: row.acquisition_status,
  }));
}

/**
 * The register's totals. Returns null only when the function answered no row at
 * all, which it does not do — a shop with no assets still gets a row of zeroes.
 */
export async function getFixedAssetSummary(shopId: string): Promise<FixedAssetSummary> {
  const { data, error } = await supabase.rpc('fixed_asset_summary', { p_shop_id: shopId });
  if (error) throw error;
  // A `returns table` function comes back as an array even at one row.
  const row = (Array.isArray(data) ? data[0] : data) ?? {};
  return {
    liveCount: Number(row.live_count ?? 0),
    disposedCount: Number(row.disposed_count ?? 0),
    costCents: cents(row.cost_cents),
    accumulatedCents: cents(row.accumulated_cents),
    netBookCents: cents(row.net_book_cents),
    voidedCount: Number(row.voided_count ?? 0),
    voidedCostCents: cents(row.voided_cost_cents),
    lastChargeMonth: row.last_charge_month ?? null,
    lastChargeCents: cents(row.last_charge_cents),
  };
}

export type NewFixedAssetInput = {
  name: string;
  costCents: number;
  acquiredOn: string;
  lifeMonths: number;
  /**
   * NULL MEANS ON CREDIT, and it is not a missing value.
   *
   * create_fixed_asset credits 2000 Accounts Payable when nothing was paid
   * from, which is the honest reading of "no payment was recorded". Defaulting
   * it to '1000' here would take money out of a till that never opened, and the
   * entry would balance either way.
   */
  paidFromCode: string | null;
  accountCode: string;
};

export async function createFixedAsset(shopId: string, input: NewFixedAssetInput): Promise<string> {
  const { data, error } = await supabase.rpc('create_fixed_asset', {
    p_shop_id: shopId,
    p_name: input.name,
    p_cost_cents: input.costCents,
    p_acquired_on: input.acquiredOn,
    p_life_months: input.lifeMonths,
    p_paid_from_code: input.paidFromCode,
    p_account_code: input.accountCode,
  });
  if (error) throw error;
  return data as string;
}

export async function disposeFixedAsset(
  assetId: string,
  on: string,
  proceedsCents: number,
  receivedIntoCode: string
): Promise<string> {
  const { data, error } = await supabase.rpc('dispose_fixed_asset', {
    p_asset_id: assetId,
    p_on: on,
    p_proceeds_cents: proceedsCents,
    p_received_into_code: receivedIntoCode,
  });
  if (error) throw error;
  return data as string;
}

/**
 * Removes an asset entered in error and reverses its acquisition entry in the
 * same breath. Refuses once the asset has been depreciated or disposed of, with
 * a sentence saying to dispose of it instead — printed as it arrives.
 *
 * Returns the reversal entry id, or null when the asset posted nothing to
 * reverse.
 */
export async function deleteFixedAsset(assetId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('delete_fixed_asset', { p_asset_id: assetId });
  if (error) throw error;
  return (data as string | null) ?? null;
}

/**
 * Posts straight-line depreciation up to the last COMPLETE month and returns
 * how many monthly entries it wrote. Running it twice writes nothing the second
 * time and returns 0 — guaranteed by a unique constraint, not by a check.
 *
 * No `through` argument is offered. run_depreciation clamps whatever it is
 * given to the last complete month, so every value a screen could sensibly pass
 * means the same thing, and a date field on the button would imply a choice
 * that does not exist.
 */
export async function runDepreciation(shopId: string): Promise<number> {
  const { data, error } = await supabase.rpc('run_depreciation', { p_shop_id: shopId, p_through: null });
  if (error) throw error;
  return Number(data ?? 0);
}
