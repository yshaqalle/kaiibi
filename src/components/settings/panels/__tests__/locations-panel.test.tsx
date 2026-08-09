import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { LocationsPanel } from '@/components/settings/panels/locations-panel';
import type { ShopLocation } from '@/types/models';

jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ limitFor: () => null, usageOf: () => 0 }),
}));
// The panel imports the location CRUD helpers, which import the live client;
// the client throws at require time without env vars. Same stub as
// settings-nav.test.ts.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const store = (id: string, name: string): ShopLocation =>
  ({
    id,
    name,
    code: null,
    address: null,
    neighborhood: null,
    city: null,
    contactPhone: null,
    zaadMerchantId: null,
    edahabMerchantId: null,
    openingHours: {},
    monthlyRevenueGoalCents: null,
    barcodeScanningEnabled: true,
    hardwareScannerEnabled: false,
    requireOpenRegister: false,
    active: true,
    isPrimary: true,
  }) as ShopLocation;

function render(initialLocationId?: string, locations: ShopLocation[] = [store('loc-1', 'Hargeisa Main')]) {
  let tree: ReactTestRenderer | undefined;
  const el = (locs: ShopLocation[]) => (
    <LocationsPanel shopId="shop-1" locations={locs} onChange={jest.fn()} initialLocationId={initialLocationId} />
  );
  act(() => { tree = create(el(locations)); });
  return {
    tree: tree!,
    update: (locs: ShopLocation[]) => act(() => { tree!.update(el(locs)); }),
    texts: () => tree!.root.findAllByType(Text).map((t) => t.props.children),
  };
}

describe('LocationsPanel deep-link', () => {
  // The till notice sends the reader here to flip ONE switch in ONE store;
  // landing on the list and hunting for the row loses half of them.
  it('opens the editor for the store the URL names', () => {
    expect(render('loc-1').texts()).toContain('Edit store');
  });

  it('stays on the list when no store is named', () => {
    expect(render(undefined).texts()).not.toContain('Edit store');
  });

  it('stays on the list when the named store does not exist', () => {
    expect(render('loc-gone').texts()).not.toContain('Edit store');
  });

  // Settings loads locations async: the panel can mount with an empty list
  // and receive the rows a beat later. The editor must still open — once.
  it('opens once the named store arrives, and only once', () => {
    const r = render('loc-1', []);
    expect(r.texts()).not.toContain('Edit store');
    r.update([store('loc-1', 'Hargeisa Main')]);
    expect(r.texts()).toContain('Edit store');
  });
});
