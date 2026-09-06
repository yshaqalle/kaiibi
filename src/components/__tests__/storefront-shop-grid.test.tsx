import { act, create } from 'react-test-renderer';
import { FlatList, Text } from 'react-native';

import { ThemeMarket } from '@/components/storefront/theme-market';
import {
  StockCard, WIDE_SHOP_WIDTH, gridColumnsForWidth, isWideShop, padFinalRow,
} from '@/components/storefront/theme-shared';
import { PROSE_MAX_WIDTH } from '@/components/storefront/scale';
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
  hideBranding: false,
};

function product(id: string): StorefrontProduct {
  return { id, name: `Product ${id}`, description: null, category: null, priceCents: 1200, stock: 5, imageUrl: null };
}

// Style props on these components are arrays -- flatten before reading a key
// off them, the same shape storefront-goods-scroll.test.tsx's own `flatten`
// helper follows.
function flatStyle(style: unknown): { maxWidth?: number; alignSelf?: string; width?: string | number } {
  return [style]
    .flat(Infinity)
    .reduce((a, s) => ({ ...(a as object), ...((s ?? {}) as object) }), {}) as {
    maxWidth?: number; alignSelf?: string; width?: string | number;
  };
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
    // The goods FlatList is the ONLY FlatList in this tree -- the page
    // around it is a plain ScrollView (see theme-market.tsx's own comment on
    // why), not a second, outer FlatList the goods scroll independently
    // inside of. `findAllByType(FlatList)` would still resolve it in one
    // match, but the composite FlatList forwards its own testID down to an
    // inner host node with no `data` of its own -- picking the match that
    // actually carries `data` is what the testID search below is for, the
    // same way storefront-flyer-placement.test.tsx's own `gridNames` helper
    // already does.
    const list = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-goods' && Array.isArray(n.props?.data),
    )[0];
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
//
// TASK C MOVED THIS BOUND, TWICE. First pass: the page scroller stopped
// carrying SHOP_MAX_WIDTH and the goods grid earned its own answer (fills
// the window, less the page's own padding -- the argument DIRECTORY_MAX_WIDTH
// already makes for the store directory's grid), while the header and the
// footer kept the bound for one release. That read as a page that had
// forgotten to finish resizing itself -- a header stopping at 1620px beside
// a grid running to 1900px -- so the second pass freed them too. See
// SHOP_MAX_WIDTH's own comment in scale.ts for the full account of both
// moves and who reads the constant now (nobody, on this tab). What did NOT
// move: the actual PROSE inside the header (the anchor's headline and its
// `about` paragraph) carries PROSE_MAX_WIDTH directly, so a sentence still
// stops at a comfortable measure even though the row it sits in no longer
// does.
describe('the shop page is full width; only its prose keeps a measure', () => {
  it('bounds nothing -- not the page scroller, not the header, not the footer, not the grid', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ThemeMarket storefront={shop} products={[product('a')]} colors={colors} />);
    });
    const page = tree.root.find((n) => n.props?.testID === 'storefront-page-scroll');
    const header = tree.root.find((n) => n.props?.testID === 'storefront-header-column');
    const footer = tree.root.find((n) => n.props?.testID === 'storefront-footer-column');
    for (const node of [page, header, footer]) {
      const flat = flatStyle(node.props.style);
      expect(flat.maxWidth).toBeUndefined();
    }

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });

  it('does not bound the goods grid at all -- it fills the window, less the page padding', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <ThemeMarket
          storefront={shop}
          products={[product('a'), product('b'), product('c'), product('d'), product('e')]}
          colors={colors}
        />,
      );
    });
    const list = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-goods' && Array.isArray(n.props?.data),
    )[0];
    const flat = flatStyle(list.props.style);
    expect(flat.maxWidth).toBeUndefined();
    expect(flat.width).toBe('100%');

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });

  it('still bounds the one sentence in the header -- the headline and the about paragraph', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <ThemeMarket
          storefront={{ ...shop, headline: 'Fresh produce, every single day of the week', about: 'A market stall that has been trading on this corner for years.' }}
          products={[product('a')]}
          colors={colors}
        />,
      );
    });
    const headline = tree.root.find((n) => n.props?.testID === 'storefront-headline');
    const about = tree.root.find((n) => n.props?.testID === 'storefront-about');
    expect(flatStyle(headline.props.style).maxWidth).toBe(PROSE_MAX_WIDTH);
    expect(flatStyle(about.props.style).maxWidth).toBe(PROSE_MAX_WIDTH);

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });
});

describe('breakpoints', () => {
  it('gains columns with width', () => {
    expect(gridColumnsForWidth(390)).toBe(2);
    expect(gridColumnsForWidth(768)).toBe(3);
    expect(gridColumnsForWidth(1023)).toBe(3);
    expect(gridColumnsForWidth(1024)).toBe(4);
    expect(gridColumnsForWidth(1279)).toBe(4);
    expect(gridColumnsForWidth(1280)).toBe(5);
    expect(gridColumnsForWidth(1504)).toBe(5);
  });

  // TASK C: the grid used to stop climbing here, because nothing above
  // SHOP_MAX_WIDTH (1320) ever reached this function -- the grid itself was
  // capped there. It fills the window now (see the describe block above),
  // so a real 2,560px monitor really does hand this function 2,560 -- and
  // without these rungs it would have drawn five ~500px posters. Every
  // threshold here is a multiple of 128, and every one lands a tile in the
  // same ~240-300px band gridColumnsForWidth's own header comment names --
  // see that comment for the arithmetic each boundary below is chosen from.
  it('keeps climbing above 1280 instead of capping the tile size on a wide monitor', () => {
    expect(gridColumnsForWidth(1535)).toBe(5);
    expect(gridColumnsForWidth(1536)).toBe(6);
    expect(gridColumnsForWidth(1791)).toBe(6);
    expect(gridColumnsForWidth(1792)).toBe(7);
    expect(gridColumnsForWidth(2047)).toBe(7);
    expect(gridColumnsForWidth(2048)).toBe(8);
    expect(gridColumnsForWidth(2303)).toBe(8);
    expect(gridColumnsForWidth(2304)).toBe(9);
    expect(gridColumnsForWidth(2559)).toBe(9);
    // The width named in the defect this ramp exists to fix -- see
    // gridColumnsForWidth's own comment.
    expect(gridColumnsForWidth(2560)).toBe(10);
    // Open-ended past the last rung, deliberately -- see that same comment.
    expect(gridColumnsForWidth(3200)).toBe(10);
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
