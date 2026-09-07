import { AccessibilityInfo, StyleSheet, TextInput, type EmitterSubscription } from 'react-native';
import { act, create } from 'react-test-renderer';

import { ThemeCounter } from '@/components/storefront/theme-counter';
import { ThemeMarket } from '@/components/storefront/theme-market';
import { ThemeWindow } from '@/components/storefront/theme-window';
import { TOUCH_TARGET } from '@/components/storefront/scale';
import { paletteColors } from '@/lib/storefront-catalog';
import type {
  PublicDeliveryArea, PublicShopSummary, PublicStorefront, StorefrontCategory, StorefrontFlyer,
  StorefrontProduct,
} from '@/types/models';

import StoreDirectoryScreen from '@/app/store/index';

const mockListPublicShops = jest.fn();
// The RPC boundary -- see the "checkout and confirmation" describe block
// below, the one place this file drives a real submit through the real
// useCheckoutFlow/placeOrder (theme-shared.tsx, storefront-order.ts) rather
// than mocking either of those away, the same choice
// storefront-checkout-whatsapp-choice.test.tsx makes and for the same
// reason: CheckoutForm's onSubmit -> useCheckoutFlow.submit -> placeOrder is
// wiring worth exercising for real, not just trusting each link in isolation.
const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => mockRpc(...args) } }));
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

// TWO flyers, not zero -- an empty `flyers: []` is what let the dots' 23px
// tap target (7px dot + hitSlop 8 = 23, flyer-carousel.tsx) sit unswept
// through two prior commits: `count === 0` makes FlyerCarousel return null
// before any Pressable exists for the sweep to find, so the ONE control this
// page's whole phone audience uses to change flyers (the arrows sit at
// `opacity: 0` with `pointerEvents: 'none'` whenever `hoverCapable` is false
// -- see flyer-carousel.tsx's own comment) was never in a tree this file
// walked. Two is the minimum that turns the dots AND the arrows on at all
// (`count === 1` renders a hero with neither -- property 2, flyer-carousel.tsx).
// Market and Window both render this list (ThemeMarket/ThemeWindow pass
// `storefront.flyers` straight through); Counter deliberately never reads it
// (theme-counter.tsx's own header comment), so this fixture change reaches
// exactly the two themes the defect could ever have hidden in.
const flyers: StorefrontFlyer[] = [
  {
    id: 'fly1', imageUrl: 'https://cdn.example/shop/eid.jpg', headline: 'Eid stock has landed',
    subline: 'New lanterns and kettles in store now.', linkKind: 'none', linkValue: null, offer: null,
  },
  {
    id: 'fly2', imageUrl: null, headline: 'Second poster', subline: null,
    linkKind: 'none', linkValue: null, offer: null,
  },
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
  flyers,
  autoAdvance: false,
  hideBranding: false,
};

// WHAT THE REST OF THIS FIXTURE STILL HIDES, found while fixing the flyers
// gap above and left as a finding rather than a fifth item this task did not
// scope: `about: null` and `areas: []` (this file's own `renderTheme`
// default) together mean `availableTabs` (shop-tabs.tsx) returns `['shop']`
// alone, so ShopTabRail renders NOTHING (`tabs.length < 2`) in every describe
// block below except the checkout one -- and that one drives the checkout
// flow, never a tab press. The About and Visit tabs, and everything inside
// them (about-panel.tsx's highlights/images, visit-panel.tsx's own
// `tel:`/instagram Pressables, both currently unreachable because
// `contactPhone`/`instagram` are also null here), have never been swept by
// this file. Not fixed here -- it is a second, larger fixture gap than the
// one this task was sent to close, and belongs to whoever next touches those
// two tabs' own controls.

async function renderTheme(
  Theme: typeof ThemeMarket | typeof ThemeWindow | typeof ThemeCounter,
  // Defaults to none, same as ThemeProps' own default (theme-shared.tsx) --
  // only the checkout/confirmation describe block below passes a real one,
  // to reach the "Deliver" segment, its area rows and its landmark field.
  areas: PublicDeliveryArea[] = [],
) {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(
      <Theme storefront={shop} products={makeProducts()} colors={colors} categories={categories} areas={areas} />,
    );
  });
  return tree;
}

