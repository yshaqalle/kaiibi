import { AccessibilityInfo, StyleSheet, TextInput, type EmitterSubscription } from 'react-native';
import { act, create } from 'react-test-renderer';

import { ThemeCounter } from '@/components/storefront/theme-counter';
import { ThemeMarket } from '@/components/storefront/theme-market';
import { ThemeWindow } from '@/components/storefront/theme-window';
import { TOUCH_TARGET } from '@/components/storefront/scale';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicShopSummary, PublicStorefront, StorefrontCategory, StorefrontProduct } from '@/types/models';

import StoreDirectoryScreen from '@/app/store/index';

const mockListPublicShops = jest.fn();

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-router/head', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/storefront-directory', () => {
  const actual = jest.requireActual('@/lib/storefront-directory');
  return { ...actual, listPublicShops: (...args: unknown[]) => mockListPublicShops(...args) };
});

jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as EmitterSubscription);

// ─────────────────────────────────────────────────────────────────────────
// THE RULE, asked of every public surface: a control a customer can actually
// tap -- a Pressable wearing accessibilityRole 'button' or 'link' (a `tab`,
// like the shop's own tab rail, is excluded on purpose -- Task D's brief
// verifies with a browser query that only ever selects
// `[role="button"], [role="link"], input`, and this test mirrors that
// exactly rather than inventing a stricter net the live check does not
// share) or a bare TextInput -- must carry EITHER the TOUCH_TARGET floor (a
// `minHeight`/`height` in its own resolved style) OR a `hitSlop` that
// actually reaches TOUCH_TARGET once added to whatever literal size the
// style already states -- see `meetsTouchTargetRule`'s own comment for why
// that arithmetic only runs where a literal number exists to run it on.
//
// Why this single rule catches what a per-button assertion cannot: nothing
// stops the NEXT control from being sized by "looked right", the way Add sat
// at 26px for as long as it did with a full green test suite around it. A
// rule about the whole tree is what a new, small control trips on the day it
// is added, not the day someone happens to remember to test it.
//
// WHICH ROUTE COVERS WHICH STATE. The four `describe('every public-surface
// control...')` cases below render each theme (and the directory) at its
// OWN default, zero-cart, nothing-open state -- which is exactly the state
// in which `ProductSheet` returns null, `CartSheet` renders `AppModal
// visible={false}` (RN's own `Modal` renders null while closed), and
// `CheckoutBar` returns null at `itemCount === 0`. None of those three ever
// entered this sweep from that render alone, which is precisely how the
// three controls in the second describe block below went unfloored under a
// fully green suite. That block drives ONE theme (Market) through the
// states the zero-cart render cannot reach -- an item added, the cart sheet
// opened, a product sheet opened -- and is the only place those three
// components are swept. It does not re-drive Window and Counter through the
// same sequence: `CartSheet`, `ProductSheet` and `CheckoutBar` are the exact
// same components, imported unchanged, in every theme that renders them
// (theme-market.tsx, theme-window.tsx, theme-counter.tsx all pass the same
// props through to the same three functions) -- there is no theme-specific
// branch inside any of them left for a second render to catch that the
// first did not.
// ─────────────────────────────────────────────────────────────────────────

// `Pressable`'s own style is a FUNCTION once `pressable()` (press-feedback.ts)
// wraps it -- RN calls it with `{ pressed }` mid-touch. Reading `.props.style`
// directly, the way an earlier draft of this sweep did, hands back the
// function itself, `StyleSheet.flatten` on a function returns `undefined`,
// and every control in the tree silently "passes" a floor check that never
// ran. Calling it with `{ pressed: false }` first is what makes the walk see
// the same style RN would paint at rest.
function resolvedStyle(node: { props?: { style?: unknown } }): Record<string, unknown> {
  const raw = node.props?.style;
  const style = typeof raw === 'function' ? raw({ pressed: false }) : raw;
  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
}

// `hitSlop` is either a bare number (all four sides) or a partial
// `{top,bottom,left,right}` object -- normalised here once so the arithmetic
// below never has to branch on which shape it got.
function normalizedHitSlop(hitSlop: unknown): { top: number; bottom: number; left: number; right: number } | null {
  if (hitSlop == null) return null;
  if (typeof hitSlop === 'number') return { top: hitSlop, bottom: hitSlop, left: hitSlop, right: hitSlop };
  const h = hitSlop as { top?: number; bottom?: number; left?: number; right?: number };
  return { top: h.top ?? 0, bottom: h.bottom ?? 0, left: h.left ?? 0, right: h.right ?? 0 };
}

