import { AccessibilityInfo, type EmitterSubscription } from 'react-native';
import { act, create } from 'react-test-renderer';

import { ThemeCounter } from '@/components/storefront/theme-counter';
import { ThemeMarket } from '@/components/storefront/theme-market';
import { ThemeWindow } from '@/components/storefront/theme-window';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontFlyer, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));

// ThemeMarket/ThemeWindow render FlyerCarousel, whose mount effect now calls
// AccessibilityInfo.isReduceMotionEnabled() (Task 4). None of the tests here
// are about motion -- they are about where the band sits and what pressing a
// flyer does -- so this only needs a settled default, not per-test control.
// See storefront-flyer-carousel.test.tsx for the motion-specific spies.
beforeEach(() => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as EmitterSubscription);
});

const colors = paletteColors('ink');

type HostNode = { type: string; props: Record<string, unknown>; children: unknown[] | null };

// See storefront-flyer-carousel.test.tsx's identical helper -- toJSON() is
// host nodes in DOCUMENT ORDER, which is the whole point here: "below the
// blurb, above the goods" is a claim about order, and `tree.root.findAll`
// cannot make it.
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

const LANDMARKS = ['storefront-header', 'storefront-headline', 'storefront-about', 'storefront-flyer-band', 'storefront-goods'];

function landmarkOrder(tree: ReturnType<typeof create>): string[] {
  return hostNodes(tree)
    .map((node) => node.props?.testID)
    .filter((id): id is string => typeof id === 'string' && LANDMARKS.includes(id));
}

function withTestId(tree: ReturnType<typeof create>, testID: string): HostNode[] {
  return hostNodes(tree).filter((node) => node.props?.testID === testID);
}

const shop: PublicStorefront = {
  shopName: 'Xamdi Electronics',
  city: 'Hargeisa',
  slug: 'xamdi',
  whatsappE164: '+252634456789',
  theme: 'market',
  palette: 'ink',
  headline: 'Solar, phones and cable',
  about: 'Open every day but Friday morning.',
  heroImageUrl: null,
  offersDelivery: true,
  paymentMode: 'on_collection',
  flyers: [],
  autoAdvance: false,
};

const products: StorefrontProduct[] = [
  { id: 'p1', name: 'Solar lantern', description: null, category: 'Solar', priceCents: 1400, stock: 5, imageUrl: null },
  { id: 'p2', name: 'Anker 20W charger', description: null, category: 'Phone', priceCents: 1200, stock: 5, imageUrl: null },
];

const flyers: StorefrontFlyer[] = [
  {
    id: 'f1',
    imageUrl: 'https://cdn.example/shop/solar.jpg',
    headline: '20% off all solar',
    subline: 'This week only.',
    linkKind: 'category',
    linkValue: 'Solar',
    // The promotion's raw facts (20260930000300); the band words them through
    // offerCopyFor, the printed poster's own function.
    offer: {
      discountType: 'percentage', discountValue: 20,
      scope: 'category', scopeValue: 'Solar',
      startsAt: new Date(2026, 7, 14).toISOString(),
      endsAt: new Date(2026, 7, 17).toISOString(),
    },
  },
  {
    id: 'f2',
    imageUrl: 'https://cdn.example/shop/eid.jpg',
    headline: 'Eid stock has landed',
    subline: null,
    linkKind: 'none',
    linkValue: null,
    offer: null,
  },
];

// FlatList (via VirtualizedList) schedules a cell-measurement update on a
// real timer after mount -- an async act(), same as the other theme tests
// here, lets that settle inside the test rather than firing later and
// logging an "update not wrapped in act()" against whatever is running by
// then. Each render takes its own slug so storefront-cart.ts's module-level
// native cache cannot leak one test's basket into another's.
async function render(Theme: typeof ThemeMarket, slug: string, over: Partial<PublicStorefront> = {}) {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<Theme storefront={{ ...shop, slug, ...over }} products={products} colors={colors} />);
  });
  return tree;
}

