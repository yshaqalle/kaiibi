import { Dimensions, Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { StockActionsSheet } from '@/components/stock-actions-sheet';
import { StockCountModal } from '@/components/stock-count-modal';
import { StockTransferModal } from '@/components/stock-transfer-modal';
// Textually first, ahead of the `jest.mock` calls below, so `import/first`
// stays quiet -- harmless, since babel-plugin-jest-hoist hoists every
// `jest.mock` above every import at transpile time regardless of source
// order, and the factories only close over `mockProducts`/`mockShop`
// lazily (see the comment above `listProducts` below), never at import time.
import InventoryScreen from '@/app/(admin)/(tabs)/inventory';

// Lives here rather than beside the screen for the same reason
// inventory-caveats.test.tsx does: expo-router builds its route table from
// `require.context(src/app)`, and a test file under src/app would become a
// real route shipped inside the bundle.

// `mock`-prefixed because jest.mock() is hoisted above these declarations and
// babel-plugin-jest-hoist refuses a factory closing over anything else.
let mockLocations = [
  { id: 'loc-1', name: 'Jaalala 1', isPrimary: true, active: true },
  { id: 'loc-2', name: 'Jaalala 2', isPrimary: false, active: true },
];
// Every permission a role holding the full inventory split has, by default.
// Individual tests narrow this to prove one flag is doing the actual gating,
// not `inventory.edit` standing in for all three the way it used to.
let mockPermissions = new Set(['inventory.view', 'inventory.edit', 'inventory.count', 'inventory.transfer']);
// A stable reference, not `[]` inline below -- `useAuth` returns a fresh
// `shop` object every call, same as every other mock in this shape, so
// `reload`'s `useCallback` never settles and its effect re-fires on every
// render. That's harmless as long as the resolved array is the SAME
// reference each time: React bails out of the `setProducts` re-render when
// the new value is `Object.is`-equal to the old one, which is what actually
// stops the loop. A fresh `[]` literal returned per call is never equal to
// the last one, so the effect never stops re-firing -- an infinite render
// loop the empty-catalogue case above (inventory-caveats.test.tsx) never
// hits only because it has a product to hand back.
const mockProducts: never[] = [];
// Also stable, for the same reason: this screen's `reload` is memoized on
// `[shop, locationFilter]`, and every button press in these tests causes a
// re-render. A fresh `shop` object per `useAuth()` call would make `reload`
// re-identify on every one of those, re-firing its effect and re-fetching
// each time -- work that finishes after whichever synchronous `act()` drove
// the press, logging as a state update outside `act`.
const mockShop = { id: 'shop-1', defaultLowStockLevel: 5, expiryTrackingEnabled: false };

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    shop: mockShop,
    can: (permission: string) => mockPermissions.has(permission),
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
  // Lazily, not `mockResolvedValue(mockProducts)`: the screen `import` below
  // is hoisted above these declarations, so the fixture is still
  // uninitialised when this factory runs and the screen would be handed
  // `undefined`. Same reason as inventory-caveats.test.tsx.
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

// Pinned to desktop width so the Stock door is one pill press away
// (`headerActions`'s non-compact branch). At the default jest width (750,
// narrower than the 860 breakpoint) reaching it goes through the "More"
// sheet instead, which stages its OWN handover before the door even opens --
// a second staged hop this suite does not need in order to reach the wiring
// Task 7 added. `Dimensions.set` is the real, public way `useWindowDimensions`
// itself expects to learn of a change (native fires the same 'change' event
// on rotation) -- no module mocking required.
Dimensions.set({ window: { width: 1200, height: 900, scale: 1, fontScale: 1 }, screen: { width: 1200, height: 900, scale: 1, fontScale: 1 } });

async function render(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<InventoryScreen />);
  });
  return tree!;
}

// Presses the (non-compact) header's "Stock" pill, opening the door. Matched
// on the exact text rather than a substring: several other strings on this
// screen ("Stock at cost", a row's own quantity) contain "Stock" too, and the
// door itself repeats the word as its own sheet title once open.
function openStockDoor(tree: ReactTestRenderer) {
  const label = tree.root.findAllByType(Text).find((node) => node.props.children === 'Stock');
  if (!label) throw new Error('Stock pill not found -- is the screen still at compact width?');
  let owner: ReactTestInstance | null = label;
  while (owner && typeof owner.props.onPress !== 'function') owner = owner.parent;
  if (!owner) throw new Error('Stock pill has no pressable ancestor');
  act(() => owner!.props.onPress());
}

