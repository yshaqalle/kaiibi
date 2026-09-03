import { AccessibilityInfo, type EmitterSubscription, FlatList } from 'react-native';
import { act, create } from 'react-test-renderer';

import { ThemeWindow } from '@/components/storefront/theme-window';
import { SPACE } from '@/components/storefront/scale';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

// ThemeWindow mounts FlyerCarousel even with no flyers (its hooks run
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
  theme: 'window',
  palette: 'ink',
  headline: null,
  about: null,
  heroImageUrl: null,
  offersDelivery: true,
  collectAddress: null,
  collectNeighborhood: null,
  paymentMode: 'on_collection',
  openingHours: {},
  tradingSince: null, highlights: [],
  // No flyers: these fixtures predate them, and a shop with none must
  // render exactly as it did before they existed.
  flyers: [],
  autoAdvance: false,
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
async function renderWindow(slug: string) {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<ThemeWindow storefront={{ ...shop, slug }} products={products} colors={colors} />);
  });
  return tree;
}

describe('ThemeWindow', () => {
  // B6: the sticky CheckoutBar is `position: absolute` and reserves no
  // space of its own -- without this, its last-row content sits underneath
  // it the moment the cart goes from empty to non-empty.
  it('reserves extra bottom space for the sticky checkout bar once the cart is non-empty', async () => {
    const tree = await renderWindow('xamdi-window-b6-nonempty');
    const before = effectiveBottomPadding(tree.root.findByType(FlatList).props.contentContainerStyle);

    const addButtons = findByTestId(tree, 'product-tile-add');
    await act(async () => addButtons[0].props.onPress());

    const after = effectiveBottomPadding(tree.root.findByType(FlatList).props.contentContainerStyle);
    expect(after).toBeGreaterThan(before);

    // Drains VirtualizedList's own post-update cell-measurement timer before
    // this test ends, so it fires here (inside act) rather than after,
    // logged against whatever test is running by then.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });

  it('reserves no extra space while the cart is empty', async () => {
    const tree = await renderWindow('xamdi-window-b6-empty');
    const bottom = effectiveBottomPadding(tree.root.findByType(FlatList).props.contentContainerStyle);
    // The page gutter, not a number of its own -- both themes take it
    // from the shared scale now, so this asserts "no clearance added"
    // rather than pinning a padding that is free to be retuned.
    expect(bottom).toBe(SPACE.page);
  });
});

// Window is the ONLY theme that reads hero_image_url, and it used to lay that
// photo across the panel with StyleSheet.absoluteFill and then set the
// headline on top in `colors.ink` -- a near-black -- with nothing between
// them. A shop uploading a dark or busy photo got an unreadable headline, and
// no amount of choosing a good photo helps the shop that chooses a bad one.
//
// The scrim is the fix. These assert both halves: that it exists over a
// photo, and that the type stops being near-black once it does.
describe('ThemeWindow hero over a photo', () => {
  async function renderWithHero(heroImageUrl: string | null) {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <ThemeWindow
          storefront={{ ...shop, slug: 'xamdi-hero', heroImageUrl, headline: 'Power that stays on.' }}
          products={products}
          colors={colors}
        />,
      );
    });
    return tree;
  }

  function headlineColor(tree: ReturnType<typeof create>) {
    const node = tree.root.findAll((n) => n.props?.testID === 'storefront-headline')[0];
    const flat = [node.props.style].flat(Infinity).reduce((a, s) => ({ ...(a as object), ...(s as object) }), {}) as {
      color?: string;
    };
    return flat.color;
  }

  it('lays a scrim between the photo and the headline', async () => {
    const tree = await renderWithHero('https://example.test/hero.jpg');
    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-hero-scrim').length).toBeGreaterThan(0);
  });

  it('stops setting the headline in near-black once a photo is behind it', async () => {
    const tree = await renderWithHero('https://example.test/hero.jpg');
    expect(headlineColor(tree)).not.toBe(colors.ink);
  });

  // The no-photo branch is not a degraded state -- it is the majority case, and
  // it must read as the shop's own palette rather than inheriting a treatment
  // meant for a photo that isn't there.
  //
  // WHAT "THE SHOP'S OWN PALETTE" MEANS HERE CHANGED WITH THE BENTO PASS, and
  // the defect being guarded did not. It used to be `ink` type on a `soft`
  // panel; the shop card is now filled with `ink`, so the type is the palette's
  // own `ground`. Both are light-on-dark, which is why the original bug -- a
  // near-black headline set directly over an arbitrary photograph -- cannot
  // recur on either branch now.
  //
  // Asserted on CLAY rather than the file's `ink` palette on purpose: ink's
  // ground is #ffffff, which is also ON_SCRIM_INK, so the two branches would be
  // indistinguishable and this test would pass without measuring anything.
  // Clay's ground is #fdfaf7.
  it('sets the headline in the palette’s own ground, not the on-scrim white, with no photo', async () => {
    const clay = paletteColors('clay');
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <ThemeWindow
          storefront={{ ...shop, slug: 'xamdi-hero-clay', heroImageUrl: null, headline: 'Power that stays on.' }}
          products={products}
          colors={clay}
        />,
      );
    });
    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-hero-scrim')).toHaveLength(0);
    expect(headlineColor(tree)).toBe(clay.ground);
    expect(headlineColor(tree)).not.toBe('#ffffff');
  });

  // The claim the whole pass turns on: there is one inverted card, and it is
  // the shop. Without this, "bento" is just rounded corners.
  it('fills the shop card with the palette’s ink', async () => {
    const clay = paletteColors('clay');
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <ThemeWindow
          storefront={{ ...shop, slug: 'xamdi-card-clay', heroImageUrl: null }}
          products={products}
          colors={clay}
        />,
      );
    });
    const card = tree.root.findAll((n) => n.props?.testID === 'storefront-shop-card')[0];
    const flat = [card.props.style].flat(Infinity).reduce((a, s) => ({ ...(a as object), ...(s as object) }), {}) as {
      backgroundColor?: string;
    };
    expect(flat.backgroundColor).toBe(clay.ink);
  });
});

