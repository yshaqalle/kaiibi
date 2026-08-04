import { hasMultipleLocations, primaryLocationOf, resolveActiveLocation } from '@/lib/location-selection';
import type { ShopLocation } from '@/types/models';

function location(overrides: Partial<ShopLocation> & { id: string }): ShopLocation {
  return {
    shopId: 'shop-1',
    name: overrides.id,
    code: null,
    city: null,
    neighborhood: null,
    address: null,
    contactPhone: null,
    openingHours: {},
    monthlyRevenueGoalCents: null,
    isPrimary: false,
    active: true,
    createdAt: '2026-08-04T00:00:00Z',
    updatedAt: '2026-08-04T00:00:00Z',
    ...overrides,
  };
}

const main = location({ id: 'main', isPrimary: true });
const airport = location({ id: 'airport' });
const closed = location({ id: 'closed', active: false });

describe('primaryLocationOf', () => {
  it('returns the primary location', () => {
    expect(primaryLocationOf([airport, main])?.id).toBe('main');
  });

  it('falls back to the first active location when none is flagged primary', () => {
    expect(primaryLocationOf([airport, location({ id: 'other' })])?.id).toBe('airport');
  });

  it('ignores inactive locations while an active one exists', () => {
    expect(primaryLocationOf([closed, airport])?.id).toBe('airport');
  });

  // A shop that deactivated every branch must still resolve to something --
  // otherwise a signed-in owner can't reach Settings to reopen one.
  it('falls back to an inactive location when nothing is active', () => {
    expect(primaryLocationOf([closed])?.id).toBe('closed');
  });

  it('returns null only when there are no locations at all', () => {
    expect(primaryLocationOf([])).toBeNull();
  });
});

describe('resolveActiveLocation', () => {
  it('prefers the remembered location over the primary', () => {
    expect(resolveActiveLocation([main, airport], 'airport')?.id).toBe('airport');
  });

  it('falls back to the primary when nothing is remembered', () => {
    expect(resolveActiveLocation([main, airport], null)?.id).toBe('main');
  });

  it('falls back to the primary when the remembered location no longer exists', () => {
    expect(resolveActiveLocation([main, airport], 'deleted')?.id).toBe('main');
  });

  // The regression this guards: a register left pointing at a branch that has
  // since closed would otherwise keep ringing sales into it forever, because
  // the device never revisits its stored choice on its own.
  it('ignores a remembered location that has been deactivated', () => {
    expect(resolveActiveLocation([main, closed], 'closed')?.id).toBe('main');
  });
});

describe('hasMultipleLocations', () => {
  it('is false for the single-location shop that is the norm', () => {
    expect(hasMultipleLocations([main])).toBe(false);
  });

  it('is false when the only other location is closed', () => {
    expect(hasMultipleLocations([main, closed])).toBe(false);
  });

  it('is true once a second branch is open', () => {
    expect(hasMultipleLocations([main, airport])).toBe(true);
  });
});
