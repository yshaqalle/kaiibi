import { Image, StyleSheet, Text, View } from 'react-native';
import { act, create } from 'react-test-renderer';

import StoreDirectoryScreen from '@/app/store/index';
import { ON_SCRIM_INK, ON_SCRIM_MUTED } from '@/components/storefront/scale';
import {
  DIRECTORY_MAX_WIDTH, FeaturedShopCard, ShopDirectoryCard, directoryColumnsForWidth,
  directoryEntranceDelay, directoryHasEntered, markDirectoryEntered, resetDirectoryEnteredForTests,
} from '@/components/storefront/shop-directory-card';
import { DIRECTORY_STATE_OPEN, DIRECTORY_STATE_SHUT, KAIIBI_BLUE, KAIIBI_INK, paletteColors } from '@/lib/storefront-catalog';
import { weekdayKeyFor, type OpeningHours } from '@/lib/store-hours';
import type { PublicShopSummary } from '@/types/models';

const mockPush = jest.fn();
const mockList = jest.fn();

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('expo-router/head', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/storefront-directory', () => {
  const actual = jest.requireActual('@/lib/storefront-directory');
  return { ...actual, listPublicShops: (...args: unknown[]) => mockList(...args) };
});

const colors = paletteColors('ink');

function summary(overrides: Partial<PublicShopSummary> = {}): PublicShopSummary {
  return {
    shopName: 'Alpha Hardware', slug: 'dir-alpha', city: 'Hargeisa',
    headline: 'Everything that plugs in.', about: null, heroImageUrl: null,
    offersDelivery: true, openingHours: {}, categories: ['Electronics'], productCount: 4,
    ...overrides,
  };
}

beforeEach(() => {
  mockPush.mockReset();
  mockList.mockReset();
  mockList.mockResolvedValue([]);
});

// DIRECTORY_ENTERED (shop-directory-card.tsx) is module-level and outlives a
// single test, the same reason theme-shared.tsx's HERO_RISEN needs
// resetHeroRisenForTests -- without this, whichever test in this file
// happens to render a card first would spend the "first arrival" every
// later test's own directoryEntranceDelay assertions depend on.
afterEach(() => {
  resetDirectoryEnteredForTests();
});

async function renderScreen() {
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<StoreDirectoryScreen />); });
  return tree;
}

function has(tree: ReturnType<typeof create>, testID: string): boolean {
  return tree.root.findAll((n) => n.props?.testID === testID).length > 0;
}