// Pressable forwards `onPress`/`onChangeText` down through a forwardRef View
// to its own host node (the same fact `touchControlsIn` above relies on) --
// filtering on the callback being a function is what keeps either helper to
// exactly one match. Synchronous `act`, not the async form: `onPress` here
// can itself be async (`checkout-form-submit` triggers the real
// useCheckoutFlow.submit, unawaited by CheckoutForm's own handler) and
// `flush` below is what lets that settle, the same two-step
// press-then-flush storefront-checkout-whatsapp-choice.test.tsx already
// proves is enough for this exact RPC chain.
function press(tree: ReturnType<typeof create>, testID: string) {
  const [node] = tree.root.findAll((n) => n.props?.testID === testID && typeof n.props?.onPress === 'function');
  act(() => node.props.onPress());
}

function setText(tree: ReturnType<typeof create>, testID: string, value: string) {
  const [node] = tree.root.findAll((n) => n.props?.testID === testID && typeof n.props?.onChangeText === 'function');
  act(() => node.props.onChangeText(value));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
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
    // GUARDS THE GUARD BY NAME, not by count. `toBeGreaterThan(10)` used to
    // stand in here -- commented as existing specifically to reach
    // `cart-sheet-close`, `product-sheet-close` and the steppers -- but the
    // zero-cart Market render already clears 10 on its own (25 products x
    // add/ask, the tiles, the search field, the cart button are ~45 controls
    // before either modal mounts), so a count this low was satisfied four
    // times over by controls it was not written to test. If `AppModal` ever
    // stopped rendering its children, this sweep would fall back to that
    // same ~45-control zero-cart tree, comfortably clear 10, and stay green
    // while testing none of the three controls it exists for -- the exact
    // silent failure this file's header comment says the whole rule was
    // written to end. Naming the testIDs is what makes their absence an
    // assertion failure instead of a number that happens not to have moved
    // yet. `p1` is the first IN-STOCK product `makeProducts` yields (`p0`'s
    // `i % 5 === 0` makes it the first with `stock: 0`, so it has no
    // `product-tile-add` at all -- see ProductActions) and so the one
    // `add[0]` above actually adds.
    const controlIds = controls.map((c) => c.props?.testID);
    for (const requiredId of [
      'cart-sheet-close', 'product-sheet-close', 'cart-line-decrease-p1', 'cart-line-increase-p1',
    ]) {
      expect(controlIds).toContain(requiredId);
    }

    const failing = controls.filter((c) => !meetsTouchTargetRule(c));
    expect(failing.map((c) => c.props?.testID)).toEqual([]);
  });
});

// The RPC's own RETURNING shape (snake_case) -- see mapOrder in
// storefront-order.ts. Reused for both the rejected and the accepted call
// below; only `error`/`data` differ.
const confirmedOrderRow = {
  number: 91,
  status: 'placed',
  payment_mode: 'on_collection',
  fulfilment: 'deliver',
  delivery_area: 'Hodan',
  customer_phone: '+252634456789',
  subtotal_cents: 1000,
  delivery_fee_cents: 500,
  total_cents: 1500,
  items: [{ product_id: 'p0', name: 'Product 0', unit_price_cents: 1000, quantity: 1, line_total_cents: 1000 }],
};

