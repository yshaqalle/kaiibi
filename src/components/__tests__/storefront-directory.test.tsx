import { act, create } from 'react-test-renderer';

import StoreDirectoryScreen from '@/app/store/index';
import { ShopDirectoryCard, directoryColumnsForWidth } from '@/components/storefront/shop-directory-card';
import { paletteColors } from '@/lib/storefront-catalog';
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

describe('the directory card', () => {
  function renderCard(shop: PublicShopSummary, onPress = jest.fn()) {
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<ShopDirectoryCard shop={shop} colors={colors} onPress={onPress} />); });
    return tree;
  }

  it('opens the shop it names', () => {
    const onPress = jest.fn();
    const tree = renderCard(summary(), onPress);
    press(tree, 'storefront-directory-card-dir-alpha');
    expect(onPress).toHaveBeenCalledWith('dir-alpha');
  });

  it('says what is in the shop, not what the catalogue holds', () => {
    expect(textOf(renderCard(summary({ productCount: 4 })), 'storefront-directory-card-dir-alpha'))
      .toContain('4 items');
  });

  // "0 items" reads as a broken card. A shop with nothing in stock has to say
  // so in words.
  it('says nothing in today rather than zero items', () => {
    const text = textOf(renderCard(summary({ productCount: 0 })), 'storefront-directory-card-dir-alpha');
    expect(text).toContain('Nothing in today');
    expect(text).not.toContain('0 items');
  });

  it('marks a shop that delivers, and leaves the chip off one that does not', () => {
    expect(textOf(renderCard(summary({ offersDelivery: true })), 'storefront-directory-card-dir-alpha'))
      .toContain('Delivers');
    expect(textOf(renderCard(summary({ offersDelivery: false })), 'storefront-directory-card-dir-alpha'))
      .not.toContain('Delivers');
  });

  // The majority case: a shop that has uploaded no hero image must still read
  // as designed rather than as a missing picture.
  it('falls back to a monogram rather than an empty box', () => {
    expect(textOf(renderCard(summary({ heroImageUrl: null })), 'storefront-directory-card-dir-alpha'))
      .toContain('A');
  });

  it('names the shop and its city to a screen reader in one label', () => {
    const tree = renderCard(summary());
    const node = tree.root.find(
      (n) => n.props?.testID === 'storefront-directory-card-dir-alpha' && n.props?.accessibilityLabel,
    );
    expect(node.props.accessibilityLabel).toBe('Alpha Hardware, Hargeisa, 4 items');
  });
});

describe('how many columns the directory takes', () => {
  // One fewer than the product grid at every step -- a directory card is wider.
  it('goes one, two, three as the window grows', () => {
    expect(directoryColumnsForWidth(390)).toBe(1);
    expect(directoryColumnsForWidth(800)).toBe(2);
    expect(directoryColumnsForWidth(1280)).toBe(3);
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

  // Six is DIRECTORY_SEARCH_MINIMUM: below that a directory is read, not
  // searched, and a control that filters three cards costs more than it saves.
  it('offers no search box for a directory short enough to read', async () => {
    mockList.mockResolvedValue([summary(), summary({ slug: 'b' })]);
    const tree = await renderScreen();
    expect(has(tree, 'storefront-directory-search')).toBe(false);
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
    expect(has(tree, 'storefront-directory-card-a')).toBe(true);
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
});
