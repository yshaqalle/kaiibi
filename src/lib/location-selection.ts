import type { ShopLocation } from '@/types/models';

// Choosing which location a session operates at, as pure functions over
// already-fetched rows.
//
// Deliberately separate from `locations.ts`, which imports the Supabase client
// and so can't load under Jest -- the same split as expense-reporting.ts beside
// expenses.ts. This logic decides where a sale gets recorded, so it is exactly
// the kind of thing that has to be unit-tested without mocking.

// Where a device lands when it has no remembered choice. Falls back to the
// first location rather than null: the migration guarantees every shop has one,
// and a null would mean the POS refuses to sell.
//
// Inactive locations are only considered when there is nothing else -- a shop
// that deactivated every branch should still resolve to something, since the
// alternative is a signed-in owner who can't reach Settings to fix it.
export function primaryLocationOf(locations: readonly ShopLocation[]): ShopLocation | null {
  const active = locations.filter((location) => location.active);
  const pool = active.length > 0 ? active : locations;
  return pool.find((location) => location.isPrimary) ?? pool[0] ?? null;
}

// The location a session should open at: whichever this device last chose, if
// it still exists and is still active, otherwise the primary.
//
// A remembered id that has since been deactivated must NOT win. Without that
// check, a register at a closed branch would keep ringing sales into it
// indefinitely, because the device never revisits the choice on its own.
export function resolveActiveLocation(
  locations: readonly ShopLocation[],
  rememberedId: string | null
): ShopLocation | null {
  const remembered = rememberedId
    ? locations.find((location) => location.id === rememberedId && location.active)
    : undefined;
  return remembered ?? primaryLocationOf(locations);
}

// Whether the UI should offer a choice at all. A shop with one location must
// see no switcher, no location column and no picker -- the whole feature stays
// invisible until a second branch exists, which is what keeps this change from
// being a tax on the single-store shops that are the norm.
export function hasMultipleLocations(locations: readonly ShopLocation[]): boolean {
  return locations.filter((location) => location.active).length > 1;
}
