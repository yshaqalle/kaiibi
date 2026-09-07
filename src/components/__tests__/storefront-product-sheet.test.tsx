import { AccessibilityInfo, Dimensions, StyleSheet, type EmitterSubscription } from 'react-native';
import { act, create } from 'react-test-renderer';

import { registerFlyTrigger, resetFlyToCartForTests, unregisterFlyTrigger } from '@/components/storefront/fly-to-cart';
import { photoHeightCapFor, ProductSheet, SHEET_MAX_WIDTH, sheetWidthFor } from '@/components/storefront/product-sheet';
import { ThemeMarket } from '@/components/storefront/theme-market';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as EmitterSubscription);

const colors = paletteColors('ink');

const shop: PublicStorefront = {
  shopName: 'Barwaaqo Grocers',
  city: 'Hargeisa',
  slug: 'barwaaqo-sheet',
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
  flyers: [],
  autoAdvance: false,
  hideBranding: false,
};

const rice: StorefrontProduct = {
  id: 'p1',
  name: 'Basmati Rice 5kg',
  description: 'Long-grain, aged twelve months. We can split a sack between two customers.',
  category: 'Dry goods',
  priceCents: 1200,
  stock: 6,
  imageUrl: null,
};

function textsOf(tree: ReturnType<typeof create>): string {
  return tree.root
    .findAll((n) => n.props?.children !== undefined)
    .flatMap((n) => [n.props.children].flat(Infinity))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

// products.description has been selected by the public RPC and mapped in
// storefront.ts since the storefront shipped, and was rendered by NO theme.
// Shopkeepers typed it; no customer ever saw a word of it. These assert that
// it now reaches one -- through the grid, the way a customer would get there.
describe('a product description reaches the customer', () => {
  it('shows the description once the tile is opened', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ThemeMarket storefront={shop} products={[rice]} colors={colors} />);
    });

    // Nothing of it on the grid itself -- a tile has no room for a paragraph.
    expect(textsOf(tree)).not.toContain('aged twelve months');

    const tile = tree.root.findAll(
      (n) => n.props?.testID === 'product-tile-open' && typeof n.props?.onPress === 'function',
    );
    expect(tile.length).toBeGreaterThan(0);

    await act(async () => tile[0].props.onPress());

    expect(textsOf(tree)).toContain('aged twelve months');
  });

  it('renders no description block when the shop left the field empty', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <ProductSheet
          product={{ ...rice, description: null }}
          colors={colors}
          shopName={shop.shopName}
          whatsappE164={shop.whatsappE164}
          onClose={jest.fn()}
          onAdd={jest.fn()}
        />,
      );
    });

    expect(tree.root.findAll((n) => n.props?.testID === 'product-sheet-description')).toHaveLength(0);
  });

  // `product` IS the open/closed state -- a second `visible` flag is how a
  // sheet ends up open with nothing in it.
  it('renders nothing at all with no product', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <ProductSheet
          product={null}
          colors={colors}
          shopName={shop.shopName}
          whatsappE164={shop.whatsappE164}
          onClose={jest.fn()}
          onAdd={jest.fn()}
        />,
      );
    });

    expect(tree.toJSON()).toBeNull();
  });

  // DECISION 4: ProductSheet renders inside an AppModal -- a separate native
  // window on iOS and Android -- so FlyToCartLayer's overlay (a sibling of
  // the GRID, mounted once in ShopChrome) is not part of what that window
  // draws. A dot arcing across a surface nobody watching the sheet can see
  // is worse than no animation at all, so ProductSheet passes
  // `canFlyToCart={false}` to the ProductActions it renders -- see
  // theme-shared.tsx's own comment on that prop. The cart update must still
  // happen; only the dot's flight is skipped.
  describe('fly-to-cart: the dot cannot fly from inside a modal window', () => {
    afterEach(() => {
      resetFlyToCartForTests();
    });

    it('never fires the fly-to-cart trigger, while the cart still updates', () => {
      const trigger = jest.fn();
      const onAdd = jest.fn();
      registerFlyTrigger(trigger);
      let tree!: ReturnType<typeof create>;
      act(() => {
        tree = create(
          <ProductSheet
            product={rice}
            colors={colors}
            shopName={shop.shopName}
            whatsappE164={shop.whatsappE164}
            onClose={jest.fn()}
            onAdd={onAdd}
          />,
        );
      });

      const add = tree.root.findAll(
        (n) => n.props?.testID === 'product-tile-add' && typeof n.props?.onPress === 'function',
      );
      act(() => add[0].props.onPress({ nativeEvent: { pageX: 40, pageY: 220 } }));

      expect(trigger).not.toHaveBeenCalled();
      expect(onAdd).toHaveBeenCalledWith(rice);
      unregisterFlyTrigger(trigger);
    });
  });

  it('adds to the cart and closes, so the cart count is not hidden behind it', () => {
    const onAdd = jest.fn();
    const onClose = jest.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <ProductSheet
          product={rice}
          colors={colors}
          shopName={shop.shopName}
          whatsappE164={shop.whatsappE164}
          onClose={onClose}
          onAdd={onAdd}
        />,
      );
    });

    const add = tree.root.findAll(
      (n) => n.props?.testID === 'product-tile-add' && typeof n.props?.onPress === 'function',
    );
    act(() => add[0].props.onPress());

    expect(onAdd).toHaveBeenCalledWith(rice);
    expect(onClose).toHaveBeenCalled();
  });
});

