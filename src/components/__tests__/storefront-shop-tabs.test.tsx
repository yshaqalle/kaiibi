import { act, create } from 'react-test-renderer';

import { AboutPanel, shopQuestions } from '@/components/storefront/about-panel';
import { ShopTabRail, availableTabs } from '@/components/storefront/shop-tabs';
import { VisitPanel } from '@/components/storefront/visit-panel';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicDeliveryArea, PublicStorefront, StorefrontCategory, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const colors = paletteColors('ink');

function shop(overrides: Partial<PublicStorefront> = {}): PublicStorefront {
  return {
    shopName: 'Jiija Electronics', city: 'Hargeisa', slug: 'jiija', whatsappE164: '+252630000000',
    theme: 'market', palette: 'ink', headline: 'Everything that plugs in.', about: null,
    heroImageUrl: null, offersDelivery: false, collectAddress: null,
    collectNeighborhood: 'Jigjiga Yar', paymentMode: 'on_collection', flyers: [], autoAdvance: false,
    ...overrides,
  };
}

const AREAS: PublicDeliveryArea[] = [
  { name: 'Koodbuur', feeCents: 150 },
  { name: 'Jigjiga Yar', feeCents: 0 },
  { name: 'Ahmed Dhagah', feeCents: 100 },
];

const products: StorefrontProduct[] = [
  { id: '1', name: 'Solar lantern', description: null, category: 'Solar', priceCents: 1400, stock: 5, imageUrl: null },
  { id: '2', name: 'Power bank', description: null, category: 'Solar', priceCents: 1900, stock: 2, imageUrl: null },
  { id: '3', name: 'USB-C cable', description: null, category: 'Cables', priceCents: 300, stock: 9, imageUrl: null },
];

const categories: StorefrontCategory[] = [{ name: 'Solar', imageUrl: null, productCount: 2 }];

function render(el: React.ReactElement) {
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(el); });
  return tree;
}