function textOf(tree: ReturnType<typeof create>, testID: string): string {
  const node = tree.root.find((n) => n.props?.testID === testID);
  return [node, ...node.findAll(() => true)]
    .filter((n) => typeof n.type === 'string')
    .flatMap((n) => [n.props?.children].flat(Infinity))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function press(tree: ReturnType<typeof create>, testID: string) {
  const node = tree.root.find(
    (n) => n.props?.testID === testID && typeof n.props?.onPress === 'function',
  );
  act(() => { node.props.onPress(); });
}

// SIBLING-ADJACENCY HELPERS, on the pattern storefront-theme-market.test.tsx
// already uses for the same reason: `toJSON()` yields HOST nodes only, in
// document order, so walking IT (rather than `tree.root.findAll`, which also
// returns every composite wrapper in between) is what lets a test ask "is B
// the very next sibling of A", not merely "does B come after A somewhere" --
// the weaker check that stayed green through two wedged-content defects this
// branch already shipped (see the brief this task came from).
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

function nextDirectChildAfter(parent: HostNode, testID: string): HostNode | string | null {
  const children = parent.children ?? [];
  const idx = children.findIndex((child) => typeof child !== 'string' && subtreeHasTestId(child as HostNode, testID));
  if (idx === -1) return null;
  return (children[idx + 1] as HostNode | string | undefined) ?? null;
}

describe('the directory card', () => {
  function renderCard(shop: PublicShopSummary, onPress = jest.fn()) {
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<ShopDirectoryCard shop={shop} colors={colors} onPress={onPress} />); });
    return tree;
  }

  const CARD = 'storefront-directory-card-dir-alpha';
  const META = 'storefront-directory-meta-dir-alpha';
  const DOT = 'storefront-directory-dot-dir-alpha';
  const STATE = 'storefront-directory-state-dir-alpha';
  const TAGS = 'storefront-directory-tags-dir-alpha';
  const OVERFLOW = 'storefront-directory-tags-overflow-dir-alpha';

  it('opens the shop it names', () => {
    const onPress = jest.fn();
    const tree = renderCard(summary(), onPress);
    press(tree, CARD);
    expect(onPress).toHaveBeenCalledWith('dir-alpha');
  });

  // WAS "says what is in the shop [...] toContain('4 items')" -- invalidated
  // by the redesign: a numeric item count no longer renders on this card at
  // all (the mockup's own `.dcard` never carried one), replaced by the
  // sell-tags below. What is in the shop is now said through THOSE.
  it('says what is in the shop through its sell-tags, not a numeric count', () => {
    const text = textOf(renderCard(summary({ categories: ['Electronics', 'Phones'] })), CARD);
    expect(text).toContain('Electronics');
    expect(text).not.toContain('4 items');
    expect(text).not.toContain('items');
  });

  // "Nothing in today" reads as a broken card if the row is just silently
  // empty. A shop with nothing in stock has no categories either -- both are
  // derived from the same listed, in-stock products -- so this fixture sets
  // both to match what the RPC would actually hand the card.
  // REVIEW FINDING (whole-branch pass): "Nothing in today" now lives in the
  // SAME chip row as the sell-tags (`TAGS`, one vocabulary -- see the
  // component's own comment), not a second row of its own, so this fixture
  // is what proves the row still renders when it has nothing BUT that chip.
  it('says nothing in today rather than leaving the tags row empty', () => {
    const tree = renderCard(summary({ productCount: 0, categories: [] }));
    expect(textOf(tree, CARD)).toContain('Nothing in today');
    expect(has(tree, TAGS)).toBe(true);
  });

  it('marks a shop that delivers, and leaves the chip off one that does not', () => {
    expect(textOf(renderCard(summary({ offersDelivery: true })), CARD)).toContain('Delivers');
    expect(textOf(renderCard(summary({ offersDelivery: false })), CARD)).not.toContain('Delivers');
  });

  // REVIEW FINDING (whole-branch pass): "Delivers" and the sell-tags used to
  // be two visually different chip vocabularies (a quiet radius-8 tag here, a
  // louder radius-999 pill there) co-occurring on every shop that both stocks
  // something and delivers. One row, one shape now -- pinned two ways: the
  // structural ADJACENCY (Delivers is the tags row's own last chip, not a
  // second row bolted under it) and shape EQUALITY (its style is the exact
  // same computed object as a sell-tag's, not merely similarly sized) --
  // never a style number typed into the test itself.
  it('joins Delivers into the same row as the sell-tags, in the same shape, last', () => {
    const tree = renderCard(summary({ categories: ['Electronics', 'Phones'], offersDelivery: true }));
    const tagsRow = tree.root.find((n) => n.props?.testID === TAGS);
    // `findAllByType` is self-inclusive on a `View` instance -- slice(1)
    // drops the row's own container, leaving only its chip children.
    const chips = tagsRow.findAllByType(View).slice(1);

    const last = chips[chips.length - 1];
    expect(last.props.testID).toBe('storefront-directory-delivers-dir-alpha');

    const firstSellTag = chips[0];
    expect(StyleSheet.flatten(last.props.style)).toEqual(StyleSheet.flatten(firstSellTag.props.style));
    expect(StyleSheet.flatten(last.findByType(Text).props.style))
      .toEqual(StyleSheet.flatten(firstSellTag.findByType(Text).props.style));
  });

  // The majority case: a shop that has uploaded no hero image must still read
  // as designed rather than as a missing picture.
  it('falls back to a monogram rather than an empty box', () => {
    expect(textOf(renderCard(summary({ heroImageUrl: null })), CARD)).toContain('A');
  });

  it('names the shop and its city to a screen reader in one label', () => {
    const tree = renderCard(summary());
    const node = tree.root.find(
      (n) => n.props?.testID === CARD && n.props?.accessibilityLabel,
    );
    expect(node.props.accessibilityLabel).toBe('Alpha Hardware, Hargeisa, 4 items');
  });

  // WAS the on-photo pill's own test -- see "shows no badge at all" and the
  // two "badges a shop..." tests on the full screen below, which still pass
  // unchanged because the WORD alone (no dot, no city) still renders under
  // the same `storefront-directory-state-<slug>` testID. What is new here is
  // the dot beside it, and that the two are in the SAME row.
  describe('the meta line: a dot AND a word, never colour alone', () => {
    const allDay = { open: '00:00', close: '23:59' };
    const openHours = { mon: [allDay], tue: [allDay], wed: [allDay], thu: [allDay], fri: [allDay], sat: [allDay], sun: [allDay] };
    const shutHours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };

    it('says Open and the city, dot first, word beside it, in the same row', () => {
      const tree = renderCard(summary({ openingHours: openHours, city: 'Hargeisa' }));
      expect(textOf(tree, META)).toBe('Open · Hargeisa');

      // ADJACENCY, NOT MERE PRESENCE -- the exact defect class this branch
      // has shipped twice before (see the brief this task came from). The
      // dot's very next sibling inside the meta row has to be the state
      // word, not merely present somewhere in the card.
      const root = tree.toJSON() as HostNode;
      const meta = findByTestIdNode(root, META);
      expect(meta).not.toBeNull();
      const afterDot = nextDirectChildAfter(meta as HostNode, DOT);
      expect(afterDot).not.toBeNull();
      expect(typeof afterDot === 'string' ? false : subtreeHasTestId(afterDot as HostNode, STATE)).toBe(true);
    });

    it('fills the dot green when open and grey when closed, from the fixed catalogue pair', () => {
      const openDot = renderCard(summary({ openingHours: openHours })).root.find((n) => n.props?.testID === DOT);
      expect(StyleSheet.flatten(openDot.props.style).backgroundColor).toBe(DIRECTORY_STATE_OPEN);

      const shutDot = renderCard(summary({ openingHours: shutHours })).root.find((n) => n.props?.testID === DOT);
      expect(StyleSheet.flatten(shutDot.props.style).backgroundColor).toBe(DIRECTORY_STATE_SHUT);
    });

    // REVIEW FINDING (whole-branch pass): this used to put the reopening
    // estimate IN PLACE OF the city -- after hours that is every shop with
    // hours configured, so a grid of twenty cards all read "Closed · opens
    // tomorrow, 8am" with no city anywhere, on a directory whose primary axis
    // IS place. The city stays; the estimate is additional, said after it --
    // the mockup's own copy, verbatim, for the reopening half (see
    // nextOpeningLabel, store-hours.ts). Built off the REAL clock's own
    // today/tomorrow (weekdayKeyFor), the same way ShopDirectoryCard itself
    // computes "now" -- rather than a fixed weekday, which would only happen
    // to say "tomorrow" on five days out of seven.
    it('says when a closed shop reopens, WITHOUT losing the city', () => {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      const hours: OpeningHours = {
        [weekdayKeyFor(now)]: [],
        [weekdayKeyFor(tomorrow)]: [{ open: '08:00', close: '18:00' }],
      };
      const tree = renderCard(summary({ openingHours: hours, city: 'Hargeisa' }));
      expect(textOf(tree, META)).toBe('Closed · Hargeisa · opens tomorrow, 8am');
    });

    // A closed shop with no city on file at all still gets the reopening
    // estimate -- the two are independent segments now, not one replacing
    // the other, so the absence of one is not the absence of both.
    it('says when a closed shop reopens, even with no city on file at all', () => {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      const hours: OpeningHours = {
        [weekdayKeyFor(now)]: [],
        [weekdayKeyFor(tomorrow)]: [{ open: '08:00', close: '18:00' }],
      };
      const tree = renderCard(summary({ openingHours: hours, city: null }));
      expect(textOf(tree, META)).toBe('Closed · opens tomorrow, 8am');
    });

    // REVIEW FINDING (Task 20): the only test that used to touch this state
    // asserted the DOT's colour and never the rendered text, so a future edit
    // could print "Closed · " with a dangling separator, or drop the city
    // entirely, and the suite would stay green. `shutHours` (this block's own
    // fixture) is closed on every day of the week, so nextOpeningLabel finds
    // no valid range anywhere it looks and returns null -- REGARDLESS of the
    // real clock, unlike a fixture keyed to a single weekday -- which is
    // exactly the `closedLabel ?? shop.city` branch (shop-directory-card.tsx)
    // this test exists to pin. State word, separator and city, all three, in
    // the order they actually render.
    it('reads as the state, the separator and the city -- closed, with nothing reopening this week', () => {
      const tree = renderCard(summary({ openingHours: shutHours, city: 'Hargeisa' }));
      expect(textOf(tree, META)).toBe('Closed · Hargeisa');
    });

    // Never colour alone: the word says the same thing colour does, for a
    // reader who cannot tell the two dot colours apart.
    it('never shows a dot without the word beside it', () => {
      const tree = renderCard(summary({ openingHours: openHours }));
      expect(has(tree, DOT)).toBe(true);
      expect(textOf(tree, META)).toContain('Open');
    });

    // ABSENCE, not a guess: a shop that has never set hours gets neither a
    // dot nor a word -- "Closed" would be a claim nobody made.
    it('shows no dot and no word at all for a shop that never set hours, keeping just the city', () => {
      const tree = renderCard(summary({ openingHours: {}, city: 'Hargeisa' }));
      expect(has(tree, DOT)).toBe(false);
      expect(has(tree, STATE)).toBe(false);
      expect(textOf(tree, META)).toBe('Hargeisa');
    });
  });

  describe('sell-tags: quiet chips from what the shop actually stocks', () => {
    it('shows every category up to the cap, with no overflow chip when none is left over', () => {
      const tree = renderCard(summary({ categories: ['Spice', 'Tea'] }));
      const text = textOf(tree, TAGS);
      expect(text).toContain('Spice');
      expect(text).toContain('Tea');
      expect(has(tree, OVERFLOW)).toBe(false);
    });

    // The mockup's own shape: two tags, then a "+N" chip for the rest.
    it('caps the visible tags and folds the remainder into one overflow chip', () => {
      const tree = renderCard(summary({
        categories: ['Serum', 'Cleanser', 'Toner', 'Moisturiser', 'Sunscreen', 'Mask', 'Oil', 'Mist', 'Balm'],
      }));
      const tagsText = textOf(tree, TAGS);
      expect(tagsText).toContain('Serum');
      expect(tagsText).toContain('Cleanser');
      expect(tagsText).not.toContain('Toner');
      expect(textOf(tree, OVERFLOW)).toBe('+7');
    });

    // REVIEW FINDING (whole-branch pass): "no tags row at all" used to be
    // true for `categories: []` because "Nothing in today" rendered in a
    // SEPARATE, un-tested row -- now that row is gone (one chip vocabulary,
    // one row -- see the component's own comment), so a shop with nothing
    // categorised still gets this row, carrying only the stand-in chip.
    it('shows only the stand-in chip, no sell-tag text, for a shop with nothing categorised', () => {
      const tree = renderCard(summary({ categories: [], offersDelivery: false }));
      expect(has(tree, TAGS)).toBe(true);
      expect(textOf(tree, TAGS)).toBe('Nothing in today');
      expect(has(tree, OVERFLOW)).toBe(false);
    });
  });

  // The blurb used to be a two-line paragraph on this card -- the tags above
  // are what replaced it, and this is the negative half of that trade.
  it('no longer carries the two-line blurb this card used to show', () => {
    const text = textOf(renderCard(summary({ headline: 'A blurb once lived here.' })), CARD);
    expect(text).not.toContain('A blurb once lived here.');
  });
});

