import { atLocation, businessWideOnly, groupByLocation, scopeToLocation } from '@/lib/location-reporting';

// These decide what lands in a P&L, so the cases that matter are the ones where
// a cost belongs to no single store — the licence, the accountant, the campaign
// for the whole business. Getting those wrong either inflates one store's costs
// or loses them entirely.

type Row = { id: string; locationId: string | null; amountCents: number };

const rows: Row[] = [
  { id: 'rent-hargeisa', locationId: 'loc-a', amountCents: 500 },
  { id: 'power-hargeisa', locationId: 'loc-a', amountCents: 100 },
  { id: 'rent-berbera', locationId: 'loc-b', amountCents: 400 },
  { id: 'annual-licence', locationId: null, amountCents: 900 },
];

describe('atLocation', () => {
  it("returns only that store's rows", () => {
    expect(atLocation(rows, 'loc-a').map((r) => r.id)).toEqual(['rent-hargeisa', 'power-hargeisa']);
  });

  // The load-bearing case: a per-store P&L must not silently absorb a cost that
  // belongs to the whole business, or that store looks less profitable than it is.
  it('excludes business-wide rows', () => {
    expect(atLocation(rows, 'loc-a').some((r) => r.locationId === null)).toBe(false);
  });

  it('is empty for a store with nothing recorded', () => {
    expect(atLocation(rows, 'loc-unknown')).toEqual([]);
  });
});

describe('businessWideOnly', () => {
  it('returns exactly the unattributed rows', () => {
    expect(businessWideOnly(rows).map((r) => r.id)).toEqual(['annual-licence']);
  });
});

describe('scopeToLocation', () => {
  // Null is the combined view every screen showed before stores existed, so a
  // single-store shop sees no change.
  it('includes everything when unscoped', () => {
    expect(scopeToLocation(rows, null)).toHaveLength(4);
  });

  it('narrows to one store when scoped', () => {
    expect(scopeToLocation(rows, 'loc-b').map((r) => r.id)).toEqual(['rent-berbera']);
  });

  it('does not mutate or alias the input', () => {
    const scoped = scopeToLocation(rows, null);
    scoped.pop();
    expect(rows).toHaveLength(4);
  });
});

describe('groupByLocation', () => {
  it('splits stores apart and keeps business-wide separate', () => {
    const { byLocation, businessWide } = groupByLocation(rows);
    expect([...byLocation.keys()].sort()).toEqual(['loc-a', 'loc-b']);
    expect(byLocation.get('loc-a')).toHaveLength(2);
    expect(businessWide.map((r) => r.id)).toEqual(['annual-licence']);
  });

  // The stated consequence of not apportioning: per-store totals deliberately
  // fall short of the business total, and the gap IS the unattributed overhead.
  it('leaves per-store totals short of the business total by exactly the unattributed amount', () => {
    const { byLocation, businessWide } = groupByLocation(rows);
    const perStore = [...byLocation.values()].flat().reduce((sum, r) => sum + r.amountCents, 0);
    const unattributed = businessWide.reduce((sum, r) => sum + r.amountCents, 0);
    const businessTotal = rows.reduce((sum, r) => sum + r.amountCents, 0);
    expect(perStore).toBe(1000);
    expect(unattributed).toBe(900);
    expect(perStore + unattributed).toBe(businessTotal);
  });

  it('handles an empty set', () => {
    const { byLocation, businessWide } = groupByLocation([]);
    expect(byLocation.size).toBe(0);
    expect(businessWide).toEqual([]);
  });
});
