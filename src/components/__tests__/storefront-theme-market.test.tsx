import { AccessibilityInfo, type EmitterSubscription, FlatList } from 'react-native';
import { act, create } from 'react-test-renderer';

import { ThemeMarket } from '@/components/storefront/theme-market';
import { SPACE } from '@/components/storefront/scale';
import { CHECKOUT_BAR_CLEARANCE } from '@/components/storefront/theme-shared';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

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

describe('ThemeMarket', () => {
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