describe('directoryEntranceDelay: the pure decision behind the grid entrance', () => {
  afterEach(() => { resetDirectoryEnteredForTests(); });

  it('never animates under reduced motion, at any index', () => {
    expect(directoryEntranceDelay(true, false, 0)).toBeNull();
    expect(directoryEntranceDelay(true, false, 5)).toBeNull();
  });

  it('staggers a first arrival by index', () => {
    expect(directoryEntranceDelay(false, false, 0)).toBe(0);
    expect(directoryEntranceDelay(false, false, 3)).toBe(120);
  });

  it('never animates a second arrival, regardless of index', () => {
    expect(directoryEntranceDelay(false, true, 0)).toBeNull();
  });

  it('tracks entry through markDirectoryEntered, reset for tests through resetDirectoryEnteredForTests', () => {
    expect(directoryHasEntered()).toBe(false);
    markDirectoryEntered();
    expect(directoryHasEntered()).toBe(true);
    resetDirectoryEnteredForTests();
    expect(directoryHasEntered()).toBe(false);
  });
});

// THE FEATURED CARD -- a photo hero when the pick has one, the original
// ink-filled block when it does not. Rendered here directly, the same way
// `ShopDirectoryCard` is above, rather than only through 3+ shops on the
// full screen: `featuredShop()`'s own gating (FEATURE_MINIMUM, in-stock) is
// covered by its own tests in shop-directory-card.tsx, and this card's
// rendering does not need three shops to exercise.
describe('the featured card', () => {
  function renderFeatured(
    shop: PublicShopSummary, wide = true, onPress = jest.fn(), cardColors = colors,
  ) {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FeaturedShopCard shop={shop} colors={cardColors} wide={wide} onPress={onPress} />);
    });
    return tree;
  }

  function photoShop(overrides: Partial<PublicShopSummary> = {}): PublicShopSummary {
    return summary({
      slug: 'dir-feat',
      heroImageUrl: 'https://example.com/feat.jpg',
      city: 'Hargeisa',
      categories: ['Menswear'],
      ...overrides,
    });
  }

  const CARD = 'storefront-directory-featured-dir-feat';
  const PHOTO = 'storefront-directory-featured-photo-dir-feat';
  const SCRIM = 'storefront-directory-featured-scrim-dir-feat';
  const NAME = 'storefront-directory-featured-name-dir-feat';
  const STATE = 'storefront-directory-featured-state-dir-feat';
  const VISIT = 'storefront-directory-featured-visit-dir-feat';

  it('opens the shop it names', () => {
    const onPress = jest.fn();
    const tree = renderFeatured(photoShop(), true, onPress);
    press(tree, CARD);
    expect(onPress).toHaveBeenCalledWith('dir-feat');
  });

  // ADJACENCY, NOT ORDER -- the exact defect class this branch has already
  // shipped twice (see the brief this task came from). `findAll` returning
  // the photo before the scrim somewhere in the tree would stay green even
  // with unrelated content wedged between them; this asks the stronger
  // question, that the scrim is the photo's very next sibling, which is what
  // actually guarantees "over" rather than merely "also present".
  it('paints the scrim as the photo\'s very next sibling', () => {
    const tree = renderFeatured(photoShop());
    const root = tree.toJSON() as HostNode;
    const card = findByTestIdNode(root, CARD);
    expect(card).not.toBeNull();

    const afterPhoto = nextDirectChildAfter(card as HostNode, PHOTO);
    expect(afterPhoto).not.toBeNull();
    expect(typeof afterPhoto === 'string' ? false : subtreeHasTestId(afterPhoto as HostNode, SCRIM))
      .toBe(true);
  });

  // The same adjacency question run one layer up: the name has to sit
  // directly after the scrim (RN paints later siblings over earlier ones),
  // not merely somewhere later in the card -- otherwise a future edit could
  // wedge the name behind the scrim instead of on top of it and this would
  // not notice.
  it('sits the shop name directly after the scrim, not merely somewhere after it', () => {
    const tree = renderFeatured(photoShop());
    const root = tree.toJSON() as HostNode;
    const card = findByTestIdNode(root, CARD);

    const afterScrim = nextDirectChildAfter(card as HostNode, SCRIM);
    expect(afterScrim).not.toBeNull();
    expect(typeof afterScrim === 'string' ? false : subtreeHasTestId(afterScrim as HostNode, NAME))
      .toBe(true);
  });

  // THE OTHER DIRECTION, proved by absence rather than by something else
  // standing in for it: a shop with no photo gets no gradient node at all,
  // not merely one that's positioned oddly.
  it('renders no scrim at all when the shop has no photo', () => {
    const tree = renderFeatured(summary({ slug: 'dir-feat', heroImageUrl: null }));
    expect(has(tree, SCRIM)).toBe(false);
    expect(has(tree, PHOTO)).toBe(false);
  });

  // The chip's count sits in its own JSX expression (`Browse {n} items`), so
  // it lands in the host node's `children` as a separate NUMBER, not folded
  // into one string -- `textOf` (this file's helper) only collects strings,
  // so it is read directly off the Text node's children here instead.
  it('keeps the ink-filled blurb and the item chip for a shop with no photo', () => {
    const tree = renderFeatured(summary({ slug: 'dir-feat', heroImageUrl: null, productCount: 7 }));
    const chip = tree.root.findAllByType(Text).find((t: { props: { children?: unknown } }) => {
      const kids = [t.props.children].flat(Infinity);
      return kids.includes(7) && kids.some((k) => typeof k === 'string' && k.includes('Browse'));
    });
    expect(chip).toBeTruthy();
  });

  // The blurb and the item chip are what the hero photo replaces -- a
  // sentence of prose and a count both fight the name for legibility on a
  // photograph, and "Visit shop" is the way in instead.
  it('drops the blurb and the item chip once there is a photo to lead with', () => {
    const tree = renderFeatured(photoShop({
      about: 'A very long paragraph about the shop that used to run here in full.',
      productCount: 7,
    }));
    const text = textOf(tree, CARD);
    expect(text).not.toContain('Browse');
    expect(text).not.toContain('items');
  });

  it('still says "Most to browse" over a photo -- the label the plan is built on', () => {
    expect(textOf(renderFeatured(photoShop()), CARD)).toContain('Most to browse');
  });

  // On the `ink` palette (this page's own) `ground` happens to be white too,
  // the same value as ON_SCRIM_INK -- so proving this is the FIXED constant,
  // not a palette-derived one that would drift on another palette, needs a
  // palette whose ground actually differs from it.
  it('sets the shop name in kaiibi\'s fixed on-scrim ink, not the palette\'s', () => {
    const palm = paletteColors('palm');
    const tree = renderFeatured(photoShop(), true, jest.fn(), palm);
    const node = tree.root.find((n) => n.props?.testID === NAME);
    const flattened = StyleSheet.flatten(node.props.style) as { color?: string };
    expect(flattened.color).toBe(ON_SCRIM_INK);
    expect(flattened.color).not.toBe(palm.ground);
  });

  it('joins the city and the shop\'s first category into one meta line', () => {
    const tree = renderFeatured(photoShop({ city: 'Hargeisa', categories: ['Menswear', 'Shoes'] }));
    const text = textOf(tree, CARD);
    expect(text).toContain('Hargeisa · Menswear');
    const node = tree.root.find((n) => n.props?.testID === NAME).parent!.findAll(
      (n) => typeof n.props?.children === 'string' && n.props.children.includes('·'),
    )[0];
    expect(StyleSheet.flatten(node.props.style).color).toBe(ON_SCRIM_MUTED);
  });

  it('degrades to just the city when the shop has listed no category', () => {
    const text = textOf(renderFeatured(photoShop({ city: 'Hargeisa', categories: [] })), CARD);
    expect(text).toContain('Hargeisa');
    expect(text).not.toContain('·');
  });

  it('degrades to just the category when the shop has no city on file', () => {
    const text = textOf(renderFeatured(photoShop({ city: null, categories: ['Menswear'] })), CARD);
    expect(text).toContain('Menswear');
    expect(text).not.toContain('·');
  });

  it('shows no meta line at all when neither city nor category is on file', () => {
    const text = textOf(renderFeatured(photoShop({ city: null, categories: [] })), CARD);
    expect(text).not.toContain('·');
  });

  // Word AND fill, never colour alone -- the same rule the shop page's own
  // anchor and the grid card both already follow.
  it('badges an open shop over its photo', () => {
    const allDay = { open: '00:00', close: '23:59' };
    const tree = renderFeatured(photoShop({
      openingHours: { mon: [allDay], tue: [allDay], wed: [allDay], thu: [allDay], fri: [allDay], sat: [allDay], sun: [allDay] },
    }));
    expect(textOf(tree, STATE)).toBe('Open now');
  });

  it('badges a closed shop over its photo', () => {
    const tree = renderFeatured(photoShop({
      openingHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    }));
    expect(textOf(tree, STATE)).toBe('Closed now');
  });

  // Absent is honest; a badge claiming a state the shop never gave would not
  // be -- the identical rule the grid card's own pill and the shop page's
  // anchor already follow.
  it('shows no open badge at all for a shop that never set hours', () => {
    const tree = renderFeatured(photoShop({ openingHours: {} }));
    expect(has(tree, STATE)).toBe(false);
  });

  // The open state is said in colour and in a pill, neither of which a
  // screen reader gets -- the same fix the grid card already carries
  // (shop-directory-card.tsx:38-45), now applied here too.
  it('carries the open state in the accessibility label, in words', () => {
    const allDay = { open: '00:00', close: '23:59' };
    const open = renderFeatured(photoShop({
      openingHours: { mon: [allDay], tue: [allDay], wed: [allDay], thu: [allDay], fri: [allDay], sat: [allDay], sun: [allDay] },
    }));
    const openNode = open.root.find((n) => n.props?.testID === CARD);
    expect(openNode.props.accessibilityLabel).toContain('open now');

    const shut = renderFeatured(photoShop({
      openingHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    }));
    const shutNode = shut.root.find((n) => n.props?.testID === CARD);
    expect(shutNode.props.accessibilityLabel).toContain('closed now');

    const unset = renderFeatured(photoShop({ openingHours: {} }));
    const unsetNode = unset.root.find((n) => n.props?.testID === CARD);
    expect(unsetNode.props.accessibilityLabel).not.toContain('open now');
    expect(unsetNode.props.accessibilityLabel).not.toContain('closed now');
  });

  // EFFECT, not call: the button must actually render filled in kaiibi's own
  // blue with white ink, read off the composed style rather than retyping
  // the hex here -- the same discipline the masthead's mark plate and the
  // selected filter chip are held to (see KAIIBI_BLUE, storefront-catalog.ts).
  // This is the third and, per the plan, last call site for that colour.
  it('fills the Visit-shop plate in kaiibi\'s own blue with white ink', () => {
    const tree = renderFeatured(photoShop());
    const plate = tree.root.find((n) => n.props?.testID === VISIT);
    const flattened = StyleSheet.flatten(plate.props.style) as { backgroundColor?: string };
    expect(flattened.backgroundColor).toBe(KAIIBI_BLUE);
    expect(flattened.backgroundColor).not.toBe(colors.ink);

    const label = plate.findAllByType(Text).find((t: { props: { children?: unknown } }) => t.props.children === 'Visit shop')!;
    expect(StyleSheet.flatten(label.props.style).color).toBe(KAIIBI_INK);
  });

  // TWO OVERLAPPING TARGETS FOR ONE DESTINATION is the defect a real nested
  // Pressable here would be: the card is already the one press target
  // (`accessibilityRole="link"` on it names the destination), so the plate
  // must be a plain View with no press handler of its own for anything to
  // land on the card underneath it.
  it('renders the Visit-shop plate as a non-interactive View, not a second Pressable', () => {
    const tree = renderFeatured(photoShop());
    const plate = tree.root.find((n) => n.props?.testID === VISIT);
    expect(plate.type).toBe(View);
    expect(plate.props.onPress).toBeUndefined();
  });

  it('renders no Visit-shop plate at all for a shop with no photo', () => {
    const tree = renderFeatured(summary({ slug: 'dir-feat', heroImageUrl: null }));
    expect(has(tree, VISIT)).toBe(false);
  });
});

