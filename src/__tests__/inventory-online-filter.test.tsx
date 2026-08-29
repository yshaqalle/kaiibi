// Inventory's listing filter — the half of the storefront chain that was
// missing.
//
// A shop cannot publish its storefront until at least one product is marked to
// sell online. The blocker says so and sends the shopkeeper here; until this
// filter existed, the word "online" appeared nowhere on this screen and the
// only way to act was to open a product and scroll past Expiry Date and Batch
// Number to a toggle. These tests hold the two things that fix that: the chips
// name the listing, and they narrow the list to it.
//
// Lives here rather than beside the screen for the same reason as
// inventory-caveats.test.tsx: expo-router's require.context turns anything
// under src/app into a real route.

import { Text, type TextProps } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { CategoryChip } from '@/components/category-chip';
import { ExportMenu } from '@/components/export-menu';
import { ProductTile } from '@/components/product-tile';
import { ProductTableRow } from '@/components/product-table-row';
import type { Product } from '@/types/models';

// `mock`-prefixed so babel-plugin-jest-hoist allows the factories below to
// close over them.
let mockParams: { filter?: string } = {};

function product(overrides: Partial<Product> & { id: string; name: string }): Product {
  return {
    shopId: 'shop-1',
    description: null,
    sku: null,
    barcode: null,
    brand: null,
    category: null,
    tags: [],
    supplierName: null,
    costCents: 400,
    priceCents: 900,
    stock: 40,
    reorderLevel: null,
    shelfNumber: null,
    expiryDate: null,
    batchNumber: null,
    imageUrl: null,
    isListedOnline: false,
    locationStock: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Product;
}

// One product per fact under test, so a filter that quietly matched everything
// or nothing could not pass any of these by accident:
//   Shaah  — listed online, healthy stock, costed
//   Bur    — not listed, healthy stock, costed
//   Sonkor — not listed, LOW on stock
//   Caano  — not listed, UNCOSTED
const FULL_FIXTURE: Product[] = [
  product({ id: 'p-1', name: 'Shaah', isListedOnline: true }),
  product({ id: 'p-2', name: 'Bur' }),
  product({ id: 'p-3', name: 'Sonkor', stock: 1 }),
  product({ id: 'p-4', name: 'Caano', costCents: null }),
];
let mockProducts: Product[] = FULL_FIXTURE;

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    shop: { id: 'shop-1', defaultLowStockLevel: 5, expiryTrackingEnabled: false },
    can: () => true,
    // The screen's default export is wrapped in `withModuleWall` now, so the
    // module gate is on the way in -- this fixture is a paying shop.
    hasModule: () => true,
    locations: [{ id: 'loc-1', name: 'Jaalala 1', isPrimary: true, active: true }],
    activeLocation: { id: 'loc-1', name: 'Jaalala 1', isPrimary: true, active: true },
    limitFor: () => null,
    usageOf: () => 0,
  }),
}));
jest.mock('@/lib/products', () => ({
  listProducts: jest.fn(() => Promise.resolve(mockProducts)),
  createProduct: jest.fn(),
  findProductsByCode: jest.fn(),
  setLocationStock: jest.fn(),
  updateProduct: jest.fn(),
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: () => {},
}));

// eslint-disable-next-line import/first
import InventoryScreen from '@/app/(admin)/(tabs)/inventory';

async function render(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<InventoryScreen />);
  });
  return tree!;
}

// Whichever of the two list renderers this width picked. Asking for both means
// the assertions say "these products are on screen" rather than "this width's
// component was handed these products".
function listedNames(tree: ReactTestRenderer): string[] {
  return [
    ...tree.root.findAllByType(ProductTile),
    ...tree.root.findAllByType(ProductTableRow),
  ].map((node) => (node.props.product as Product).name);
}

function chip(tree: ReactTestRenderer, label: string) {
  const found = tree.root.findAllByType(CategoryChip).find((node) => node.props.label === label);
  if (!found) {
    throw new Error(
      `No filter chip labelled "${label}". Present: ${tree.root
        .findAllByType(CategoryChip)
        .map((node) => node.props.label)
        .join(' | ')}`
    );
  }
  return found;
}

async function press(tree: ReactTestRenderer, label: string) {
  await act(async () => {
    chip(tree, label).props.onPress();
  });
}

function textOf(node: ReactTestInstance): string {
  return node
    .findAllByType(Text)
    .flatMap((t) => [(t.props as TextProps).children].flat(Infinity))
    .filter((child) => typeof child === 'string' || typeof child === 'number')
    .join(' ');
}

beforeEach(() => {
  mockParams = {};
  mockProducts = FULL_FIXTURE;
});

