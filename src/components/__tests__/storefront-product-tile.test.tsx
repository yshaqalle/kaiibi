import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { isProductNew, ProductTile } from '@/components/storefront/product-tile';
import { openExternalUrl } from '@/lib/external-url';
import { waLink } from '@/lib/storefront';
import { paletteColors } from '@/lib/storefront-catalog';
import type { StorefrontProduct } from '@/types/models';

// product-tile.tsx now imports waLink from '@/lib/storefront' for Ask, which
// transitively imports '@/lib/supabase' -- that throws at import time without
// real env vars. Same mock storefront-theme-counter.test.tsx already carries
// for the same reason.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));

const openMock = openExternalUrl as jest.MockedFunction<typeof openExternalUrl>;
beforeEach(() => openMock.mockReset());

// `@testing-library/react-native` is not installed in this repo (see
// stat-tile.test.tsx and sale-line.test.tsx for the same pattern) -- flatten
// the rendered tree to strings instead of reaching for a query library the
// repo does not have.
function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

function countOf(texts: string[], target: string): number {
  return texts.filter((t) => t === target).length;
}

const colors = paletteColors('ink');

const base: StorefrontProduct = {
  id: 'p1',
  name: 'Anker 20W charger',
  description: null,
  category: 'Phone',
  priceCents: 1200,
  stock: 5,
  imageUrl: null,
};

function renderTile(product: StorefrontProduct, extra?: { whatsappE164?: string; shopName?: string }) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<ProductTile product={product} colors={colors} {...extra} />);
  });
  return textsIn(tree.toJSON() as ReactTestRendererJSON);
}

