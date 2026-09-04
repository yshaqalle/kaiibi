import { act, create } from 'react-test-renderer';
import { FlatList, Text } from 'react-native';

import { ThemeMarket } from '@/components/storefront/theme-market';
import {
  StockCard, WIDE_SHOP_WIDTH, gridColumnsForWidth, isWideShop, padFinalRow,
} from '@/components/storefront/theme-shared';
import { SHOP_MAX_WIDTH } from '@/components/storefront/scale';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const colors = paletteColors('clay');

const shop: PublicStorefront = {
  shopName: 'Xamdi Electronics',
  city: 'Hargeisa',
  slug: 'xamdi-grid',
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
};

function product(id: string): StorefrontProduct {
  return { id, name: `Product ${id}`, description: null, category: null, priceCents: 1200, stock: 5, imageUrl: null };
}

// THE DEFECT THIS FILE EXISTS FOR.
//
// At a 1,504px window gridColumnsForWidth returns 4, but FlatList lays a short
// final row out with only the cells it has and the cell style is `flex: 1`. A
// shop with three products got ONE row of three cells at a THIRD of the width
// each -- ~480px, and with `aspectRatio: 1` on the image that is a 480px-tall
// tile whose name and price fall below the fold. It read as a layout accident
// rather than as a shop with three things in it, and it is what prompted the
// whole bento pass.
describe('padFinalRow', () => {
  it('pads a short final row up to the column count', () => {
    expect(padFinalRow([product('a'), product('b'), product('c')], 4)).toEqual([
      product('a'), product('b'), product('c'), null,
    ]);
  });

  it('leaves a row that already divides evenly alone', () => {
    const four = [product('a'), product('b'), product('c'), product('d')];
    expect(padFinalRow(four, 4)).toEqual(four);
    expect(padFinalRow(four, 2)).toEqual(four);
  });

  it('pads only the final row of a multi-row grid', () => {
    const five = [product('a'), product('b'), product('c'), product('d'), product('e')];
    const padded = padFinalRow(five, 3);
    expect(padded).toHaveLength(6);
    expect(padded.slice(0, 5)).toEqual(five);
    expect(padded[5]).toBeNull();
  });

  // A single column has no row to be short in, and padding it would render an
  // empty tile at the bottom of every list.
  it('adds nothing at one column', () => {
    const three = [product('a'), product('b'), product('c')];
    expect(padFinalRow(three, 1)).toEqual(three);
  });

  // An empty catalogue reaches ListEmptyComponent, not the grid -- padding it
  // would put four blank cells where the empty state belongs.
  it('adds nothing to an empty catalogue', () => {
    expect(padFinalRow([], 4)).toEqual([]);
  });
});

describe('the grid actually receives the padding', () => {
  it('hands FlatList a full final row so three products do not inflate to a third each', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <ThemeMarket
          storefront={shop}
          products={[product('a'), product('b'), product('c')]}
          colors={colors}
        />,
      );
    });
    const list = tree.root.findByType(FlatList);
    const numColumns = list.props.numColumns as number;
    const data = list.props.data as unknown[];
    expect(data.length % numColumns).toBe(0);
    expect(data.filter((d) => d === null).length).toBe(numColumns - 3);

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });
});

// The other half of the same defect: nothing in this folder bounded its own
// width, so every value in scale.ts -- tuned at 390px and correct there -- was
// multiplied by four on a laptop.
describe('the shop is a bounded column', () => {
  it('caps the scroller rather than letting it grow with the window', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ThemeMarket storefront={shop} products={[product('a')]} colors={colors} />);
    });
    const flat = [tree.root.findByType(FlatList).props.style]
      .flat(Infinity)
      .reduce((a, s) => ({ ...(a as object), ...(s as object) }), {}) as { maxWidth?: number; alignSelf?: string };
    expect(flat.maxWidth).toBe(SHOP_MAX_WIDTH);
    expect(flat.alignSelf).toBe('center');

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });
});

describe('breakpoints', () => {
  it('gains columns with width', () => {
    expect(gridColumnsForWidth(390)).toBe(2);
    expect(gridColumnsForWidth(768)).toBe(3);
    expect(gridColumnsForWidth(1504)).toBe(4);
  });

  // Deliberately not the same threshold as a column gain: the point three shop
  // cards stop fitting in a row is not the point a product grid earns a column.
  it('puts the shop cards in a row only above their own threshold', () => {
    expect(isWideShop(WIDE_SHOP_WIDTH - 1)).toBe(false);
    expect(isWideShop(WIDE_SHOP_WIDTH)).toBe(true);
    expect(WIDE_SHOP_WIDTH).not.toBe(1024);
  });
});

// The stock card counts what is listed. `inStock === total` is TRUE at zero, so
// the cheerful branch fired on a shop that has listed nothing -- printing "all
// in stock today" directly above the EmptyState that says "Nothing listed yet."
describe('the stock card on an empty shop', () => {
  function textsOf(products: StorefrontProduct[]): string[] {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<StockCard products={products} colors={colors} />);
    });
    // The count is a NUMBER child (`{total}`), not a string, so a
    // string-only collector silently misses the one value this card exists
    // to show -- and at zero the value IS `0`, which is also falsy. Both
    // traps in one line.
    return tree.root.findAllByType(Text).flatMap((n) => {
      const c = n.props.children;
      if (typeof c === 'string') return [c];
      if (typeof c === 'number') return [String(c)];
      return [];
    });
  }

  it('claims no stock news when nothing is listed', () => {
    const texts = textsOf([]);
    expect(texts).toContain('0');
    expect(texts).not.toContain('all in stock today');
    expect(texts.some((t) => t.includes('in stock'))).toBe(false);
  });

  it('still says everything is in when everything is in', () => {
    expect(textsOf([product('a'), product('b')])).toContain('all in stock today');
  });

  it('names the shortfall when something is out', () => {
    const out = { ...product('c'), stock: 0 };
    expect(textsOf([product('a'), out])).toContain('1 of 2 in stock');
  });
});