describe('Inventory — the sell-online filter', () => {
  // The screen has to say the word at all. Both directions get a chip: seeing
  // what IS on the page is how a shop checks its storefront, and seeing what is
  // NOT is how it fixes an unpublishable one.
  it('names the listing in the chip row, in both directions, with counts', async () => {
    const tree = await render();
    expect(chip(tree, 'Online 1')).toBeDefined();
    expect(chip(tree, 'Not online 3')).toBeDefined();
  });

  it('shows only the products that are on the storefront page', async () => {
    const tree = await render();
    await press(tree, 'Online 1');
    expect(listedNames(tree)).toEqual(['Shaah']);
  });

  // The important direction: the ones a shopkeeper sent here by the publish
  // blocker actually has to open and mark.
  it('shows only the products that are not on the storefront page', async () => {
    const tree = await render();
    await press(tree, 'Not online 3');
    expect(listedNames(tree).sort()).toEqual(['Bur', 'Caano', 'Sonkor']);
  });

  // Where the storefront blocker lands. Read once as the INITIAL value, the
  // same contract as the Dashboard's ?filter=low link.
  it('arrives already filtered when the storefront blocker deep-links here', async () => {
    mockParams = { filter: 'notonline' };
    const tree = await render();
    expect(chip(tree, 'Not online 3').props.active).toBe(true);
    expect(listedNames(tree).sort()).toEqual(['Bur', 'Caano', 'Sonkor']);
  });

  it('accepts the online direction from the route too', async () => {
    mockParams = { filter: 'online' };
    const tree = await render();
    expect(chip(tree, 'Online 1').props.active).toBe(true);
    expect(listedNames(tree)).toEqual(['Shaah']);
  });

  // A filter param nobody defined must not narrow anything -- an unrecognised
  // link is a link to the whole list, not to an empty one.
  it('ignores a filter it does not recognise', async () => {
    mockParams = { filter: 'sold-out' };
    const tree = await render();
    expect(chip(tree, 'All').props.active).toBe(true);
    expect(listedNames(tree)).toHaveLength(4);
  });

  // The chips that were already here, asserted from the same fixture, so
  // adding two more to the row cannot have quietly rewired them.
  it('leaves the low-stock chip filtering by stock', async () => {
    const tree = await render();
    await press(tree, 'Low stock 1');
    expect(listedNames(tree)).toEqual(['Sonkor']);
  });

  it('leaves the no-cost chip filtering by cost', async () => {
    const tree = await render();
    await press(tree, 'No cost 1');
    expect(listedNames(tree)).toEqual(['Caano']);
  });

  it('goes back to the whole list on All', async () => {
    const tree = await render();
    await press(tree, 'Online 1');
    await press(tree, 'All');
    expect(listedNames(tree)).toHaveLength(4);
  });

  // A filtered-to-zero list must say WHICH filter emptied it, and -- for this
  // one -- what to do about it, since the fix is inside a product. The shop in
  // this case is the one production has 11 of: nothing listed at all.
  it('explains an empty online list rather than reading as an empty shop', async () => {
    mockProducts = FULL_FIXTURE.map((p) => ({ ...p, isListedOnline: false }));
    const tree = await render();
    await press(tree, 'Online 0');
    expect(listedNames(tree)).toEqual([]);
    const copy = textOf(tree.root);
    expect(copy).toContain('Sell online');
    expect(copy).toContain('Storefront page');
  });

  // ...and the mirror: a shop with everything listed has an empty "Not online"
  // list, which is good news and has to read as good news.
  it('explains an empty not-online list as everything being listed', async () => {
    mockProducts = FULL_FIXTURE.map((p) => ({ ...p, isListedOnline: true }));
    const tree = await render();
    await press(tree, 'Not online 0');
    expect(listedNames(tree)).toEqual([]);
    expect(textOf(tree.root)).toContain('Every product is on your Storefront page');
  });
});

describe('Inventory — the sell-online listing in the export', () => {
  // Every other product field is a column; this one is a product field too, and
  // a shop reconciling its page against a spreadsheet has no other way to see it.
  it('carries the listing into the CSV/PDF columns', async () => {
    const tree = await render();
    // At this width Export lives behind the More sheet, so the sheet is what
    // has to be opened to reach the columns the button would actually write.
    await act(async () => {
      tree.root
        .findAll((node) => node.props?.accessibilityLabel === 'More inventory actions')[0]
        .props.onPress();
    });
    const columns = tree.root.findAllByType(ExportMenu)[0].props.columns as {
      header: string;
      value: (p: Product) => string;
    }[];
    const column = columns.find((c) => c.header === 'Sell Online');
    expect(column).toBeDefined();
    expect(column!.value(mockProducts[0])).toBe('Yes');
    expect(column!.value(mockProducts[1])).toBe('No');
  });
});

describe('Inventory — the per-row listing badge', () => {
  // The chips answer "which ones", the badge answers "this one" while a
  // shopkeeper is reading the unfiltered list.
  it('marks the listed product in the list and leaves the others unmarked', async () => {
    const tree = await render();
    const rows = [...tree.root.findAllByType(ProductTile), ...tree.root.findAllByType(ProductTableRow)];
    const listed = rows.find((node) => (node.props.product as Product).name === 'Shaah')!;
    const unlisted = rows.find((node) => (node.props.product as Product).name === 'Bur')!;
    expect(textOf(listed)).toContain('Online');
    expect(textOf(unlisted)).not.toContain('Online');
  });
});
