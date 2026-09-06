import { AccessibilityInfo, type EmitterSubscription, FlatList } from 'react-native';
import { act, create } from 'react-test-renderer';

import { ThemeMarket } from '@/components/storefront/theme-market';
import { SPACE } from '@/components/storefront/scale';
import { CHECKOUT_BAR_CLEARANCE } from '@/components/storefront/theme-shared';
import { paletteColors } from '@/lib/storefront-catalog';
import { SEARCH_THRESHOLD } from '@/lib/storefront-search';
import type { PublicStorefront, StorefrontFlyer, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

// ThemeMarket mounts FlyerCarousel even with no flyers (its hooks run
// unconditionally); Task 4's mount effect calls
// AccessibilityInfo.isReduceMotionEnabled(). Nothing here is about motion.
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as EmitterSubscription);

// `findAll` matches a testID against every test instance carrying that prop
// -- Pressable is composite and forwards testID down through a forwardRef
// View to its own host node (see storefront-theme-counter.test.tsx's
// identical comment) -- filtering on `onPress` gives one match per button.
function findByTestId(tree: ReturnType<typeof create>, testID: string) {
  return tree.root.findAll((node) => node.props?.testID === testID && typeof node.props?.onPress === 'function');
}

// grid's own base style sets `padding` (all four sides, RN shorthand), and
// gridWithCheckoutBar layers an explicit `paddingBottom` on top -- the two
// remain distinct keys through a plain JS merge (unlike RN's own layout
// engine, nothing here expands the shorthand into four longhand keys), so
// the EFFECTIVE bottom clearance is whichever of the two is more specific.
function effectiveBottomPadding(style: unknown): number {
  const flat = [style].flat(Infinity).reduce((acc, s) => ({ ...(acc as object), ...(s as object) }), {}) as {
    paddingBottom?: number;
    padding?: number;
  };
  return flat.paddingBottom ?? flat.padding ?? 0;
}

const colors = paletteColors('ink');

const shop: PublicStorefront = {
  shopName: 'Xamdi Electronics',
  city: 'Hargeisa',
  slug: 'xamdi',
  whatsappE164: '+252634456789',
  theme: 'market',
  palette: 'ink',
  headline: null,
  about: null,
  heroImageUrl: null,
  offersDelivery: true,
  collectAddress: null,
  collectNeighborhood: null,
  paymentMode: 'on_collection',
  openingHours: {},
  tradingSince: null, highlights: [], images: [],
  contactPhone: null, instagram: null,
  // No flyers: these fixtures predate them, and a shop with none must
  // render exactly as it did before they existed.
  flyers: [],
  autoAdvance: false,
  hideBranding: false,
};

const products: StorefrontProduct[] = [
  { id: 'p1', name: 'Anker 20W charger', description: null, category: 'Phone', priceCents: 1200, stock: 5, imageUrl: null },
];

// storefront-cart.ts's native-platform cache (`nativeCache`, a module-level
// Map with no reset hook by design -- same note storefront-route.test.tsx's
// own setup carries) persists for the life of this test file. Each test
// below renders its own shop slug so one test's cart can never leak into
// another's, without needing the web/localStorage fake other storefront
// test files use.
// FlatList (via VirtualizedList) schedules a cell-measurement update on a
// real timer after mount -- an async act(), same as storefront-route.test.tsx's
// own render() helper, lets that settle before the test (or the file) ends,
// rather than it firing later and logging an "update not wrapped in act()"
// warning against whichever test happens to be running by then.
async function renderMarket(slug: string) {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<ThemeMarket storefront={{ ...shop, slug }} products={products} colors={colors} />);
  });
  return tree;
}

// Task 14's slot: the flyer band belongs directly under the floating
// search and above the categories. `toJSON()` yields HOST nodes only, in
// DOCUMENT order -- the same reason storefront-flyer-carousel.test.tsx's own
// `hostNodes` walker exists, and the property this suite needs: not merely
// that all three render, but that they render in THIS order. Task 13 shipped
// a defect (the search's own -21px pull landing on the wrong sibling) that
// every structural "does it exist" test passed -- this is written the way
// that task's own retrospective asks for, as a check of who comes before
// whom, not just who is present.
type HostNode = { type: string; props: Record<string, unknown>; children: unknown[] | null };

function hostNodes(tree: ReturnType<typeof create>): HostNode[] {
  const out: HostNode[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node === 'string') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const host = node as HostNode;
    out.push(host);
    (host.children ?? []).forEach(walk);
  };
  walk(tree.toJSON() as unknown);
  return out;
}