describe('where the flyer band sits', () => {
  // Property 5. A customer arriving on a forwarded link needs to know whose
  // page this is before the loudest thing on it speaks, and the poster
  // belongs next to what it points at.
  it('Market puts the band below the shop name and blurb and above the goods', async () => {
    const tree = await render(ThemeMarket, 'xamdi-band-market', { flyers });
    expect(landmarkOrder(tree)).toEqual([
      'storefront-header',
      'storefront-headline',
      'storefront-about',
      'storefront-flyer-band',
      'storefront-goods',
    ]);
  });

  it('Window puts the band below the shop name and blurb and above the goods', async () => {
    const tree = await render(ThemeWindow, 'xamdi-band-window', { theme: 'window', flyers });
    expect(landmarkOrder(tree)).toEqual([
      'storefront-header',
      'storefront-headline',
      'storefront-about',
      'storefront-flyer-band',
      'storefront-goods',
    ]);
  });

  // Property 1, at the theme level: a page with no flyers looks exactly as it
  // does today.
  it('Market renders no band when the shop has no flyers', async () => {
    const tree = await render(ThemeMarket, 'xamdi-band-market-none');
    expect(withTestId(tree, 'storefront-flyer-band')).toHaveLength(0);
    expect(landmarkOrder(tree)).toEqual([
      'storefront-header',
      'storefront-headline',
      'storefront-about',
      'storefront-goods',
    ]);
  });

  it('Window renders no band when the shop has no flyers', async () => {
    const tree = await render(ThemeWindow, 'xamdi-band-window-none', { theme: 'window' });
    expect(withTestId(tree, 'storefront-flyer-band')).toHaveLength(0);
  });

  // Property 4. Counter is a price list built to make a 200-line catalogue
  // readable, and a poster fights the one thing that layout exists to do.
  // Deliberate, not an oversight -- pinned so it stays deliberate.
  it('Counter renders no flyers at all, even when the shop has them', async () => {
    const tree = await render(ThemeCounter, 'xamdi-band-counter', { theme: 'counter', flyers });
    expect(withTestId(tree, 'storefront-flyer-band')).toHaveLength(0);
    expect(withTestId(tree, 'storefront-flyer-slide')).toHaveLength(0);
  });
});

describe('a category flyer filters the page', () => {
  function pressable(tree: ReturnType<typeof create>, testID: string) {
    return tree.root.findAll((node) => node.props?.testID === testID && typeof node.props?.onPress === 'function');
  }

  function gridNames(tree: ReturnType<typeof create>): string[] {
    const list = tree.root.findAll((node) => node.props?.testID === 'storefront-goods' && Array.isArray(node.props?.data));
    return (list[0].props.data as StorefrontProduct[]).map((p) => p.name);
  }

  it('narrows Market to the named category and offers a way back', async () => {
    const tree = await render(ThemeMarket, 'xamdi-filter-market', { flyers });
    expect(gridNames(tree)).toEqual(['Solar lantern', 'Anker 20W charger']);
    expect(withTestId(tree, 'storefront-category-clear')).toHaveLength(0);

    await act(async () => pressable(tree, 'storefront-flyer-slide')[0].props.onPress());
    expect(gridNames(tree)).toEqual(['Solar lantern']);
    expect(withTestId(tree, 'storefront-category-clear')).toHaveLength(1);

    await act(async () => pressable(tree, 'storefront-category-clear')[0].props.onPress());
    expect(gridNames(tree)).toEqual(['Solar lantern', 'Anker 20W charger']);
    expect(withTestId(tree, 'storefront-category-clear')).toHaveLength(0);

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });

  it('narrows Window to the named category too', async () => {
    const tree = await render(ThemeWindow, 'xamdi-filter-window', { theme: 'window', flyers });

    await act(async () => pressable(tree, 'storefront-flyer-slide')[0].props.onPress());
    expect(gridNames(tree)).toEqual(['Solar lantern']);

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });
});
