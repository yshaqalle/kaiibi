import { act, create } from 'react-test-renderer';

import { AboutPanel, shopQuestions } from '@/components/storefront/about-panel';
import { pillMotion, ShopTabRail, availableTabs } from '@/components/storefront/shop-tabs';
import { VisitPanel, mapsUrlFor } from '@/components/storefront/visit-panel';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicDeliveryArea, PublicStorefront, StorefrontCategory, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const colors = paletteColors('ink');

function shop(overrides: Partial<PublicStorefront> = {}): PublicStorefront {
  return {
    shopName: 'Jiija Electronics', city: 'Hargeisa', slug: 'jiija', whatsappE164: '+252630000000',
    theme: 'market', palette: 'ink', headline: 'Everything that plugs in.', about: null,
    heroImageUrl: null, offersDelivery: false, collectAddress: null,
    collectNeighborhood: 'Jigjiga Yar', paymentMode: 'on_collection', openingHours: {},
    tradingSince: null, highlights: [], images: [], contactPhone: null, instagram: null,
    flyers: [], autoAdvance: false, hideBranding: false,
    ...overrides,
  };
}

const AREAS: PublicDeliveryArea[] = [
  { name: 'Koodbuur', feeCents: 150 },
  { name: 'Jigjiga Yar', feeCents: 0 },
  { name: 'Ahmed Dhagah', feeCents: 100 },
];