// A 1512x~700 laptop window is exactly what produced the screenshot this
// fix came from: no width bound on the sheet, and a 4:3 photo at that width
// stood ~1134px tall against a ~616px budget (`maxHeight: '88%'` of 700).
// See product-sheet.tsx's own comments on `sheetWidthFor` and
// `photoHeightCapFor` (above its `Props` type) for the reasoning behind the
// numbers this suite proves -- these tests exist to catch the pattern the
// module's own file-level brief warns about: a hard-coded number beside a
// function that is never actually called.
describe('the sheet fits the window it opens in', () => {
  describe('sheetWidthFor', () => {
    // Renamed from "fills a phone window edge to edge" -- that was a claim
    // about the RENDERED sheet, and it was false: a fixed pixel `width` of
    // 390 inside an overlay that ALSO pads itself (`padding: SPACE.cardGap`)
    // does not shrink for that padding, so the sheet rendered at 390 in a
    // window that also had to fit 14px of padding on each side of it,
    // touching both edges. The number this function returns below its own
    // cap is still exactly the window width -- that arithmetic was never
    // wrong -- but it is now applied as a `maxWidth` ceiling on a `width:
    // '100%'` box (see the sheet-fits-the-padding block below), the same
    // pair CartSheet's own `sheet` style already used, which is what lets
    // the overlay's padding actually take effect.
    it('is exactly the window width below its own cap', () => {
      expect(sheetWidthFor(390)).toBe(390);
    });

    it('is exactly its own cap at the cap', () => {
      expect(sheetWidthFor(SHEET_MAX_WIDTH)).toBe(SHEET_MAX_WIDTH);
    });

    it('never exceeds the cap, one pixel past it', () => {
      expect(sheetWidthFor(SHEET_MAX_WIDTH + 1)).toBe(SHEET_MAX_WIDTH);
    });

    it('stays capped on the 1512px laptop the defect was reported on', () => {
      expect(sheetWidthFor(1512)).toBe(SHEET_MAX_WIDTH);
    });
  });

  describe('photoHeightCapFor', () => {
    it('caps the short 1512x700 laptop window to 280', () => {
      expect(photoHeightCapFor(700)).toBe(280);
    });

    it('leaves an 844pt-tall phone window alone -- the photo keeps its natural 4:3 height', () => {
      expect(photoHeightCapFor(844)).toBe(338);
    });

    it('shrinks further on a very short window rather than floor at some fixed pixel count', () => {
      expect(photoHeightCapFor(500)).toBe(200);
    });

    it('grows on a very tall window rather than ceiling at some fixed pixel count', () => {
      expect(photoHeightCapFor(1300)).toBe(520);
    });
  });

  const riceWithPhoto: StorefrontProduct = { ...rice, imageUrl: 'https://example.test/rice.jpg' };

  function setWindow(width: number, height: number) {
    return act(async () => {
      Dimensions.set({
        window: { width, height, scale: 1, fontScale: 1 },
        screen: { width, height, scale: 1, fontScale: 1 },
      });
    });
  }

  function renderSheet() {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <ProductSheet
          product={riceWithPhoto}
          colors={colors}
          shopName={shop.shopName}
          whatsappE164={shop.whatsappE164}
          onClose={jest.fn()}
          onAdd={jest.fn()}
        />,
      );
    });
    return tree;
  }

  function sheetStyleOf(tree: ReturnType<typeof create>) {
    const sheet = tree.root.findAll((n) => n.props?.testID === 'product-sheet')[0];
    return StyleSheet.flatten(sheet.props.style);
  }

  function photoStyleOf(tree: ReturnType<typeof create>) {
    const photo = tree.root.findAll((n) => Boolean(n.props?.source?.uri))[0];
    return StyleSheet.flatten(photo.props.style);
  }

  // `Dimensions.set` is a process-global, not scoped to one `it` -- every
  // other test in this file relies on the ambient jest window (750x1334, the
  // `@react-native/jest-preset` default). This is the only block that moves
  // it, so it is also the only block that has to put it back (see
  // stock-count-modal.test.tsx's own comment on the identical pattern).
  afterEach(async () => {
    await setWindow(750, 1334);
  });

  // MUTATION: hard-code `sheetWidth` and `photoHeightCap` in ProductSheet to
  // fixed numbers instead of calling `sheetWidthFor`/`photoHeightCapFor`.
  // Every assertion below still passes EXCEPT the last two -- a hard-coded
  // number renders identically at both window sizes, which is exactly the
  // defect a value-only assertion (`maxHeight === 280`) cannot catch, and
  // exactly why this test compares the two renders to each other.
  //
  // `.maxWidth`, not `.width` -- see this file's own comment on
  // `sheetWidthFor` above. The sheet's own `width` is the static `'100%'`
  // CartSheet's `sheet` style already carries (checked separately, below);
  // `sheetWidthFor`'s result is the CEILING layered on top of it, and that
  // ceiling is what still has to differ between these two windows.
  it('caps the sheet narrower, and the photo shorter, on a 1512x700 laptop than on a 390x844 phone', async () => {
    await setWindow(1512, 700);
    const laptop = renderSheet();
    const laptopSheetStyle = sheetStyleOf(laptop);
    const laptopPhotoStyle = photoStyleOf(laptop);

    expect(laptopSheetStyle.maxWidth).toBe(sheetWidthFor(1512));
    expect(laptopPhotoStyle.maxHeight).toBe(photoHeightCapFor(700));

    await setWindow(390, 844);
    const phone = renderSheet();
    const phoneSheetStyle = sheetStyleOf(phone);
    const phonePhotoStyle = photoStyleOf(phone);

    expect(phoneSheetStyle.maxWidth).toBe(sheetWidthFor(390));
    expect(phonePhotoStyle.maxHeight).toBe(photoHeightCapFor(844));

    // Not just "correct at both sizes" -- actually DIFFERENT, which is what
    // proves the component calls the function on every render and passes
    // its result through, rather than a number hard-coded beside it.
    expect(laptopSheetStyle.maxWidth).not.toBe(phoneSheetStyle.maxWidth);
    expect(laptopPhotoStyle.maxHeight).not.toBe(phonePhotoStyle.maxHeight);
  });

  // THE DEFECT ITSELF (wave-review-fixes.md item 5): a fixed pixel `width`
  // does not shrink for a padded parent -- `overlay`'s own `padding:
  // SPACE.cardGap` -- the way a relative `width: '100%'` does. At 390px, a
  // sheet given a literal `width: 390` renders 390 wide inside a
  // (390 - 2*SPACE.cardGap)-wide padded box, i.e. touching both window edges
  // exactly where `overlay`'s own comment ("ending short of that edge")
  // says it must not. `width: '100%'` is what makes the overlay's padding
  // bind at all; `sheetWidthFor`'s result then caps how wide that 100% is
  // allowed to grow on a laptop. This is the same `width: '100%', maxWidth`
  // pair cart-sheet.tsx's own `sheet` style already uses, for the identical
  // overlay.
  it('sizes itself with a relative width, not a fixed pixel one, so the overlay padding actually applies', async () => {
    await setWindow(390, 844);
    const style = sheetStyleOf(renderSheet());
    expect(style.width).toBe('100%');
  });
});