// Every string rendered under one testID, in order. `toJSON` exists only on the
// root, so this walks the subtree instead -- the same technique
// storefront-category-band.test.tsx uses to read the grid.
function textOf(tree: ReturnType<typeof create>, testID: string): string {
  const node = tree.root.find((n) => n.props?.testID === testID);
  return [node, ...node.findAll(() => true)]
    .flatMap((n) => [n.props?.children].flat(Infinity))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function has(tree: ReturnType<typeof create>, testID: string): boolean {
  return tree.root.findAll((n) => n.props?.testID === testID).length > 0;
}

// A TAB HAS TO EARN ITS PLACE by saying something the Shop tab does not. These
// are the rules that stop the rail becoming chrome a shop cannot fill -- the
// same discipline every other optional block on this page follows.
describe('which tabs a shop gets', () => {
  it('gives a shop that has filled in nothing extra no second tab', () => {
    expect(availableTabs(shop(), [])).toEqual(['shop']);
  });

  it('adds About only once there is a story to tell', () => {
    expect(availableTabs(shop({ about: 'Ten years on the same corner.' }), [])).toEqual(['shop', 'about']);
  });

  it('treats a whitespace-only about as no about', () => {
    expect(availableTabs(shop({ about: '   \n ' }), [])).toEqual(['shop']);
  });

  // Without areas the Visit tab's whole content is the Collecting card, which
  // is already on the Shop tab, and a tab that repeats the page you came from
  // is worse than no tab.
  it('adds Visit only once there are priced areas the Shop tab cannot list', () => {
    expect(availableTabs(shop(), AREAS)).toEqual(['shop', 'visit']);
  });

  it('renders no rail for a single tab, so there is no control that never does anything', () => {
    const tree = render(<ShopTabRail colors={colors} tabs={['shop']} active="shop" onSelect={jest.fn()} />);
    expect(tree.toJSON()).toBeNull();
  });

  it('reports the selected tab to assistive tech rather than by colour alone', () => {
    const tree = render(
      <ShopTabRail colors={colors} tabs={['shop', 'about']} active="about" onSelect={jest.fn()} />,
    );
    const tab = (id: string) => tree.root.find(
      (n) => n.props?.testID === id && n.props?.accessibilityState !== undefined,
    );
    expect(tab('storefront-tab-about').props.accessibilityState.selected).toBe(true);
    expect(tab('storefront-tab-shop').props.accessibilityState.selected).toBe(false);
  });

  it('hands the tab back when one is pressed', () => {
    const onSelect = jest.fn();
    const tree = render(
      <ShopTabRail colors={colors} tabs={['shop', 'about']} active="shop" onSelect={onSelect} />,
    );
    const about = tree.root.find(
      (n) => n.props?.testID === 'storefront-tab-about' && typeof n.props?.onPress === 'function',
    );
    act(() => { about.props.onPress(); });
    expect(onSelect).toHaveBeenCalledWith('about');
  });
});

// Every answer is composed from settings the shop has already filled in, so a
// changed delivery fee cannot leave a stale copy behind. What these guard is an
// answer that is not TRUE of the shop it was generated for.
describe('the generated FAQ', () => {
  it('never promises delivery from a shop that does not offer it', () => {
    const delivery = shopQuestions(shop({ offersDelivery: false }), []).find((q) => q.id === 'delivery');
    expect(delivery?.a).toContain('Not at the moment');
  });

  it('names how many areas there are and the cheapest fee', () => {
    const delivery = shopQuestions(shop({ offersDelivery: true }), AREAS).find((q) => q.id === 'delivery');
    expect(delivery?.a).toContain('3 areas');
    expect(delivery?.a).toContain('free');
  });

  it('says "from" the cheapest fee when no area is free', () => {
    const areas = [{ name: 'Koodbuur', feeCents: 150 }];
    expect(shopQuestions(shop({ offersDelivery: true }), areas).find((q) => q.id === 'delivery')?.a)
      .toContain('from $1.50');
  });

  // The rule WhatsAppButton and ProductActions already follow: lose the answer
  // rather than print one that sends the customer nowhere.
  it('offers no "message us" answer to a shop with no number to message', () => {
    expect(shopQuestions(shop({ whatsappE164: null }), []).map((q) => q.id)).not.toContain('stock');
  });

  it('mentions paying on delivery only where there is a delivery to pay on', () => {
    expect(shopQuestions(shop({ offersDelivery: false }), []).find((q) => q.id === 'pay')?.a)
      .not.toContain('delivery');
    expect(shopQuestions(shop({ offersDelivery: true }), AREAS).find((q) => q.id === 'pay')?.a)
      .toContain('delivery');
  });

  it('names the counter to collect from when the shop has one', () => {
    expect(shopQuestions(shop(), []).find((q) => q.id === 'collect')?.a)
      .toContain('Jigjiga Yar, Hargeisa');
  });
});

describe('the About panel', () => {
  function renderAbout(overrides: Partial<PublicStorefront> = {}, cats = categories, areas = AREAS) {
    return render(
      <AboutPanel
        storefront={shop({ about: 'Ten years on the same corner.', ...overrides })}
        products={products}
        categories={cats}
        areas={areas}
        colors={colors}
        wide={false}
      />,
    );
  }

  it('prints the shop story', () => {
    expect(textOf(renderAbout(), 'storefront-about-story')).toContain('Ten years on the same corner.');
  });

  it('drops the headline rather than printing an empty line for it', () => {
    expect(has(renderAbout({ headline: null }), 'storefront-about-headline')).toBe(false);
  });

  it('counts what it shows rather than storing it', () => {
    const stats = textOf(renderAbout(), 'storefront-about-stats');
    expect(stats).toContain('items listed');
    expect(stats).toContain('3');
    expect(stats).toContain('category');
    expect(stats).toContain('delivery areas');
  });

  // A shop with no categories should not be told it has zero of them.
  it('leaves out a figure it would have to report as zero', () => {
    const stats = textOf(renderAbout({}, [], []), 'storefront-about-stats');
    expect(stats).not.toContain('categor');
    expect(stats).not.toContain('delivery area');
    expect(stats).toContain('items listed');
  });

  it('opens the first question and closes it again when pressed', () => {
    const tree = renderAbout();
    expect(has(tree, 'storefront-faq-answer-pay')).toBe(true);
    const head = tree.root.find(
      (n) => n.props?.testID === 'storefront-faq-pay' && typeof n.props?.onPress === 'function',
    );
    act(() => { head.props.onPress(); });
    expect(has(tree, 'storefront-faq-answer-pay')).toBe(false);
  });

  it('keeps only one question open at a time', () => {
    const tree = renderAbout();
    const head = tree.root.find(
      (n) => n.props?.testID === 'storefront-faq-delivery' && typeof n.props?.onPress === 'function',
    );
    act(() => { head.props.onPress(); });
    expect(has(tree, 'storefront-faq-answer-delivery')).toBe(true);
    expect(has(tree, 'storefront-faq-answer-pay')).toBe(false);
  });
});

// The tab exists because the Shop tab's "Delivery · From $1.00" cannot answer
// "is MY area on the list, and what does it cost me".
describe('the Visit panel', () => {
  function renderVisit(overrides: Partial<PublicStorefront> = {}, areas = AREAS) {
    return render(
      <VisitPanel storefront={shop({ offersDelivery: true, ...overrides })} areas={areas} colors={colors} />,
    );
  }

  it('lists every area, not just the cheapest', () => {
    const tree = renderVisit();
    for (const area of AREAS) expect(has(tree, `storefront-visit-area-${area.name}`)).toBe(true);
  });

  it('says Free rather than $0.00, because that is the fact about the offer', () => {
    expect(textOf(renderVisit(), 'storefront-visit-area-Jigjiga Yar')).toContain('Free');
  });

  it('orders the list cheapest first', () => {
    const listed = textOf(renderVisit(), 'storefront-visit-areas');
    expect(listed.indexOf('Jigjiga Yar')).toBeLessThan(listed.indexOf('Ahmed Dhagah'));
    expect(listed.indexOf('Ahmed Dhagah')).toBeLessThan(listed.indexOf('Koodbuur'));
  });

  it('names the counter to collect from', () => {
    expect(textOf(renderVisit(), 'storefront-visit-collect')).toContain('Jigjiga Yar, Hargeisa');
  });

  it('offers no contact card to a shop with no number', () => {
    expect(has(renderVisit({ whatsappE164: null }), 'storefront-visit-contact')).toBe(false);
  });
});