function firstIndexOfTestId(nodes: HostNode[], testID: string): number {
  return nodes.findIndex((node) => node.props?.testID === testID);
}

function flyer(id: string): StorefrontFlyer {
  return {
    id, imageUrl: null, headline: `Flyer ${id}`, subline: null,
    linkKind: 'none', linkValue: null, offer: null,
  };
}

describe('ThemeMarket', () => {
  // The regression this pins: FlyerCarousel renders between ShopHeader's
  // floating search (narrow layout, the default width react-test-renderer
  // uses -- see storefront-search-float.test.tsx's identical reliance on
  // that) and CategoryBand, in document order. Two flyers so the multi-slide
  // band (dots, a real `storefront-flyer-band`) renders rather than the
  // single-flyer static case; two categories clears CATEGORY_BAND_MINIMUM so
  // CategoryBand renders at all rather than returning null with nothing to
  // be a sibling of.
  it('places the flyer band between the floating search and the category band', async () => {
    // SEARCH_THRESHOLD products, split across two categories -- enough to
    // clear both shouldOfferSearch (the floating search) and
    // CATEGORY_BAND_MINIMUM (the category band), so both of the flyer
    // band's neighbours actually render rather than the assertion passing
    // vacuously against two nodes that were never there.
    const catalogue: StorefrontProduct[] = Array.from({ length: SEARCH_THRESHOLD }, (_, i) => ({
      id: `sp${i}`,
      name: `Product ${i}`,
      description: null,
      category: i % 2 === 0 ? 'Phone' : 'Cable',
      priceCents: 1000 + i,
      stock: 5,
      imageUrl: null,
    }));

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <ThemeMarket
          storefront={{ ...shop, slug: 'xamdi-market-flyer-slot', flyers: [flyer('f1'), flyer('f2')] }}
          products={catalogue}
          categories={[
            { name: 'Phone', imageUrl: null, productCount: catalogue.length / 2 },
            { name: 'Cable', imageUrl: null, productCount: catalogue.length / 2 },
          ]}
          colors={colors}
        />,
      );
    });

    const nodes = hostNodes(tree);
    const searchIndex = firstIndexOfTestId(nodes, 'storefront-search');
    const flyerIndex = firstIndexOfTestId(nodes, 'storefront-flyer-band');
    const categoryIndex = firstIndexOfTestId(nodes, 'storefront-category-band');

    expect(searchIndex).toBeGreaterThan(-1);
    expect(flyerIndex).toBeGreaterThan(-1);
    expect(categoryIndex).toBeGreaterThan(-1);
    expect(searchIndex).toBeLessThan(flyerIndex);
    expect(flyerIndex).toBeLessThan(categoryIndex);
  });

  // The requirement most likely to regress silently, per the brief: a shop
  // with no flyers gets no frame at all, not an empty band sitting between
  // the search and the categories.
  it('renders no flyer band at all when the shop has no flyers', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <ThemeMarket
          storefront={{ ...shop, slug: 'xamdi-market-no-flyers', flyers: [] }}
          products={products}
          categories={[]}
          colors={colors}
        />,
      );
    });
    const nodes = hostNodes(tree);
    expect(firstIndexOfTestId(nodes, 'storefront-flyer-band')).toBe(-1);
    expect(firstIndexOfTestId(nodes, 'storefront-flyer-slide')).toBe(-1);
  });


  // B6: the sticky CheckoutBar is `position: absolute` and reserves no
  // space of its own. Task 5 made this unconditional -- the first Add must
  // not reflow the page under the customer's finger, so the grid carries
  // the clearance from the very first render, empty cart or not, and
  // adding to the cart changes nothing about it.
  it('reserves the checkout bar clearance from the first render, unchanged by adding to the cart', async () => {
    const tree = await renderMarket('xamdi-market-b6-clearance');
    const before = effectiveBottomPadding(tree.root.findByType(FlatList).props.contentContainerStyle);
    expect(before).toBe(SPACE.page + CHECKOUT_BAR_CLEARANCE);

    const addButtons = findByTestId(tree, 'product-tile-add');
    await act(async () => addButtons[0].props.onPress());

    const after = effectiveBottomPadding(tree.root.findByType(FlatList).props.contentContainerStyle);
    expect(after).toBe(before);

    // Drains VirtualizedList's own post-update cell-measurement timer before
    // this test ends, so it fires here (inside act) rather than after,
    // logged against whatever test is running by then.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });
});
