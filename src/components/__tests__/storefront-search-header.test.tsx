import { FlatList, TextInput } from 'react-native';
import { act, create } from 'react-test-renderer';

import { ThemeMarket } from '@/components/storefront/theme-market';
import { ThemeWindow } from '@/components/storefront/theme-window';
import { SEARCH_THRESHOLD } from '@/lib/storefront-search';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const colors = paletteColors('clay');

const shop: PublicStorefront = {
  shopName: 'Xamdi Electronics',
  city: 'Hargeisa',
  slug: 'xamdi-search',
  whatsappE164: '+252634456789',
  theme: 'market',
  palette: 'clay',
  headline: null,
  about: null,
  heroImageUrl: null,
  offersDelivery: false,
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

function catalogue(n: number): StorefrontProduct[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: i === 0 ? 'Solar panel' : `Product ${i}`,
    description: null,
    category: null,
    priceCents: 1000 + i,
    stock: 5,
    imageUrl: null,
  }));
}

async function render(Theme: typeof ThemeMarket, products: StorefrontProduct[], slug: string) {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<Theme storefront={{ ...shop, slug }} products={products} colors={colors} />);
  });
  return tree;
}

// THE SEARCH FIELD USED TO LIVE INSIDE ListHeaderComponent, AND THAT WAS ONE
// LINE AWAY FROM LOSING FOCUS ON EVERY KEYSTROKE.
//
// The bento pass moved the whole header -- shop card, flyers, category band,
// search -- into the list's header so it scrolls away on a phone instead of
// pinning half the screen. VirtualizedList.js:941 then did exactly this:
//
//     const element = isValidElement(ListHeaderComponent)
//       ? ListHeaderComponent
//       : <ListHeaderComponent />;
//
// Pass an ELEMENT and it is rendered as-is: its type is a View, stable across
// renders, so React reconciles and the TextInput inside keeps its identity and
// its focus. Pass a COMPONENT -- and the tempting way to write that is an
// inline `() => <Header/>` -- and the type is a brand-new function on every
// render, so React unmounts and remounts the entire header. Typing sets state,
// state re-renders, the field is destroyed and rebuilt, and the keyboard
// closes after one character.
//
// TASK B REMOVED THE MECHANISM THIS GUARDED, not just the defect. The header
// (and the search field inside it) is no longer handed to any list as
// ListHeaderComponent at all -- theme-market.tsx/theme-window.tsx now render
// it as a plain child of the page's own ScrollView, with the goods FlatList a
// SEPARATE sibling below it (see that file's own comment on why the goods
// needed their own real ScrollView rather than nesting inside another list).
// A plain ScrollView has no isValidElement-vs-function special case to get
// wrong -- there is no prop here a component reference could be passed to by
// mistake. What replaces the old assertion is the structural fact that makes
// it true: the header sits OUTSIDE the goods FlatList's own subtree, so
// nothing the grid does (a fresh `key={numColumns}` remount included) can
// ever reach up and remount it.
describe('the search field survives typing', () => {
  it.each([
    ['Market', ThemeMarket],
    ['Window', ThemeWindow],
  ] as const)('%s renders the header outside the goods FlatList, so the grid can never remount it', async (name, Theme) => {
    const tree = await render(Theme, catalogue(SEARCH_THRESHOLD), `xamdi-search-el-${name}`);

    // Only one FlatList left in this tree at all -- see theme-market.tsx's
    // own comment on why the goods are the only thing still built on one.
    expect(tree.root.findAllByType(FlatList)).toHaveLength(1);

    const goods = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-goods' && Array.isArray(n.props?.data),
    )[0];
    const insideGoods = goods.findAll(() => true);
    expect(insideGoods.some((n) => n.props?.testID === 'storefront-header')).toBe(false);
    expect(insideGoods.some((n) => n.props?.testID === 'storefront-search')).toBe(false);

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });

  it('offers no search below the threshold, so the header carries no input at all', async () => {
    const tree = await render(ThemeMarket, catalogue(SEARCH_THRESHOLD - 1), 'xamdi-search-under');
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });

  it('renders the field at the threshold', async () => {
    const tree = await render(ThemeMarket, catalogue(SEARCH_THRESHOLD), 'xamdi-search-at');
    const fields = tree.root.findAll((n) => n.props?.testID === 'storefront-search');
    expect(fields.length).toBeGreaterThan(0);

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });

  // The behavioural half: typing narrows the grid AND the field keeps what was
  // typed. A remounted header would come back with an empty value.
  it('keeps what was typed while narrowing the grid', async () => {
    const tree = await render(ThemeMarket, catalogue(SEARCH_THRESHOLD), 'xamdi-search-type');
    const field = () => tree.root.findAll((n) => n.props?.testID === 'storefront-search')[0];

    await act(async () => field().props.onChangeText('Solar'));

    expect(field().props.value).toBe('Solar');
    // Task B nests a second, bounded FlatList for the goods inside this one's
    // own ListHeaderComponent (see theme-market.tsx) -- `findByType` resolves
    // the OUTER page list (it does not search past its first match), which
    // carries no product data of its own any more, so the grid itself needs
    // picking out by testID, same as storefront-flyer-placement.test.tsx's
    // own `gridNames` helper already does.
    const goods = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-goods' && Array.isArray(n.props?.data),
    )[0];
    const data = goods.props.data as (StorefrontProduct | null)[];
    expect(data.filter((p) => p !== null).map((p) => p.name)).toEqual(['Solar panel']);

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });
});
