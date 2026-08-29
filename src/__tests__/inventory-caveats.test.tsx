import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { Caveat } from '@/components/ui/caveat';

// Lives here rather than beside the screen ON PURPOSE. expo-router builds the
// route table from `require.context(src/app)` with an ignore list of exactly
// `+html` and `+api` (see node_modules/expo-router/_ctx.js) — nothing skips
// `__tests__` or `.test.tsx`. A test file under src/app would become a real
// route and ship inside the bundle.

// `mock`-prefixed because jest.mock() is hoisted above these declarations and
// babel-plugin-jest-hoist refuses a factory closing over anything else.
let mockLocations = [
  { id: 'loc-1', name: 'Jaalala 1', isPrimary: true, active: true },
  { id: 'loc-2', name: 'Jaalala 2', isPrimary: false, active: true },
];
const mockProducts = [
  {
    id: 'p-1',
    shopId: 'shop-1',
    name: 'Tea',
    description: null,
    sku: null,
    barcode: null,
    brand: null,
    category: null,
    tags: [],
    supplierName: null,
    // Costed, so the `wrong` uncosted caveat stays away and this suite is only
    // ever looking at the two `context` ones.
    costCents: 480,
    priceCents: 900,
    stock: 36,
    reorderLevel: null,
    shelfNumber: null,
    expiryDate: null,
    batchNumber: null,
    imageUrl: null,
    isListedOnline: false,
    locationStock: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    shop: { id: 'shop-1', defaultLowStockLevel: 5, expiryTrackingEnabled: false },
    can: () => true,
    // The screen's default export is wrapped in `withModuleWall` now, so the
    // module gate is on the way in -- this fixture is a paying shop.
    hasModule: () => true,
    locations: mockLocations,
    activeLocation: mockLocations[0],
    limitFor: () => null,
    usageOf: () => 0,
  }),
}));
jest.mock('@/lib/products', () => ({
  // Lazily, not `mockResolvedValue(mockProducts)`: the screen `import` below is
  // hoisted above these declarations, so the fixture is still uninitialised
  // when this factory runs and the screen would be handed `undefined`.
  listProducts: jest.fn(() => Promise.resolve(mockProducts)),
  createProduct: jest.fn(),
  findProductsByCode: jest.fn(),
  setLocationStock: jest.fn(),
  updateProduct: jest.fn(),
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: () => {},
}));

import InventoryScreen from '@/app/(admin)/(tabs)/inventory';

async function render(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<InventoryScreen />);
  });
  return tree!;
}

// The Stock at cost caveat, picked out of the stack by its opening clause
// rather than by index, so adding a fourth caveat cannot silently retarget
// these assertions at the wrong one.
async function costBasisCaveat() {
  const tree = await render();
  return tree.root
    .findAllByType(Caveat)
    .find((node) => String(node.props.children).startsWith('Stock is valued at weighted average cost'));
}

describe('Inventory — the Stock at cost basis caveat', () => {
  beforeEach(() => {
    mockLocations = [
      { id: 'loc-1', name: 'Jaalala 1', isPrimary: true, active: true },
      { id: 'loc-2', name: 'Jaalala 2', isPrimary: false, active: true },
    ];
  });

  // IAS 2.36(a) requires the cost formula to be disclosed wherever a stock
  // value is reported. This asserts the formula is NAMED, not merely that the
  // figure is qualified -- "weighted average" is the disclosure, and a caveat
  // that only said the number was approximate would not satisfy it.
  //
  // It asserted 'most recent price you paid' until
  // 20260907000000_moving_weighted_average.sql. That was an accurate
  // description of replacement cost, which is what the standard does not
  // permit; the arithmetic changed and this moved with it.
  it('names the cost formula, which is what IAS 2.36(a) asks for', async () => {
    const caveat = await costBasisCaveat();
    expect(caveat).toBeDefined();
    expect(String(caveat!.props.children)).toContain('weighted average cost');
    // The old basis must not still be claimed anywhere in the sentence.
    expect(String(caveat!.props.children)).not.toContain('most recent price you paid');
  });

  // The expensive half of the truth, and it survived the change to weighted
  // average: cost_cents is still shop-wide, so a delivery at one branch still
  // moves every other branch's cost. A multi-store shop has to be told,
  // because nothing on the other store's screen says so.
  it('warns a multi-store shop that a delivery re-values the other stores too', async () => {
    const caveat = await costBasisCaveat();
    expect(String(caveat!.props.children)).toContain('across all your stores');
  });

  // ...and a one-store shop has no cross-store bleed, so telling it about one
  // is inventing a problem. The sentence still has to end properly.
  it('leaves the cross-store clause out for a one-store shop', async () => {
    mockLocations = [{ id: 'loc-1', name: 'Jaalala 1', isPrimary: true, active: true }];
    const caveat = await costBasisCaveat();
    expect(caveat).toBeDefined();
    const copy = String(caveat!.props.children);
    expect(copy).not.toContain('across all your stores');
    expect(copy).toContain('rather than replacing it outright.');
  });

  // THE LOAD-BEARING ONE. tone="context" means the number is right and here is
  // why it looks surprising; `wrong` means it is wrong until the reader fixes
  // something and MUST carry an action. There is nothing a shop can do about
  // the costing basis from Inventory — it is the app's choice, not their
  // mistake — so an action here, or a promotion to `wrong`, would be a fix
  // that does not exist and would train people to skip the uncosted warning
  // above, which does have one.
  it('offers no action, because there is nothing for the shop to fix', async () => {
    const caveat = await costBasisCaveat();
    expect(caveat!.props.tone).toBe('context');
    expect(caveat!.props.action).toBeUndefined();
  });

  it('can be dismissed', async () => {
    const caveat = await costBasisCaveat();
    expect(typeof caveat!.props.onDismiss).toBe('function');
  });
});

describe('Inventory — the Stock at cost tile', () => {
  // "what you paid for it" was a claim the number cannot support. The hint is
  // the first telling of the basis; the caveat is the second. Both name the
  // formula, so a reader who dismisses the caveat is not left without the
  // IAS 2.36(a) disclosure.
  it('states the basis in its hint', async () => {
    const tree = await render();
    const { StatTile } = jest.requireActual('@/components/stat-tile');
    const tile = tree.root.findAllByType(StatTile).find((node) => node.props.label === 'Stock at cost');
    expect(tile).toBeDefined();
    expect(tile!.props.hint).toBe('at weighted average cost');
  });
});