// Every row inside the (already open) door carries an accessibilityLabel --
// see stock-actions-sheet.tsx -- so this needs no knowledge of its markup.
function doorRowLabels(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => typeof node.props.accessibilityLabel === 'string' && typeof node.props.onPress === 'function')
    .map((node) => node.props.accessibilityLabel as string);
}

function pressDoorRow(tree: ReactTestRenderer, label: string) {
  const row = tree.root.findAll((node) => node.props.accessibilityLabel === label)[0];
  if (!row) throw new Error(`no door row labelled ${label}`);
  act(() => row.props.onPress());
}

describe('Inventory — the Stock door, wired to permissions', () => {
  beforeEach(() => {
    mockLocations = [
      { id: 'loc-1', name: 'Jaalala 1', isPrimary: true, active: true },
      { id: 'loc-2', name: 'Jaalala 2', isPrimary: false, active: true },
    ];
    mockPermissions = new Set(['inventory.view', 'inventory.edit', 'inventory.count', 'inventory.transfer']);
  });

  // The RPC is what actually stops a write-off; this is the half that keeps a
  // role from meeting that refusal by pressing a button that looked live.
  // `inventory.edit` alone used to be enough to see every row -- proving this
  // needs a role that HAS edit but NOT count, which `showCount={canEdit}`
  // would still pass.
  it('shows Count only for a role holding inventory.count, not merely inventory.edit', async () => {
    mockPermissions = new Set(['inventory.view', 'inventory.edit', 'inventory.transfer']);
    const tree = await render();
    openStockDoor(tree);

    const rows = doorRowLabels(tree);
    // Positive companion: Restock being there is what proves the door
    // actually opened, so Count's absence below isn't an empty render.
    expect(rows).toContain('Restock');
    expect(rows).not.toContain('Count');
  });

  it('shows Move only for a role holding inventory.transfer', async () => {
    mockPermissions = new Set(['inventory.view', 'inventory.edit', 'inventory.count']);
    const tree = await render();
    openStockDoor(tree);

    const rows = doorRowLabels(tree);
    expect(rows).toContain('Restock');
    expect(rows).not.toContain('Move');
  });

  // The mutation this pins: `actionFromStock.open(action, true)` becoming
  // `open(action, compact)`. At this suite's desktop width `compact` is
  // `false`, so a caller that passed it instead of the hardcoded `true` would
  // skip staging entirely and open StockCountModal immediately -- exactly the
  // dead-button bug on iOS this staging exists to prevent, just invisible at
  // this width because nothing here is actually iOS. Reading `visible` off
  // the mounted component directly is what makes the difference observable.
  it('stages the handover to Count -- the modal only opens after the door reports itself dismissed', async () => {
    const tree = await render();
    openStockDoor(tree);
    pressDoorRow(tree, 'Count');

    // Staged: the door has told the screen to open Count, but the count
    // sheet must not appear until the door itself is off-screen.
    expect(tree.root.findByType(StockCountModal).props.visible).toBe(false);

    // What actually promotes it, in the real app, is AppModal's `onDismiss`
    // firing once iOS finishes animating the door away -- wired straight
    // through as `onDismissed`.
    const sheet = tree.root.findByType(StockActionsSheet);
    // Async: becoming visible fires StockCountModal's own load effects
    // (listProducts, listCategories), and draining them here -- rather than
    // leaving them to resolve after the test has already returned -- is what
    // keeps this from logging an act() warning against a torn-down tree.
    await act(async () => {
      sheet.props.onDismissed?.();
    });

    expect(tree.root.findByType(StockCountModal).props.visible).toBe(true);
  });

  // Finding 1 (review, Task 7): this modal used to mount on `shop && canEdit`,
  // the same condition as Restock -- so a role holding `inventory.edit` but
  // not `inventory.transfer` could still reach it through the Import
  // rejection list's Move hatch (see csv-import-escape-hatches.test.tsx) and
  // build a whole transfer the RPC would then refuse. It has to follow
  // `canTransfer`, not `canEdit`, the same way the door's own `showMove` does.
  it('mounts StockTransferModal only for a role holding inventory.transfer, not merely inventory.edit', async () => {
    const withTransfer = await render();
    expect(withTransfer.root.findAllByType(StockTransferModal)).toHaveLength(1);

    mockPermissions = new Set(['inventory.view', 'inventory.edit', 'inventory.count']);
    const withoutTransfer = await render();
    expect(withoutTransfer.root.findAllByType(StockTransferModal)).toHaveLength(0);
  });
});