// ─────────────────────────────────────────────────────────────────────────
// THE CHECKOUT AND CONFIRMATION SCREENS -- the defect this whole file's
// extension exists to catch. `checkout.stage` (useCheckoutFlow,
// theme-shared.tsx) swaps the ENTIRE theme tree for `CheckoutScreen` then
// `ConfirmationScreen`; none of the describe blocks above ever moves it past
// 'browse', so neither screen had ever been swept. That is exactly how Back
// (17px), the form's name/phone/landmark/note fields (39px), the fulfilment
// toggle (35px) and "Place order" (41px) all sat under the floor -- on the
// one screen a customer actually commits an order from -- behind a fully
// green suite, live in a browser at 390px, not in this file. See
// checkout-form.tsx, theme-shared.tsx and order-placed.tsx's own comments on
// the fix each control needed.
//
// COVERAGE: both stages are reached by rendering ThemeMarket and driving the
// REAL useCheckoutFlow (theme-shared.tsx) through them -- 'checkout' via
// pressing `storefront-checkout-bar`, 'confirmation' via a submit that
// actually calls placeOrder (storefront-order.ts) against a mocked
// `supabase.rpc` -- rather than mounting `CheckoutScreen`/`ConfirmationScreen`
// directly. Both stages ARE reachable that way, so doing it through the
// theme is proof the WIRING (CheckoutBar's onPress -> openCheckout,
// CheckoutForm's onSubmit -> useCheckoutFlow.submit -> placeOrder) actually
// puts a customer on the same tree this sweep inspects -- the identical
// choice storefront-checkout-whatsapp-choice.test.tsx already made for the
// same reason. If a future stage genuinely cannot be reached this way, render
// that screen component directly instead -- but say so here, so the boundary
// is a stated fact rather than an assumption the next reader has to rediscover.
//
// Market only, for the same reason the cart/product-sheet describe block
// above is Market-only: CheckoutScreen and ConfirmationScreen are the exact
// same components under Market, Window and Counter -- all three themes pass
// identical props to the same two functions, with no theme-specific branch
// inside either for a second render to catch that this one does not.
describe('the checkout and confirmation screens the states above never reach', () => {
  const deliveryAreas: PublicDeliveryArea[] = [{ name: 'Hodan', feeCents: 500 }];

  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('checkout (delivery selected, a rejected submit) and confirmation: every control still carries the floor or a hitSlop', async () => {
    const tree = await renderTheme(ThemeMarket, deliveryAreas);

    // AN ITEM, THEN THE CHECKOUT BAR -- the one path from 'browse' to
    // `checkout.stage === 'checkout'`.
    press(tree, 'product-tile-add');
    press(tree, 'storefront-checkout-bar');

    // DELIVER, NOT COLLECT -- `shop.offersDelivery` is true and this render
    // passed an area, so `canDeliver` (checkout-form.tsx) is true and the
    // "Deliver" segment, its area rows and the landmark field all mount.
    // Staying on "Store pick-up" would leave three of the controls this task
    // floored (`checkout-form-fulfilment-deliver`, `checkout-form-area-Hodan`,
    // `checkout-form-landmark-input`) unswept -- the exact gap a zero-cart
    // render leaves for CartSheet and ProductSheet in the block above.
    press(tree, 'checkout-form-fulfilment-deliver');
    setText(tree, 'checkout-form-name-input', 'Amina Warsame');
    setText(tree, 'checkout-form-phone-input', '0634456789');
    press(tree, 'checkout-form-area-Hodan');
    setText(tree, 'checkout-form-landmark-input', 'Blue gate, behind the mosque');

    // A REJECTED SUBMIT -- the one client error (`unavailable_item`) that
    // renders a FOURTH control this screen only shows in this state:
    // `storefront-checkout-edit-cart` (theme-shared.tsx).
    mockRpc.mockRejectedValueOnce({ message: 'unavailable_item' });
    press(tree, 'checkout-form-submit');
    await flush();

    const checkoutControls = touchControlsIn(tree);
    // Guards the guard: Back, name, phone, both fulfilment segments, the one
    // area row, landmark, note, submit, submit-whatsapp and edit-cart is ten
    // -- the exact number matters less than a floor high enough that a
    // control silently missing from this render would shrink the count back
    // toward what the zero-cart sweep already reaches.
    expect(checkoutControls.length).toBeGreaterThan(9);
    const checkoutFailing = checkoutControls.filter((c) => !meetsTouchTargetRule(c));
    expect(checkoutFailing.map((c) => c.props?.testID)).toEqual([]);

    // NOW A SUCCESSFUL SUBMIT -- the only way `checkout.stage` reaches
    // 'confirmation'.
    mockRpc.mockResolvedValueOnce({ data: confirmedOrderRow, error: null });
    press(tree, 'checkout-form-submit');
    await flush();

    const confirmationControls = touchControlsIn(tree);
    // "Continue shopping" (ConfirmationScreen) and, since this fixture's
    // `hideBranding` is false, OrderPlaced's own "See how" -- two controls
    // that would otherwise be the exact regression this task fixed.
    expect(confirmationControls.length).toBeGreaterThan(1);
    const confirmationFailing = confirmationControls.filter((c) => !meetsTouchTargetRule(c));
    expect(confirmationFailing.map((c) => c.props?.testID)).toEqual([]);
  });
});