// SIBLING-ADJACENCY HELPERS, on the pattern storefront-directory.test.tsx
// already uses for the same reason: `toJSON()` yields HOST nodes only, so
// walking them (rather than `tree.root.findAll`, which also returns every
// composite wrapper in between) is what can tell "B is not a DESCENDANT of
// A" from "B merely renders somewhere under the same tree as A" -- the
// weaker check a style-number assertion (or an unscoped `findAll`) would
// still pass under the exact defect this suite exists to catch. Copied
// rather than imported -- see that file's own comment on why (no
// cross-test-file imports).
type HostNode = { type: string; props: Record<string, unknown>; children: unknown[] | null };

function findByTestIdNode(root: HostNode, testID: string): HostNode | null {
  if (root.props?.testID === testID) return root;
  for (const child of root.children ?? []) {
    if (typeof child === 'string') continue;
    const found = findByTestIdNode(child as HostNode, testID);
    if (found) return found;
  }
  return null;
}

function subtreeHasTestId(node: HostNode, testID: string): boolean {
  if (node.props?.testID === testID) return true;
  return (node.children ?? []).some(
    (child) => typeof child !== 'string' && subtreeHasTestId(child as HostNode, testID),
  );
}

// The defect this task fixes: `products.description` has no clamp, no
// `numberOfLines`, no length limit in the schema -- and used to render
// ABOVE Add/Ask and Close, inside the same ScrollView as both. A long
// enough paragraph pushed the button that buys the product below the fold
// on a short window, same failure as the photo the earlier fix (see
// product-sheet.tsx's own comments on `sheetWidthFor`/`photoHeightCapFor`)
// addressed -- reached through text instead of a picture. These assert the
// STRUCTURE that makes the fix real: the action row and Close are outside
// the scrolling body (`product-sheet-scroll`) and inside the sheet
// (`product-sheet`), regardless of how tall the description is -- a fact
// react-test-renderer can check without ever laying out a single pixel.
describe('the action row cannot scroll out of reach behind a long description', () => {
  const longDescription = 'Long enough to push a footer off-screen if it still lived in the scroller. '.repeat(60);

  function renderSheet(onAdd = jest.fn(), onClose = jest.fn()) {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <ProductSheet
          product={{ ...rice, description: longDescription }}
          colors={colors}
          shopName={shop.shopName}
          whatsappE164={shop.whatsappE164}
          onClose={onClose}
          onAdd={onAdd}
        />,
      );
    });
    return tree;
  }

  it('renders Add/Ask and Close inside the sheet but outside the scrolling body', () => {
    const tree = renderSheet();
    const root = tree.toJSON() as HostNode;

    const sheet = findByTestIdNode(root, 'product-sheet');
    expect(sheet).not.toBeNull();
    expect(subtreeHasTestId(sheet as HostNode, 'product-tile-add')).toBe(true);
    expect(subtreeHasTestId(sheet as HostNode, 'product-sheet-close')).toBe(true);

    const scroller = findByTestIdNode(root, 'product-sheet-scroll');
    expect(scroller).not.toBeNull();
    // The description that used to sit directly above these two, in the
    // same scroller, still does -- this is not "the scroller lost its
    // content," it is "the actions were never content to begin with."
    expect(subtreeHasTestId(scroller as HostNode, 'product-sheet-description')).toBe(true);
    expect(subtreeHasTestId(scroller as HostNode, 'product-tile-add')).toBe(false);
    expect(subtreeHasTestId(scroller as HostNode, 'product-sheet-close')).toBe(false);
  });

  it('still adds to the cart and closes with a long description in play', () => {
    const onAdd = jest.fn();
    const onClose = jest.fn();
    const tree = renderSheet(onAdd, onClose);

    const add = tree.root.findAll(
      (n) => n.props?.testID === 'product-tile-add' && typeof n.props?.onPress === 'function',
    );
    act(() => add[0].props.onPress());

    expect(onAdd).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
