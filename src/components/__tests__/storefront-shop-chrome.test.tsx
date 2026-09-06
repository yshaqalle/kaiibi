import { AccessibilityInfo, StyleSheet, type EmitterSubscription } from 'react-native';
import { act, create } from 'react-test-renderer';

import { ThemeMarket } from '@/components/storefront/theme-market';
import { PROSE_MAX_WIDTH, SHOP_MAX_WIDTH, SPACE } from '@/components/storefront/scale';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as EmitterSubscription);

const colors = paletteColors('ink');

// `about` text is what gives this shop an About tab at all (see
// availableTabs, shop-tabs.tsx) -- without it there is only one tab and
// ShopTabRail renders nothing.
const shop: PublicStorefront = {
  shopName: 'Barwaaqo Grocers',
  city: 'Hargeisa',
  slug: 'barwaaqo-chrome',
  whatsappE164: '+252634456789',
  theme: 'market',
  palette: 'ink',
  headline: 'Everything for the kitchen.',
  about: 'A family shop on the Hargeisa road since 1998.',
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

async function renderMarket() {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<ThemeMarket storefront={shop} products={[]} colors={colors} />);
  });
  return tree;
}

// SIBLING-ADJACENCY / ANCESTRY HELPERS, the same pattern
// storefront-product-sheet.test.tsx already uses (and explains at length) for
// the same reason: `toJSON()` yields HOST nodes only, and walking THAT tree
// is what lets a test check "is X actually wrapped in a maxWidth container"
// rather than merely "does a maxWidth container exist somewhere in the same
// tree" -- the weaker check an unscoped `findAll` would still pass under the
// exact defect this file exists to catch (the rail WAS bounded, elsewhere in
// the same tree as a full-bleed page, and a same-tree-only check cannot tell
// the two apart).
type HostNode = { type: string; props: Record<string, unknown>; children: unknown[] | null };

function pathToTestId(root: HostNode, testID: string, path: HostNode[] = []): HostNode[] | null {
  const next = [...path, root];
  if (root.props?.testID === testID) return next;
  for (const child of root.children ?? []) {
    if (typeof child === 'string') continue;
    const found = pathToTestId(child as HostNode, testID, next);
    if (found) return found;
  }
  return null;
}

function maxWidthsAlong(path: HostNode[]): unknown[] {
  return path
    .map((n) => StyleSheet.flatten(n.props?.style as never) as { maxWidth?: unknown } | undefined)
    .map((s) => s?.maxWidth)
    .filter((w) => w != null);
}

// Task 3 (wave-review-fixes.md item 3): the rail sat inside a
// `maxWidth: SHOP_MAX_WIDTH` column while the page below it went full-bleed
// -- at 1900px the first pill started at x~=306 against the anchor card's
// x=16. The rail has no reading-column argument of its own (it is a strip of
// controls, not a sentence); it takes its own SPACE.page inset directly
// (`rail`'s own `paddingHorizontal`, shop-tabs.tsx), the same way the page's
// header/goods/footer take theirs from `page.padding` rather than from a
// second, narrower wrapper layered on top.
describe('the tab rail lines up with the full-bleed page beneath it', () => {
  it('is not wrapped in a SHOP_MAX_WIDTH column', async () => {
    const tree = await renderMarket();
    const root = tree.toJSON() as HostNode;

    const path = pathToTestId(root, 'storefront-tab-shop');
    expect(path).not.toBeNull();

    const maxWidths = maxWidthsAlong(path as HostNode[]);
    expect(maxWidths).not.toContain(SHOP_MAX_WIDTH);
  });
});

// Task 3's second half: the About/Visit panel scroller kept
// `maxWidth: SHOP_MAX_WIDTH` after the page's own header/goods/footer lost
// it, so `ShopFooter` (rendered as this scroller's own trailing child, see
// shop-chrome.tsx) rendered at two different widths depending on which tab
// was open -- exactly the mismatch the comment beside it claimed to prevent.
// The panel scroller is full-bleed now, the same as the Shop tab's own page
// scroller; `prose` alone keeps a bound, and a narrower one
// (PROSE_MAX_WIDTH) than the grid ever had, because a paragraph is not a
// grid.
describe('the About/Visit panel is full-bleed, and only the prose narrows', () => {
  async function openAbout(tree: ReturnType<typeof create>) {
    const aboutTab = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-tab-about' && typeof n.props?.onPress === 'function',
    )[0];
    expect(aboutTab).toBeDefined();
    await act(async () => aboutTab.props.onPress());
  }

  it('does not bound the panel scroller to SHOP_MAX_WIDTH', async () => {
    const tree = await renderMarket();
    await openAbout(tree);

    const scroller = tree.root.findAll((n) => n.props?.testID === 'storefront-panel-scroll')[0];
    expect(scroller).toBeDefined();
    const scrollerStyle = StyleSheet.flatten(scroller.props.style as never) as { maxWidth?: unknown };
    expect(scrollerStyle.maxWidth).toBeUndefined();
  });

  it('gives the panel body the same horizontal inset the Shop tab gives its own header/goods/footer', async () => {
    const tree = await renderMarket();
    await openAbout(tree);

    const scroller = tree.root.findAll((n) => n.props?.testID === 'storefront-panel-scroll')[0];
    const bodyStyle = StyleSheet.flatten(scroller.props.contentContainerStyle as never) as {
      paddingHorizontal?: unknown;
    };
    expect(bodyStyle.paddingHorizontal).toBe(SPACE.page);
  });

  it('still narrows the prose (About panel) to PROSE_MAX_WIDTH, inside that same inset', async () => {
    const tree = await renderMarket();
    await openAbout(tree);

    const root = tree.toJSON() as HostNode;
    const path = pathToTestId(root, 'storefront-about-panel');
    expect(path).not.toBeNull();

    const maxWidths = maxWidthsAlong(path as HostNode[]);
    expect(maxWidths).toContain(PROSE_MAX_WIDTH);
    expect(maxWidths).not.toContain(SHOP_MAX_WIDTH);
  });
});