describe('ProductTile', () => {
  it('shows the name and price', () => {
    const texts = renderTile(base);
    expect(texts).toContain('Anker 20W charger');
    expect(texts).toContain('$12.00');
  });

  it('names the product in the fallback tile exactly once when there is no photo', () => {
    const texts = renderTile(base);
    // The fallback IS the label -- the body must not repeat the name, or the
    // tile reads as a rendering bug rather than a deliberate price-label look.
    expect(countOf(texts, 'Anker 20W charger')).toBe(1);
    expect(texts).toContain('$12.00');
    expect(texts).toContain('In stock');
  });

  it('names the product in the body exactly once when there is a photo', () => {
    const texts = renderTile({ ...base, imageUrl: 'https://example.test/a.jpg' });
    expect(countOf(texts, 'Anker 20W charger')).toBe(1);
    expect(texts).toContain('$12.00');
    expect(texts).toContain('In stock');
  });

  it('marks an out-of-stock product without hiding it', () => {
    const texts = renderTile({ ...base, stock: 0 });
    expect(texts).toContain('Out of stock');
  });

  it('says in stock when there is stock', () => {
    const texts = renderTile(base);
    expect(texts).toContain('In stock');
  });

  it('shows Add when in stock and calls onAdd with the product on press', () => {
    const onAdd = jest.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ProductTile product={base} colors={colors} onAdd={onAdd} />);
    });
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('Add');

    const addButtons = tree.root.findAll((node) => node.props?.testID === 'product-tile-add');
    act(() => addButtons[0].props.onPress());
    expect(onAdd).toHaveBeenCalledWith(base);
  });

  // The shop may be restocking, and that enquiry is a sale -- an out-of-stock
  // tile loses Add but must never lose Ask or disappear.
  it('loses Add but keeps Ask when out of stock', () => {
    // The shop may be restocking, and that enquiry is a sale.
    const texts = renderTile({ ...base, stock: 0 }, { whatsappE164: '+252634418820' });
    expect(texts).not.toContain('Add');
    expect(texts).toContain('Ask');
    expect(texts).toContain('Out of stock');
  });

  it('shows Ask alongside Add when in stock', () => {
    const texts = renderTile(base, { whatsappE164: '+252634418820' });
    expect(texts).toContain('Ask');
    expect(texts).toContain('Add');
  });

  it('Ask opens a wa.me link prefilled with the shop and product name', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <ProductTile product={base} colors={colors} shopName="Deka Electronics" whatsappE164="+252634418820" />
      );
    });
    const askButtons = tree.root.findAll((node) => node.props?.testID === 'product-tile-ask');
    act(() => askButtons[0].props.onPress());

    const expected = waLink('+252634418820', 'Hi Deka Electronics, is Anker 20W charger available?');
    expect(openMock).toHaveBeenCalledWith(expected);
  });

  // Commit 302630a changed Ask from "stays visible but inert without a
  // number" to hiding itself outright, deliberately -- asserted below.
  it('does not render Ask at all when the shop has no WhatsApp number', () => {
    // Matches WhatsAppButton in theme-shared: lose the button rather than
    // render one that opens a chat with nobody. An Ask that renders and
    // silently does nothing is the worse half of both options -- the customer
    // taps and the app shrugs. Publishing requires a number, so this is the
    // belt to that braces.
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ProductTile product={base} colors={colors} />);
    });
    const askButtons = tree.root.findAll((node) => node.props?.testID === 'product-tile-ask');
    expect(askButtons).toHaveLength(0);
    expect(openMock).not.toHaveBeenCalled();
  });

  // Task 16: the price moved onto the photo as a pill. Tasks 13 and 14 both
  // shipped defects every STRUCTURAL test passed, because those tests only
  // proved a node was present somewhere in the tree -- never that it was
  // actually where the design put it. These assert the real relationship:
  // the pill is a SIBLING of the Image inside the same box, found by walking
  // the rendered test-instance tree rather than by matching flattened text.
  function findImage(root: ReturnType<typeof create>['root']) {
    return root.findAll((node) => Boolean(node.props?.source?.uri))[0];
  }

  describe('the price pill', () => {
    it('sits on the photo -- a sibling of the Image inside the same box, not merely present in the tile', () => {
      let tree!: ReturnType<typeof create>;
      act(() => {
        tree = create(<ProductTile product={{ ...base, imageUrl: 'https://example.test/a.jpg' }} colors={colors} />);
      });
      const image = findImage(tree.root);
      const pill = tree.root.findAll((node) => node.props?.testID === 'product-tile-price-pill')[0];
      expect(image).toBeDefined();
      expect(pill).toBeDefined();
      expect(pill.parent).toBe(image.parent);
    });

    it('drops the body price line once there is a photo, so the number is never said twice', () => {
      const texts = renderTile({ ...base, imageUrl: 'https://example.test/a.jpg' });
      expect(countOf(texts, '$12.00')).toBe(1);
    });

    // "A product with no photo must still render correctly -- the price pill
    // has nothing to sit on." Decision pinned here: no pill is rendered at
    // all (never a pill floating over the empty plate), and the price stays
    // a plain line in the text block, same as before this task.
    it('renders no pill at all on a photoless product, and keeps the price in the text block instead', () => {
      let tree!: ReturnType<typeof create>;
      act(() => {
        tree = create(<ProductTile product={base} colors={colors} />);
      });
      const pills = tree.root.findAll((node) => node.props?.testID === 'product-tile-price-pill');
      expect(pills).toHaveLength(0);
      const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
      expect(texts).toContain('$12.00');
    });
  });

  describe('the NEW badge', () => {
    it('sits on the photo -- a sibling of the Image -- for a product created moments ago', () => {
      const fresh: StorefrontProduct = {
        ...base,
        imageUrl: 'https://example.test/a.jpg',
        createdAt: new Date().toISOString(),
      };
      let tree!: ReturnType<typeof create>;
      act(() => {
        tree = create(<ProductTile product={fresh} colors={colors} />);
      });
      const image = findImage(tree.root);
      const badge = tree.root.findAll((node) => node.props?.testID === 'product-tile-new-badge')[0];
      expect(badge).toBeDefined();
      expect(badge.parent).toBe(image.parent);
      expect(textsIn(tree.toJSON() as ReactTestRendererJSON)).toContain('NEW');
    });

    // The genuinely-absent case, not a stand-in for "old". `base` never sets
    // createdAt at all -- the shipped-ahead-of-database case a client newer
    // than its database hits -- and it must be tested as absence, not
    // reused from the old-date test below, or the two failure modes could
    // silently collapse into testing the same thing twice.
    it('does not render when createdAt is genuinely absent from the product', () => {
      expect('createdAt' in base).toBe(false);
      let tree!: ReturnType<typeof create>;
      act(() => {
        tree = create(<ProductTile product={{ ...base, imageUrl: 'https://example.test/a.jpg' }} colors={colors} />);
      });
      const badges = tree.root.findAll((node) => node.props?.testID === 'product-tile-new-badge');
      expect(badges).toHaveLength(0);
    });

    it('does not render when createdAt is explicitly null', () => {
      let tree!: ReturnType<typeof create>;
      act(() => {
        tree = create(
          <ProductTile product={{ ...base, imageUrl: 'https://example.test/a.jpg', createdAt: null }} colors={colors} />,
        );
      });
      const badges = tree.root.findAll((node) => node.props?.testID === 'product-tile-new-badge');
      expect(badges).toHaveLength(0);
    });

    it('does not render once a product is older than the window', () => {
      const old: StorefrontProduct = {
        ...base,
        imageUrl: 'https://example.test/a.jpg',
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      };
      let tree!: ReturnType<typeof create>;
      act(() => {
        tree = create(<ProductTile product={old} colors={colors} />);
      });
      const badges = tree.root.findAll((node) => node.props?.testID === 'product-tile-new-badge');
      expect(badges).toHaveLength(0);
    });

    // A photoless product has no photo for the badge to sit on either --
    // same reasoning as the price pill above.
    it('does not render on a photoless product even when created moments ago', () => {
      const fresh: StorefrontProduct = { ...base, createdAt: new Date().toISOString() };
      let tree!: ReturnType<typeof create>;
      act(() => {
        tree = create(<ProductTile product={fresh} colors={colors} />);
      });
      const badges = tree.root.findAll((node) => node.props?.testID === 'product-tile-new-badge');
      expect(badges).toHaveLength(0);
    });
  });
});

// Task 16: a PURE function of (createdAt, now) so "is this new" is a fact a
// test can pin at an exact instant, rather than a moving target that only
// ever passes today because it was written against the real clock.
describe('isProductNew', () => {
  const now = new Date('2026-09-05T12:00:00.000Z');
  const DAY_MS = 24 * 60 * 60 * 1000;
  const daysAgo = (n: number) => new Date(now.getTime() - n * DAY_MS).toISOString();

  it('is new at 13 days old', () => {
    expect(isProductNew(daysAgo(13), now)).toBe(true);
  });

  it('is new at exactly 14 days old -- the boundary is inclusive', () => {
    expect(isProductNew(daysAgo(14), now)).toBe(true);
  });

  it('is not new at 15 days old', () => {
    expect(isProductNew(daysAgo(15), now)).toBe(false);
  });

  it('is not new when createdAt is null', () => {
    expect(isProductNew(null, now)).toBe(false);
  });

  it('is not new when createdAt is undefined -- the shipped-ahead-of-database case', () => {
    expect(isProductNew(undefined, now)).toBe(false);
  });

  it('is not new for a malformed timestamp, rather than throwing or badging it', () => {
    expect(isProductNew('not-a-real-date', now)).toBe(false);
  });
});
