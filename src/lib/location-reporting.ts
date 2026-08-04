// Scoping money to a store.
//
// Pure, and deliberately separate from the four reporting modules it serves:
// they already take already-fetched rows and return numbers, so the store
// dimension belongs alongside them as another pure filter rather than inside
// each one. Same reasoning as expense-reporting.ts sitting apart from
// expenses.ts — this decides what lands in a P&L, so it has to be testable
// without a database.

// A row that may or may not belong to a store. `null` means business-wide —
// head-office costs, a licence covering every store, group marketing. It is a
// real value, not a missing one (migration 20260816000000).
type MaybeAtStore = { locationId: string | null };

// What a per-store view should count. Business-wide rows are EXCLUDED, not
// spread across stores: apportioning a licence fee between three stores would
// invent a split nobody chose, and any rule for doing it (evenly? by revenue?)
// is a business decision this code has no standing to make.
//
// The consequence is deliberate and worth stating: the per-store figures do not
// sum to the business figure. The difference is the unattributed overhead,
// which `businessWideOnly` below exists to show rather than hide.
export function atLocation<T extends MaybeAtStore>(rows: readonly T[], locationId: string): T[] {
  return rows.filter((row) => row.locationId === locationId);
}

// Costs that belong to no single store. Shown as its own line so the gap
// between "the stores' costs" and "the business's costs" is visible and
// accounted for, rather than looking like rows went missing.
export function businessWideOnly<T extends MaybeAtStore>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.locationId === null);
}

// Scopes a set of rows for a view. `null` means the combined business view,
// which includes everything — that is what every screen showed before stores
// existed, so it stays the default and nothing changes for a single-store shop.
export function scopeToLocation<T extends MaybeAtStore>(
  rows: readonly T[],
  locationId: string | null
): T[] {
  return locationId === null ? [...rows] : atLocation(rows, locationId);
}

// Splits rows by store in one pass, for a breakdown table. Business-wide rows
// are returned separately rather than under a pseudo-key, so a caller cannot
// accidentally render them as though they belonged to a store.
export function groupByLocation<T extends MaybeAtStore>(
  rows: readonly T[]
): { byLocation: Map<string, T[]>; businessWide: T[] } {
  const byLocation = new Map<string, T[]>();
  const businessWide: T[] = [];
  for (const row of rows) {
    if (row.locationId === null) {
      businessWide.push(row);
      continue;
    }
    const existing = byLocation.get(row.locationId);
    if (existing) existing.push(row);
    else byLocation.set(row.locationId, [row]);
  }
  return { byLocation, businessWide };
}