function meetsTouchTargetRule(node: { props?: { style?: unknown; hitSlop?: unknown } }): boolean {
  const flat = resolvedStyle(node);
  // `minHeight` is the floor everywhere a control's size comes from its own
  // padding (Add, Cart, the search field...). A fixed `height` counts too --
  // CategoryTile draws a 92px photo tile with `height: TILE_HEIGHT`, not
  // `minHeight`, because that box is a hard-coded shape, not a floor under
  // otherwise-organic content -- and either one, set to at least
  // TOUCH_TARGET, is the same fact stated two different ways.
  const floored = [flat.minHeight, flat.height].some((v) => typeof v === 'number' && v >= TOUCH_TARGET);
  if (floored) return true;

  const slop = normalizedHitSlop(node.props?.hitSlop);
  if (!slop) return false;

  // A BARE `hitSlop` USED TO BE THE WHOLE CHECK -- `hitSlop={1}` passed,
  // and the cart stepper (26px box + hitSlop 6 = 38, still short of 44)
  // sailed through with it. `COMPACT_BUTTON_HIT_SLOP` (theme-shared.tsx)
  // already does this arithmetic BY HAND in its own comment -- own box size
  // plus its own slop, checked against 44 -- because that pair's box has no
  // literal width/height in its style (it is sized by padding around text,
  // which this harness cannot lay out). Where a literal `width`/`height` (or
  // `minWidth`/`minHeight`) DOES sit in the resolved style -- the cart
  // stepper's `width: 26, height: 26` is exactly this case -- the same
  // arithmetic is checkable in code instead of by hand, so it is required:
  // whichever axis carries a literal number must clear TOUCH_TARGET once its
  // own hitSlop is added.
  const baseHeight = [flat.height, flat.minHeight].find((v) => typeof v === 'number') as number | undefined;
  const baseWidth = [flat.width, flat.minWidth].find((v) => typeof v === 'number') as number | undefined;
  if (baseHeight == null && baseWidth == null) {
    // Nothing literal to check an axis against -- a control sized by its own
    // text and padding, the COMPACT_BUTTON_HIT_SLOP case above. Trusted at
    // face value, exactly as every hitSlop was before this rule existed.
    return true;
  }
  if (baseHeight != null && baseHeight + slop.top + slop.bottom < TOUCH_TARGET) return false;
  if (baseWidth != null && baseWidth + slop.left + slop.right < TOUCH_TARGET) return false;
  return true;
}

// Pressable is composite and forwards `onPress`/`accessibilityRole` down
// through a forwardRef View to its own host node (the identical comment
// storefront-theme-counter.test.tsx and storefront-theme-market.test.tsx
// both carry) -- filtering on `onPress` being a function gives exactly one
// match per on-screen button rather than three. TextInput has no `onPress`
// at all, so it is gathered separately by its component type.
function touchControlsIn(tree: ReturnType<typeof create>) {
  const pressables = tree.root.findAll(
    (n) => typeof n.props?.onPress === 'function'
      && (n.props?.accessibilityRole === 'button' || n.props?.accessibilityRole === 'link'),
  );
  const inputs = tree.root.findAll((n) => n.type === TextInput);
  return [...pressables, ...inputs];
}

const colors = paletteColors('ink');

// 25 products (SEARCH_THRESHOLD, storefront-search.ts) so SearchField
// actually renders -- a sweep that never triggers the search field would
// never see `storefront-search`, one of the two controls this whole task
// started from. Two categories, one WITH a photographed product (so
// CategoryBand renders a CategoryTile) and one WITHOUT (so it renders the
// CategoryPill fallback instead) -- the fallback is the one this task also
// found under the floor (category-band.tsx's own `pill` style), and a sweep
// that only ever sees the photo tile would never exercise it. A mix of
// in-stock and out-of-stock products exercises both the Add+Ask and the
// Ask-only branch of ProductActions.
function makeProducts(): StorefrontProduct[] {
  return Array.from({ length: 25 }, (_, i) => {
    const inPhoneCategory = i % 2 === 0;
    return {
      id: `p${i}`,
      name: `Product ${i}`,
      description: null,
      category: inPhoneCategory ? 'Phone' : 'Snacks',
      priceCents: 1000 + i * 37,
      stock: i % 5 === 0 ? 0 : 4,
      // Only the Phone products carry a photo -- Snacks' category tile has
      // no photo to draw from, which is exactly the CategoryPill case.
      imageUrl: inPhoneCategory ? 'https://cdn.example/shop/phone.jpg' : null,
    };
  });
}

const categories: StorefrontCategory[] = [
  { name: 'Phone', imageUrl: null, productCount: 13 },
  { name: 'Snacks', imageUrl: null, productCount: 12 },
];

const shop: PublicStorefront = {
  shopName: 'Xamdi Electronics',
  city: 'Hargeisa',
  slug: 'xamdi-touch',
  whatsappE164: '+252634456789',
  theme: 'market',
  palette: 'ink',
  headline: 'Everything for the house and the phone.',
  about: null,
  heroImageUrl: null,
  offersDelivery: true,
  collectAddress: null,
  collectNeighborhood: null,
  paymentMode: 'on_collection',
  openingHours: {},
  tradingSince: null, highlights: [], images: [],
  contactPhone: null, instagram: null,
  flyers: [],
  autoAdvance: false,
  hideBranding: false,
};

async function renderTheme(Theme: typeof ThemeMarket | typeof ThemeWindow | typeof ThemeCounter) {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<Theme storefront={shop} products={makeProducts()} colors={colors} categories={categories} />);
  });
  return tree;
}