describe('how many columns the directory takes', () => {
  it('climbs to four as the window grows', () => {
    expect(directoryColumnsForWidth(390)).toBe(1);
    expect(directoryColumnsForWidth(800)).toBe(2);
    expect(directoryColumnsForWidth(1100)).toBe(3);
    expect(directoryColumnsForWidth(1280)).toBe(4);
  });

  // THE PAIR THAT HAS TO STAY IN STEP. The directory is bounded wider than a
  // shop page because it is a grid, not a reading column -- and a wider bound
  // with no extra column just makes three cards fatter, which is the same
  // defect (a third of a laptop screen doing nothing) wearing different
  // clothes. Pinned together so neither can move alone.
  it('gains its fourth column at a width the page is actually allowed to reach', () => {
    expect(DIRECTORY_MAX_WIDTH).toBeGreaterThanOrEqual(1240);
    expect(directoryColumnsForWidth(DIRECTORY_MAX_WIDTH)).toBe(4);
  });
});

describe('the directory screen', () => {
  it('shows a shape rather than a spinner while it loads', async () => {
    // Never resolves, so the loading state is what renders.
    mockList.mockReturnValue(new Promise(() => {}));
    const tree = await renderScreen();
    expect(has(tree, 'storefront-directory-skeleton')).toBe(true);
  });

  it('lists the shops it was given', async () => {
    mockList.mockResolvedValue([summary(), summary({ slug: 'dir-beta', shopName: 'Beta Grocers' })]);
    const tree = await renderScreen();
    expect(has(tree, 'storefront-directory-card-dir-alpha')).toBe(true);
    expect(has(tree, 'storefront-directory-card-dir-beta')).toBe(true);
  });

  it('opens a shop page when a card is pressed', async () => {
    mockList.mockResolvedValue([summary()]);
    const tree = await renderScreen();
    press(tree, 'storefront-directory-card-dir-alpha');
    expect(mockPush).toHaveBeenCalledWith('/store/dir-alpha');
  });

  // One city is a filter to everything, which is a control that never does
  // anything -- the rule CategoryBand already applies to itself.
  it('offers no city chips when every shop is in the same city', async () => {
    mockList.mockResolvedValue([summary(), summary({ slug: 'dir-beta' })]);
    const tree = await renderScreen();
    expect(has(tree, 'storefront-directory-city-Hargeisa')).toBe(false);
  });

  it('narrows to a city without going back to the network', async () => {
    mockList.mockResolvedValue([summary(), summary({ slug: 'dir-beta', city: 'Borama' })]);
    const tree = await renderScreen();
    expect(mockList).toHaveBeenCalledTimes(1);

    press(tree, 'storefront-directory-city-Borama');
    expect(has(tree, 'storefront-directory-card-dir-beta')).toBe(true);
    expect(has(tree, 'storefront-directory-card-dir-alpha')).toBe(false);
    // The filter is in memory: tapping a chip must not refetch.
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it('goes back to every city from a filtered one', async () => {
    mockList.mockResolvedValue([summary(), summary({ slug: 'dir-beta', city: 'Borama' })]);
    const tree = await renderScreen();

    press(tree, 'storefront-directory-city-Borama');
    expect(has(tree, 'storefront-directory-card-dir-alpha')).toBe(false);

    press(tree, 'storefront-directory-city-All cities');
    expect(has(tree, 'storefront-directory-card-dir-alpha')).toBe(true);
    expect(has(tree, 'storefront-directory-card-dir-beta')).toBe(true);
  });

  // THE REASON THERE IS NO "no shops in <city>" EMPTY STATE. Every chip is
  // derived from a shop in the list, so choosing one can never empty the grid.
  // Pinned as a property rather than left to the comment in the route: if the
  // chips ever stop being derived, this fails and the empty state has to come
  // back with them.
  it('can never filter to a city with nothing in it, because the chips come from the shops', async () => {
    mockList.mockResolvedValue([
      summary({ slug: 'a', city: 'Hargeisa' }),
      summary({ slug: 'b', city: 'Borama' }),
      summary({ slug: 'c', city: 'Berbera' }),
    ]);
    const tree = await renderScreen();

    for (const city of ['Hargeisa', 'Borama', 'Berbera']) {
      press(tree, `storefront-directory-city-${city}`);
      expect(has(tree, 'storefront-directory-empty')).toBe(false);
    }
  });

  // Unlike the shop page, this one admits a failed read: the directory has no
  // secret to keep, so "we couldn't load" is honest and actionable.
  it('says the read failed, and offers to try again', async () => {
    mockList.mockRejectedValue(new Error('network'));
    const tree = await renderScreen();
    expect(textOf(tree, 'storefront-directory-empty')).toContain("couldn't load");

    mockList.mockResolvedValue([summary()]);
    await act(async () => { press(tree, 'storefront-directory-empty-action'); });
    expect(has(tree, 'storefront-directory-card-dir-alpha')).toBe(true);
  });

  // THE SEARCH FIELD IS PART OF THE HERO, not a control that earns its place by
  // count. It used to be gated behind a six-shop minimum borrowed from the shop
  // page, and on a two-shop directory that left the hero with a hole in it --
  // the composition is tag, headline, lede, field. Redundant beats broken.
  it('shows the search field even for a directory of two', async () => {
    mockList.mockResolvedValue([summary(), summary({ slug: 'b' })]);
    const tree = await renderScreen();
    expect(has(tree, 'storefront-directory-search')).toBe(true);
  });

  it('offers a way back to the marketing site and a way to open a shop', async () => {
    mockList.mockResolvedValue([summary()]);
    const tree = await renderScreen();
    press(tree, 'storefront-directory-home');
    expect(mockPush).toHaveBeenCalledWith('/');
    press(tree, 'storefront-directory-open-shop');
    expect(mockPush).toHaveBeenCalledWith('/signup');
  });

  it('narrows to what was typed, without going back to the network', async () => {
    mockList.mockResolvedValue([
      summary({ slug: 'a', shopName: 'Alpha Hardware' }),
      summary({ slug: 'b', shopName: 'Baraka Grocers' }),
      summary({ slug: 'c' }), summary({ slug: 'd' }), summary({ slug: 'e' }), summary({ slug: 'f' }),
    ]);
    const tree = await renderScreen();
    const field = tree.root.find((n) => n.props?.testID === 'storefront-directory-search');
    act(() => { field.props.onChangeText('baraka'); });

    expect(has(tree, 'storefront-directory-card-b')).toBe(true);
    expect(has(tree, 'storefront-directory-card-a')).toBe(false);
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  // A search that found nothing is its own empty state, and never a dead end.
  it('offers a way out of a search that matched nothing', async () => {
    mockList.mockResolvedValue([
      summary({ slug: 'a' }), summary({ slug: 'b' }), summary({ slug: 'c' }),
      summary({ slug: 'd' }), summary({ slug: 'e' }), summary({ slug: 'f' }),
    ]);
    const tree = await renderScreen();
    const field = tree.root.find((n) => n.props?.testID === 'storefront-directory-search');
    act(() => { field.props.onChangeText('nothing matches this'); });

    expect(textOf(tree, 'storefront-directory-empty')).toContain('Nothing matches');
    press(tree, 'storefront-directory-empty-action');
    // 'b', not 'a': with six shops on screen, 'a' is `shown[0]` -- the shop
    // the grid no longer repeats now that it leads as the featured card (see
    // "does not repeat the featured shop..." below). 'b' is an ordinary grid
    // card either way, so it is what proves the grid came back.
    expect(has(tree, 'storefront-directory-card-b')).toBe(true);
  });

  // Computed on the DEVICE: the stored times are local wall-clock strings with
  // no timezone, so only the reader's clock can answer it.
  it('badges a shop whose hours say it is open right now', async () => {
    const allDay = { open: '00:00', close: '23:59' };
    mockList.mockResolvedValue([summary({
      openingHours: { mon: [allDay], tue: [allDay], wed: [allDay], thu: [allDay], fri: [allDay], sat: [allDay], sun: [allDay] },
    })]);
    const tree = await renderScreen();
    expect(textOf(tree, 'storefront-directory-state-dir-alpha')).toBe('Open');
  });

  it('badges a shop that is shut right now as closed', async () => {
    mockList.mockResolvedValue([summary({
      openingHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    })]);
    const tree = await renderScreen();
    expect(textOf(tree, 'storefront-directory-state-dir-alpha')).toBe('Closed');
  });

  // Absent is honest; "Closed" would not be.
  it('shows no badge at all for a shop that never set hours', async () => {
    mockList.mockResolvedValue([summary({ openingHours: {} })]);
    const tree = await renderScreen();
    expect(has(tree, 'storefront-directory-state-dir-alpha')).toBe(false);
  });

  it('closes the page with how-it-works, but not over an empty one', async () => {
    mockList.mockResolvedValue([summary()]);
    expect(has(await renderScreen(), 'storefront-directory-footer')).toBe(true);

    mockList.mockResolvedValue([]);
    expect(has(await renderScreen(), 'storefront-directory-footer')).toBe(false);
  });

  it('says so plainly when no shop has opened yet', async () => {
    mockList.mockResolvedValue([]);
    const tree = await renderScreen();
    expect(textOf(tree, 'storefront-directory-empty')).toContain('No shops are open yet.');
  });

  // REVIEW FINDING (whole-branch pass): `featuredShop` always takes
  // `shown[0]`, and the grid used to be built from `shown` unchanged -- so
  // the lead shop rendered twice, once as the hero and again as the grid's
  // own first card, same photo and name both times. Three shops is
  // `FEATURE_MINIMUM`, the smallest directory that can show a lead at all.
  it('does not repeat the featured shop as the grid\'s own first card', async () => {
    mockList.mockResolvedValue([
      summary({ slug: 'lead', shopName: 'Lead Shop', productCount: 20 }),
      summary({ slug: 'b', shopName: 'Beta Grocers', productCount: 10 }),
      summary({ slug: 'c', shopName: 'Charlie Store', productCount: 5 }),
    ]);
    const tree = await renderScreen();
    expect(has(tree, 'storefront-directory-featured-lead')).toBe(true);
    // The lead is named once, as the hero -- not a second time as a plain card.
    expect(has(tree, 'storefront-directory-card-lead')).toBe(false);
    // The rest of the grid is untouched.
    expect(has(tree, 'storefront-directory-card-b')).toBe(true);
    expect(has(tree, 'storefront-directory-card-c')).toBe(true);
  });

  // The row header sits directly above the grid -- once the lead is shown
  // separately above it, the header's own count has to agree with the cards
  // actually inside the grid, not with the total that includes the hero too.
  it('counts only the grid\'s own cards in the row header once the lead is shown separately', async () => {
    mockList.mockResolvedValue([
      summary({ slug: 'lead', productCount: 20 }),
      summary({ slug: 'b', productCount: 10 }),
      summary({ slug: 'c', productCount: 5 }),
    ]);
    const tree = await renderScreen();
    // The count sits in its own JSX expression (`{gridShops.length} {noun}`),
    // so it lands in the Text node's children as a separate NUMBER, not
    // folded into one string -- `textOf` only collects strings, so the
    // number is read directly off the node's children instead (the same
    // pattern the featured card's "Browse {n} items" chip test above uses).
    const rowHeadTitle = tree.root.findAllByType(Text).find((t: { props: { children?: unknown } }) => {
      const kids = [t.props.children].flat(Infinity);
      return kids.includes('shops') || kids.includes('shop');
    })!;
    const kids = [rowHeadTitle.props.children].flat(Infinity);
    expect(kids).toContain(2);
    expect(kids).toContain('shops');
  });
});

// THE MASTHEAD -- one lockup, one line of promise, one search field -- that
// replaced a nav row followed by a whole second hero (an eyebrow pill, a
// serif headline, a two-sentence lede). See the design record in
// src/app/store/index.tsx, at the top of `header`, for the repetition
// argument ("kaiibi" said twice within 120px) this rebuild is answering.
describe('the masthead', () => {
  it('drops the old eyebrow-headline-lede hero, and leads with the wordmark instead', async () => {
    mockList.mockResolvedValue([summary()]);
    const tree = await renderScreen();
    expect(has(tree, 'storefront-directory-masthead')).toBe(true);
    // The copy this masthead retired, pinned as an ABSENCE: if a future edit
    // resurrects the eyebrow or the headline, this is the test that notices.
    expect(textOf(tree, 'storefront-directory')).not.toContain('Buy from a real shop down the road');
    expect(textOf(tree, 'storefront-directory')).not.toContain('Shops on Kaiibi');
    // The wordmark IS the headline now -- it still lives inside the lockup
    // that links home.
    expect(textOf(tree, 'storefront-directory-home')).toContain('Kaiibi');
  });

  it('carries the mockup\'s one line of promise, verbatim', async () => {
    mockList.mockResolvedValue([summary()]);
    const tree = await renderScreen();
    expect(textOf(tree, 'storefront-directory-promise')).toBe(
      'Every shop, one place. Order ahead, collect in town.',
    );
  });

  // ADJACENCY, NOT ORDER. `lockupIndex < promiseIndex < searchIndex` would
  // stay green with unrelated content wedged between any of the three -- the
  // exact defect this branch has shipped twice already (see the brief). This
  // asks the stronger question: is the promise the LOCKUP ROW'S very next
  // sibling inside the masthead, and is the search the PROMISE'S.
  it('places the promise directly under the lockup row, and the search directly under the promise', async () => {
    mockList.mockResolvedValue([summary()]);
    const tree = await renderScreen();
    const root = tree.toJSON() as HostNode;
    const masthead = findByTestIdNode(root, 'storefront-directory-masthead');
    expect(masthead).not.toBeNull();

    const afterLockup = nextDirectChildAfter(masthead as HostNode, 'storefront-directory-home');
    expect(afterLockup).not.toBeNull();
    expect(typeof afterLockup === 'string' ? false
      : subtreeHasTestId(afterLockup as HostNode, 'storefront-directory-promise')).toBe(true);

    const afterPromise = nextDirectChildAfter(masthead as HostNode, 'storefront-directory-promise');
    expect(afterPromise).not.toBeNull();
    expect(typeof afterPromise === 'string' ? false
      : subtreeHasTestId(afterPromise as HostNode, 'storefront-directory-search')).toBe(true);
  });

  it('names what shops sell in the search placeholder and its accessibility label, not just "shops"', async () => {
    mockList.mockResolvedValue([summary(), summary({ slug: 'b' })]);
    const tree = await renderScreen();
    const field = tree.root.find((n) => n.props?.testID === 'storefront-directory-search');
    expect(field.props.placeholder).toBe('Find a shop — or a thing they sell…');
    expect(field.props.accessibilityLabel).toBe('Search 2 shops, or what they sell');
  });

  // EFFECT, not call: the plate must actually RENDER in kaiibi's own blue --
  // read off the flattened style of the host node the mark's Image sits
  // inside, compared against the named constant, never a hex literal retyped
  // here (see KAIIBI_BLUE, storefront-catalog.ts).
  it('fills the mark plate in kaiibi\'s own blue, not the directory\'s neutral ink', async () => {
    mockList.mockResolvedValue([summary()]);
    const tree = await renderScreen();
    const mark = tree.root.findByType(Image).parent;
    expect(mark).not.toBeNull();
    const flattened = StyleSheet.flatten(mark!.props.style) as { backgroundColor?: string };
    expect(flattened.backgroundColor).toBe(KAIIBI_BLUE);
    expect(flattened.backgroundColor).not.toBe(colors.ink);
  });
});

// THE SELECTED CHIP -- the mockup's `.dc.on{background:#0071e3}`, reserved
// for a chip that narrows the list. "All cities"/"Everything" are the
// DEFAULT, active before anything is tapped -- blue there would mean kaiibi's
// own colour reads as "no filter applied", so an active one of THOSE wears
// the same neutral `colors.ink` every selected chip wore before this branch,
// same as the unselected ones and the nav CTA.
describe('the selected filter chip', () => {
  function chipStyle(tree: ReturnType<typeof create>, label: string) {
    const node = tree.root.findAllByType(Text)
      .find((t: { props: { children?: unknown } }) => t.props.children === label)!;
    return {
      fill: (StyleSheet.flatten(node.parent!.props.style) as { backgroundColor?: string }).backgroundColor,
      text: (StyleSheet.flatten(node.props.style) as { color?: string }).color,
    };
  }

  it('leaves "All cities" in the neutral ink even while it is selected -- nothing has been tapped yet', async () => {
    mockList.mockResolvedValue([
      summary({ slug: 'a', city: 'Hargeisa' }),
      summary({ slug: 'b', city: 'Borama' }),
    ]);
    const tree = await renderScreen();

    const allCities = chipStyle(tree, 'All cities');
    expect(allCities.fill).toBe(colors.ink);
    expect(allCities.fill).not.toBe(KAIIBI_BLUE);
    expect(allCities.text).toBe(colors.ground);

    const borama = chipStyle(tree, 'Borama');
    expect(borama.fill).not.toBe(KAIIBI_BLUE);
    expect(borama.fill).toBe(colors.ground);
  });

  it('turns a NAMED city blue once it is the stated choice, and drops "All cities" back to unselected', async () => {
    mockList.mockResolvedValue([
      summary({ slug: 'a', city: 'Hargeisa' }),
      summary({ slug: 'b', city: 'Borama' }),
    ]);
    const tree = await renderScreen();

    press(tree, 'storefront-directory-city-Borama');

    const borama = chipStyle(tree, 'Borama');
    expect(borama.fill).toBe(KAIIBI_BLUE);
    expect(borama.text).toBe(KAIIBI_INK);

    // "All cities" is no longer the stated choice -- it goes back to the
    // ordinary unselected treatment, not to ink-as-selected.
    const allCitiesAfter = chipStyle(tree, 'All cities');
    expect(allCitiesAfter.fill).not.toBe(KAIIBI_BLUE);
    expect(allCitiesAfter.fill).toBe(colors.ground);
  });
});