// The wordmark is the answer to "whose shop is this", which is the first
// question a forwarded WhatsApp link has to answer -- so it leads the hero
// rather than sitting at 15px above a louder slogan, and it appears exactly
// once on the page.
describe('ThemeWindow wordmark', () => {
  async function renderWith(over: Partial<PublicStorefront>) {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <ThemeWindow storefront={{ ...shop, slug: 'xamdi-wordmark', ...over }} products={products} colors={colors} />,
      );
    });
    return tree;
  }

  // Walks the SERIALISED tree, not `root.findAll`. RN renders a <Text> as a
  // composite element wrapping a host one, and both carry the same children --
  // so findAll counts every string twice and "appears once" can never pass.
  function allText(tree: ReturnType<typeof create>): string[] {
    const out: string[] = [];
    const walk = (node: unknown): void => {
      if (node == null) return;
      if (typeof node === 'string') { out.push(node); return; }
      if (Array.isArray(node)) { node.forEach(walk); return; }
      walk((node as { children?: unknown }).children);
    };
    walk(tree.toJSON());
    return out;
  }

  it('names the shop in the hero', async () => {
    const tree = await renderWith({});
    const mark = tree.root.findAll((n) => n.props?.testID === 'storefront-wordmark');
    expect(mark.length).toBeGreaterThan(0);
  });

  // It used to be in the nav AND would now also be in the hero -- the same
  // name twice on a 390px screen. That is what this guards, and it is a claim
  // about the HEADER: two occurrences within one screenful, neither of which
  // tells you anything the other did not.
  //
  // The footer prints the name once more, at the very bottom of the page, and
  // that is deliberate rather than a regression of this rule. A customer who
  // has scrolled a 200-product catalogue no longer has the wordmark on screen,
  // and a closing block of contact details and terms with no name on it is a
  // signature from nobody. Both facts are pinned below so neither can drift:
  // once in the header, once as the sign-off, and nowhere else at all.
  // Host elements only. `findAll` returns BOTH the composite `Text` and the
  // host element it renders to, and both carry the same `children`, so
  // counting every instance double-counts every string on the page.
  function namesUnder(node: ReturnType<ReturnType<typeof create>['root']['find']>) {
    return [node, ...node.findAll(() => true)]
      .filter((n) => typeof n.type === 'string')
      .flatMap((n) => [n.props?.children].flat(Infinity))
      .filter((c): c is string => typeof c === 'string')
      .filter((t) => t === shop.shopName || t === shop.shopName.toUpperCase());
  }

  it('does not also repeat the name in the nav', async () => {
    const tree = await renderWith({});
    const header = tree.root.find((n) => n.props?.testID === 'storefront-header');
    expect(namesUnder(header)).toHaveLength(1);
  });

  it('signs the page off in the footer, and says the name nowhere else', async () => {
    const tree = await renderWith({});
    const footer = tree.root.find((n) => n.props?.testID === 'storefront-footer');
    expect(namesUnder(footer)).toHaveLength(1);

    const everywhere = allText(tree).filter((t) => t === shop.shopName || t === shop.shopName.toUpperCase());
    expect(everywhere).toHaveLength(2);
  });

  it('sets the wordmark larger than the headline it leads', async () => {
    const tree = await renderWith({ headline: 'Power that stays on.' });
    const size = (testID: string) => {
      const node = tree.root.findAll((n) => n.props?.testID === testID)[0];
      const flat = [node.props.style].flat(Infinity).reduce((a, s) => ({ ...(a as object), ...(s as object) }), {}) as {
        fontSize?: number;
      };
      return flat.fontSize ?? 0;
    };
    expect(size('storefront-wordmark')).toBeGreaterThan(size('storefront-headline'));
  });

  // Composed from city + collectLocation, both already on the page object, so
  // it is never a lone separator with nothing either side of it.
  it('carries an eyebrow built from the shop’s own location', async () => {
    const tree = await renderWith({ city: 'Hargeisa', collectNeighborhood: 'Jigjiga Yar' });
    const eyebrow = tree.root.findAll((n) => n.props?.testID === 'storefront-eyebrow')[0];
    const text = [eyebrow.props.children].flat(Infinity).join('');
    expect(text).toContain('Hargeisa');
    expect(text).not.toMatch(/^ *·|· *$/);
  });

  it('renders no eyebrow at all when the shop has no location to name', async () => {
    const tree = await renderWith({ city: null, collectAddress: null, collectNeighborhood: null });
    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-eyebrow')).toHaveLength(0);
  });

  it('flips the wordmark to white over a photo', async () => {
    const tree = await renderWith({ heroImageUrl: 'https://example.test/hero.jpg' });
    const node = tree.root.findAll((n) => n.props?.testID === 'storefront-wordmark')[0];
    const flat = [node.props.style].flat(Infinity).reduce((a, s) => ({ ...(a as object), ...(s as object) }), {}) as {
      color?: string;
    };
    expect(flat.color).not.toBe(colors.ink);
  });
});