describe('every public-surface control meets the touch-target rule', () => {
  it('Market: every tappable control carries the floor or a hitSlop', async () => {
    const tree = await renderTheme(ThemeMarket);
    const controls = touchControlsIn(tree);

    // Guards the guard: if this ever comes back empty (the exact silent
    // failure the pressable()-is-a-function trap above produces), the
    // assertions below would pass vacuously and the sweep would test
    // nothing. See this file's own header comment.
    expect(controls.length).toBeGreaterThan(0);

    const failing = controls.filter((c) => !meetsTouchTargetRule(c));
    expect(failing.map((c) => c.props?.testID)).toEqual([]);
  });

  it('Window: every tappable control carries the floor or a hitSlop', async () => {
    const tree = await renderTheme(ThemeWindow);
    const controls = touchControlsIn(tree);
    expect(controls.length).toBeGreaterThan(0);

    const failing = controls.filter((c) => !meetsTouchTargetRule(c));
    expect(failing.map((c) => c.props?.testID)).toEqual([]);
  });

  it('Counter: every tappable control carries the floor or a hitSlop', async () => {
    const tree = await renderTheme(ThemeCounter);
    const controls = touchControlsIn(tree);
    expect(controls.length).toBeGreaterThan(0);

    const failing = controls.filter((c) => !meetsTouchTargetRule(c));
    expect(failing.map((c) => c.props?.testID)).toEqual([]);
  });

  it('the directory (/store): every tappable control carries the floor or a hitSlop', async () => {
    const shops: PublicShopSummary[] = [
      {
        shopName: 'Alpha Hardware', slug: 'dir-alpha', city: 'Hargeisa',
        headline: 'Everything that plugs in.', about: null, heroImageUrl: 'https://cdn.example/shop/alpha.jpg',
        offersDelivery: true, openingHours: {}, categories: ['Electronics'], productCount: 40,
      },
      {
        shopName: 'Borama Snacks', slug: 'dir-borama', city: 'Borama',
        headline: 'Sweets and soda.', about: null, heroImageUrl: null,
        offersDelivery: false, openingHours: {}, categories: ['Snacks'], productCount: 12,
      },
    ];
    mockListPublicShops.mockResolvedValue(shops);

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<StoreDirectoryScreen />);
    });
    // Lets listPublicShops's resolved promise settle -- the same
    // async-act-then-plain-act shape storefront-directory.test.tsx's own
    // renderScreen() uses, one tick after the state update `.then()`
    // schedules.
    await act(async () => {});

    const controls = touchControlsIn(tree);
    expect(controls.length).toBeGreaterThan(0);

    const failing = controls.filter((c) => !meetsTouchTargetRule(c));
    expect(failing.map((c) => c.props?.testID)).toEqual([]);
  });
});

// THE STATES THE FOUR TESTS ABOVE CANNOT REACH -- see this file's own header
// comment ("WHICH ROUTE COVERS WHICH STATE") for why one theme, driven
// through these three transitions, is proof for all of them: CartSheet,
// ProductSheet and CheckoutBar are the same components under Market, Window
// and Counter alike.
describe('the states a zero-cart, nothing-open render never reaches', () => {
  it('cart sheet open with lines, product sheet open, checkout bar with an item: every control still carries the floor or a hitSlop', async () => {
    const tree = await renderTheme(ThemeMarket);

    // AN ITEM IN THE CART -- the one thing that turns CheckoutBar from null
    // into a real Pressable, and CartSheet's empty-cart text into a
    // scrolling list of lines with their own steppers and Close.
    const add = tree.root.findAll(
      (n) => n.props?.testID === 'product-tile-add' && typeof n.props?.onPress === 'function',
    );
    expect(add.length).toBeGreaterThan(0);
    await act(async () => add[0].props.onPress());

    // THE CART SHEET, OPEN -- AppModal renders null while `visible={false}`;
    // this is the only way its own Close and stepper Pressables ever mount.
    const cartButton = tree.root.findAll((n) => n.props?.testID === 'storefront-cart-button')[0];
    await act(async () => cartButton.props.onPress());

    // A PRODUCT SHEET, OPEN -- `ProductSheet` returns null with no product;
    // this is the only way its own dismiss/Close mount.
    const openTile = tree.root.findAll(
      (n) => n.props?.testID === 'product-tile-open' && typeof n.props?.onPress === 'function',
    );
    expect(openTile.length).toBeGreaterThan(0);
    await act(async () => openTile[0].props.onPress());

    const controls = touchControlsIn(tree);
    // Guards the guard, same reasoning as the zero-state sweeps above --
    // and a stronger floor here, since this sweep exists specifically to
    // reach cart-sheet-close, product-sheet-close and the cart-line
    // steppers, which the count above must be large enough to include.
    expect(controls.length).toBeGreaterThan(10);

    const failing = controls.filter((c) => !meetsTouchTargetRule(c));
    expect(failing.map((c) => c.props?.testID)).toEqual([]);
  });
});