// Wednesday carries a split shift, which is the case the column's list-per-day
// shape exists for and the one a single open/close pair would lose.
const HOURS = {
  mon: [{ open: '08:00', close: '21:00' }],
  tue: [],
  wed: [{ open: '08:00', close: '11:30' }, { open: '14:00', close: '21:00' }],
  thu: [{ open: '08:00', close: '21:00' }],
  fri: [{ open: '08:00', close: '21:00' }],
  sat: [{ open: '08:00', close: '21:00' }],
  sun: [{ open: '08:00', close: '21:00' }],
};

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
    // Host elements only: findAll returns BOTH the composite Text and the host
    // it renders to, and both carry the same `children`, so counting every
    // instance repeats every string on the page.
    .filter((n) => typeof n.type === 'string')
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
  it('adds Visit for priced areas the Shop tab cannot list', () => {
    expect(availableTabs(shop(), AREAS)).toEqual(['shop', 'visit']);
  });

  // Hours are the other half: a collection-only shop has no areas at all, and
  // "when are you open" is the question it most needs to answer.
  it('adds Visit for opening hours even with no delivery at all', () => {
    expect(availableTabs(shop({ openingHours: HOURS }), [])).toEqual(['shop', 'visit']);
  });

  // A shop that saved a week of closed days has STATED something, and stating
  // it is an answer -- `isConfigured` is presence of the saved keys, not of an
  // open range, and this pins that reading so a future change to store-hours.ts
  // cannot quietly move the tab.
  it('counts a week of explicitly closed days as hours the shop has set', () => {
    const closed = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    expect(availableTabs(shop({ openingHours: closed }), [])).toEqual(['shop', 'visit']);
  });

  it('still shows no Visit tab for a shop that never opened the hours form', () => {
    expect(availableTabs(shop({ openingHours: {} }), [])).toEqual(['shop']);
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

// THE SLIDING PILL'S OWN DECISION (Task 17). Nothing about a `withSpring`
// reaching its destination can be asserted through a render -- the shared
// reanimated jest mock resolves every spring synchronously, so a rendered
// pill is always already AT its target, springing or not. `pillMotion` is
// the one fact that decides the difference, pulled out on its own for
// exactly that reason (see shop-tabs.tsx's own comment beside it).
describe('pillMotion: does the active-tab indicator slide or snap', () => {
  it('slides under ordinary motion, once it already knows where it came from', () => {
    expect(pillMotion(false, false)).toBe('spring');
  });

  it('never slides under reduced motion, even on a later tab press', () => {
    expect(pillMotion(true, false)).toBe('snap');
  });

  it('snaps into place on the very first measurement -- nothing to travel FROM yet', () => {
    expect(pillMotion(false, true)).toBe('snap');
  });

  it('reduced motion wins even on the first measurement', () => {
    expect(pillMotion(true, true)).toBe('snap');
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
  function renderAbout(
    overrides: Partial<PublicStorefront> = {}, cats = categories, areas = AREAS, prods = products,
  ) {
    return render(
      <AboutPanel
        storefront={shop({ about: 'Ten years on the same corner.', ...overrides })}
        products={prods}
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

  // Task 21: the stats strip (categories, delivery areas, items listed) is
  // gone, replaced by proof chips -- three reasons to trust the shop rather
  // than a dashboard row. `products` (module-level, 3 items, all in stock)
  // and `shop()`'s own default `whatsappE164` together produce the stock and
  // WhatsApp chips; `tradingSince` stays unset by default (see `shop()`
  // above), so that chip is absent here on purpose.
  it('shows what a customer can verify right now, as proof chips', () => {
    const proof = textOf(renderAbout(), 'storefront-about-proof');
    expect(proof).toContain('3 items in today');
    expect(proof).toContain('Answers on WhatsApp');
  });

  // Counting ALL listed products would claim stock a shop with an empty
  // shelf does not have -- `stock > 0` is what "in today" actually asks, and
  // the chip must never print "0 items in today".
  it('never reads "0 items in today" for a shop with nothing in stock', () => {
    const emptyStock = products.map((product) => ({ ...product, stock: 0 }));
    const tree = renderAbout({}, categories, AREAS, emptyStock);
    expect(has(tree, 'storefront-about-proof-stock')).toBe(false);
    // The row itself survives on the WhatsApp chip alone -- this fixture's
    // `whatsappE164` is still set, so "no stock" must not read as "no proof
    // row at all".
    expect(has(tree, 'storefront-about-proof')).toBe(true);
  });

  it('says "1 item in today", not "1 items", for a single item still in stock', () => {
    const oneInStock = products.map((product, i) => ({ ...product, stock: i === 0 ? 1 : 0 }));
    const tree = renderAbout({}, categories, AREAS, oneInStock);
    expect(textOf(tree, 'storefront-about-proof-stock')).toContain('1 item in today');
  });

  it('offers no WhatsApp proof chip to a shop with no number to message', () => {
    expect(has(renderAbout({ whatsappE164: null }), 'storefront-about-proof-whatsapp')).toBe(false);
  });

  // The whole row is absent, not a row of nothing, once every chip drops out.
  it('renders no proof row at all for a shop with nothing to claim', () => {
    const emptyStock = products.map((product) => ({ ...product, stock: 0 }));
    const tree = renderAbout({ whatsappE164: null, tradingSince: null }, categories, AREAS, emptyStock);
    expect(has(tree, 'storefront-about-proof')).toBe(false);
  });

  // Added by 20261021000000. Both are the shop's own writing, both optional,
  // and both must render as NOTHING when unset -- the rule every block on this
  // page follows.
  it('renders no "why shop here" band for a shop that has written none', () => {
    expect(has(renderAbout({ highlights: [] }), 'storefront-about-highlights')).toBe(false);
  });

  it('renders the cards a shop has written', () => {
    const tree = renderAbout({
      highlights: [
        { id: 'h1', title: 'We fix what we sell', body: 'Bring it back inside a year.' },
        { id: 'h2', title: 'Real solar, tested', body: 'Run for a day on our own roof.' },
      ],
    });
    expect(has(tree, 'storefront-about-highlight-h1')).toBe(true);
    expect(textOf(tree, 'storefront-about-highlight-h2')).toContain('Real solar, tested');
  });

  // One or two render at that count rather than padding out to three.
  it('does not pad a short set out to three', () => {
    const tree = renderAbout({
      highlights: [{ id: 'h1', title: 'Only one', body: 'And that is fine.' }],
    });
    expect(has(tree, 'storefront-about-highlight-h1')).toBe(true);
    expect(has(tree, 'storefront-about-highlight-h2')).toBe(false);
  });

  it('renders no gallery for a shop that has uploaded nothing', () => {
    expect(has(renderAbout({ images: [] }), 'storefront-about-gallery')).toBe(false);
  });

  it('renders every photograph a shop has uploaded', () => {
    const tree = renderAbout({
      images: [
        { id: 'i1', url: 'https://cdn.test/a.jpg' },
        { id: 'i2', url: 'https://cdn.test/b.jpg' },
        { id: 'i3', url: 'https://cdn.test/c.jpg' },
      ],
    });
    expect(has(tree, 'storefront-about-gallery')).toBe(true);
    // The first is the lead image and has no testID of its own; the rest are
    // the squares beside it.
    expect(has(tree, 'storefront-about-photo-i2')).toBe(true);
    expect(has(tree, 'storefront-about-photo-i3')).toBe(true);
  });

  // A lone square beside two gaps is a layout accident, not a gallery.
  it('shows a single photograph as the lead, with no empty squares after it', () => {
    const tree = renderAbout({ images: [{ id: 'i1', url: 'https://cdn.test/a.jpg' }] });
    expect(has(tree, 'storefront-about-gallery')).toBe(true);
    expect(has(tree, 'storefront-about-photo-i1')).toBe(false);
  });

  it('leads with a trading-since chip naming the year the shop opened, when it has one', () => {
    const tree = renderAbout({ tradingSince: 2014 });
    expect(has(tree, 'storefront-about-proof-trading')).toBe(true);
    expect(textOf(tree, 'storefront-about-proof-trading')).toContain('Trading since 2014');
  });

  it('shows no trading-since chip for a shop that never set one', () => {
    expect(has(renderAbout({ tradingSince: null }), 'storefront-about-proof-trading')).toBe(false);
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
  function renderVisit(overrides: Partial<PublicStorefront> = {}, areas: PublicDeliveryArea[] = AREAS) {
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

  it('offers no contact card to a shop with no way to be reached at all', () => {
    const tree = renderVisit({ whatsappE164: null, contactPhone: null, instagram: null });
    expect(has(tree, 'storefront-visit-contact')).toBe(false);
  });

  // The phone has been on every shop since 20260808000000 and was never shown.
  it('offers a call row when the shop has a phone, even with no WhatsApp', () => {
    const tree = renderVisit({ whatsappE164: null, contactPhone: '+252 63 000 0000' });
    expect(has(tree, 'storefront-visit-contact')).toBe(true);
    expect(textOf(tree, 'storefront-visit-call')).toContain('+252 63 000 0000');
  });

  it('offers an Instagram row, printing the @ it does not store', () => {
    const tree = renderVisit({ instagram: 'jiija.electronics' });
    expect(textOf(tree, 'storefront-visit-instagram')).toContain('@jiija.electronics');
  });

  it('shows neither row for a shop that has neither', () => {
    const tree = renderVisit({ contactPhone: null, instagram: null });
    expect(has(tree, 'storefront-visit-call')).toBe(false);
    expect(has(tree, 'storefront-visit-instagram')).toBe(false);
  });

  // The mockup draws a map here. A rendered map needs a tile provider and a
  // key, and the shop has only a neighbourhood string on file -- so this hands
  // the place to whatever maps app the device already has instead.
  it('offers a way into Maps for the place it names', () => {
    expect(has(renderVisit(), 'storefront-visit-directions')).toBe(true);
  });

  it('builds a universal maps link, not a platform-only scheme', () => {
    const url = mapsUrlFor('Jigjiga Yar, Hargeisa');
    expect(url).toContain('https://www.google.com/maps/search/');
    expect(url).toContain(encodeURIComponent('Jigjiga Yar, Hargeisa'));
  });

  // A collection-only shop reaching this tab through its hours must not be
  // told what delivery costs.
  it('does not promise delivery in its heading when there is none', () => {
    const text = textOf(renderVisit({ openingHours: HOURS }, []), 'storefront-visit-panel');
    expect(text).toContain('when we are open');
    expect(text).not.toContain('what it costs to come to you');
  });

  it('drops the delivery card entirely for a collection-only shop', () => {
    expect(has(renderVisit({ openingHours: HOURS }, []), 'storefront-visit-areas')).toBe(false);
  });
});

// The column has existed since 20260809000000 and nothing public ever read it.
describe('opening hours', () => {
  function renderHours(hours: object) {
    return render(
      <VisitPanel storefront={shop({ openingHours: hours })} areas={AREAS} colors={colors} />,
    );
  }

  // An empty object means "never filled in". Seven "Closed" rows would invent a
  // claim the shop never made -- the same rule StockCard follows when it
  // refuses to say "all in stock today" about a shop with nothing listed.
  it('says nothing at all when the shop has never set hours', () => {
    expect(has(renderHours({}), 'storefront-visit-hours')).toBe(false);
  });

  it('prints every day of the week once the shop has', () => {
    const tree = renderHours(HOURS);
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      expect(has(tree, `storefront-visit-hours-${day}`)).toBe(true);
    }
  });

  it('prints a split shift as both ranges, not just the first', () => {
    expect(textOf(renderHours(HOURS), 'storefront-visit-hours-wed'))
      .toContain('08:00 – 11:30, 14:00 – 21:00');
  });

  it('says Closed on a day with no ranges', () => {
    expect(textOf(renderHours(HOURS), 'storefront-visit-hours-tue')).toContain('Closed');
  });

  // Colour is never the only signal -- the pill says which state it is in.
  it('states open or closed in words, not only in colour', () => {
    const text = textOf(renderHours(HOURS), 'storefront-visit-open-now');
    expect(text === 'Open now' || text === 'Closed now').toBe(true);
  });

  it('marks the day the customer is actually standing in', () => {
    const tree = renderHours(HOURS);
    const today = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()];
    expect(textOf(tree, `storefront-visit-hours-${today}`)).toContain('today');
  });
});
