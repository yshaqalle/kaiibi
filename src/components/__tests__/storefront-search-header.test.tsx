import { isValidElement } from 'react';
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
  flyers: [],
  autoAdvance: false,
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

// THE SEARCH FIELD LIVES INSIDE ListHeaderComponent, AND THAT IS ONE LINE AWAY
// FROM LOSING FOCUS ON EVERY KEYSTROKE.
//
// The bento pass moved the whole header -- shop card, flyers, category band,
// search -- into the list's header so it scrolls away on a phone instead of
// pinning half the screen. VirtualizedList.js:941 then does exactly this:
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
// Nothing else catches this. Jest does not model focus, the shop these were
// verified against has three products so the field never rendered at all, and
// on web the keyboard is not modal so it is survivable there and invisible.
// The invariant is what is testable, so the invariant is what is pinned.
describe('the search field survives typing', () => {
  it.each([
    ['Market', ThemeMarket],
    ['Window', ThemeWindow],
  ] as const)('%s hands the list an element, never a component', async (name, Theme) => {
    const tree = await render(Theme, catalogue(SEARCH_THRESHOLD), `xamdi-search-el-${name}`);
    const header = tree.root.findByType(FlatList).props.ListHeaderComponent;

    expect(isValidElement(header)).toBe(true);
    // The half that actually bites: a component reads as valid to nothing else
    // here, and `typeof header === 'function'` is the shape that remounts.
    expect(typeof header).not.toBe('function');

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
    const data = tree.root.findByType(FlatList).props.data as (StorefrontProduct | null)[];
    expect(data.filter((p) => p !== null).map((p) => p.name)).toEqual(['Solar panel']);

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });
});
