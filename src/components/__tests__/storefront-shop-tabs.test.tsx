import { act, create } from 'react-test-renderer';

import { AboutPanel, shopQuestions } from '@/components/storefront/about-panel';
import { pillMotion, ShopTabRail, availableTabs } from '@/components/storefront/shop-tabs';
import { VisitPanel, mapsUrlFor, shareMessage } from '@/components/storefront/visit-panel';
import { storefrontAddress } from '@/lib/storefront-host';
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
  it('renders no highlight cards inside the story card for a shop that has written none', () => {
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

  // The caption strip is the shop's PLACE, composed with collectLocation --
  // `shop()`'s own defaults carry `collectNeighborhood: 'Jigjiga Yar'` and
  // `city: 'Hargeisa'`, so a shop with photographs and no other override reads
  // "Jigjiga Yar, Hargeisa" underneath the cover.
  it('captions the cover with the shop\'s place, when it has one', () => {
    const tree = renderAbout({ images: [{ id: 'i1', url: 'https://cdn.test/a.jpg' }] });
    expect(textOf(tree, 'storefront-about-caption')).toBe('Jigjiga Yar, Hargeisa');
  });

  // `PublicStorefront.city` is `string | null` (src/types/models.ts), so a
  // shop with photographs but no address, neighbourhood or city on file is a
  // genuinely reachable state -- and the strip must render nothing at all
  // rather than an empty line.
  it('renders no caption strip for a shop with photographs but no place on file', () => {
    const tree = renderAbout({
      images: [{ id: 'i1', url: 'https://cdn.test/a.jpg' }],
      collectAddress: null,
      collectNeighborhood: null,
      city: null,
    });
    expect(has(tree, 'storefront-about-caption')).toBe(false);
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

  it('names the place on the decision card', () => {
    expect(textOf(renderVisit(), 'storefront-visit-decision')).toContain('Jigjiga Yar, Hargeisa');
  });

  // Task 22: Share shop has no optional datum to gate on -- forwarding a
  // published shop's own address is always possible -- so the icon-row card
  // is never actually empty any more, even for a shop with no phone, no
  // Instagram and no WhatsApp. This is the deliberate behaviour change Task
  // 22 introduces (the new affordance), not a regression of the old "absent
  // when nothing to contact by" rule -- Share itself is the "something".
  it('still offers the icon row -- Share shop alone -- for a shop with no way to be reached otherwise', () => {
    const tree = renderVisit({ whatsappE164: null, contactPhone: null, instagram: null });
    expect(has(tree, 'storefront-visit-contact')).toBe(true);
    expect(has(tree, 'storefront-visit-share')).toBe(true);
    expect(has(tree, 'storefront-visit-call')).toBe(false);
    expect(has(tree, 'storefront-visit-instagram')).toBe(false);
  });

  // The phone has been on every shop since 20260808000000 and was never shown.
  // The value itself moved from on-screen text to the accessibility label when
  // the row flattened to a compact icon button (Task 22) -- "Call" is what a
  // sighted customer reads, the number is what a screen reader announces.
  it('offers a call row when the shop has a phone, even with no WhatsApp', () => {
    const tree = renderVisit({ whatsappE164: null, contactPhone: '+252 63 000 0000' });
    expect(has(tree, 'storefront-visit-contact')).toBe(true);
    const call = tree.root.find(
      (n) => n.props?.testID === 'storefront-visit-call' && typeof n.props?.onPress === 'function',
    );
    expect(call.props?.accessibilityLabel).toContain('+252 63 000 0000');
  });

  // Same move as Call above: the @ still prints, now in the accessibility
  // label rather than on the compact button's own face.
  it('offers an Instagram row, printing the @ it does not store', () => {
    const tree = renderVisit({ instagram: 'jiija.electronics' });
    const instagram = tree.root.find(
      (n) => n.props?.testID === 'storefront-visit-instagram' && typeof n.props?.onPress === 'function',
    );
    expect(instagram.props?.accessibilityLabel).toContain('@jiija.electronics');
  });

  it('shows neither row for a shop that has neither', () => {
    const tree = renderVisit({ contactPhone: null, instagram: null });
    expect(has(tree, 'storefront-visit-call')).toBe(false);
    expect(has(tree, 'storefront-visit-instagram')).toBe(false);
  });

  // Share shop composes from the app's single sources -- storefrontAddress
  // (the one place a public address is built) and shareMessage's own
  // customer-voice copy, never a hand-rolled wa.me string.
  describe('Share shop', () => {
    it('offers the control for every shop', () => {
      expect(has(renderVisit(), 'storefront-visit-share')).toBe(true);
    });

    it('names the shop and ends on its one true address', () => {
      const message = shareMessage(shop({ shopName: 'Jiija Electronics', slug: 'jiija' }));
      expect(message).toContain('Jiija Electronics');
      expect(message.endsWith(storefrontAddress('jiija'))).toBe(true);
    });
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

  // Task 22, Fix 6: WhatsApp moved from the contact icon row onto the
  // decision card (brief item 1d). An ancestor walk from the button up to
  // the decision card is what actually proves "it is ON this card" -- mere
  // presence anywhere in the tree would have passed before this task moved
  // it, and would prove nothing about the move itself.
  it('places WhatsApp on the decision card, not in the contact icon row', () => {
    const tree = renderVisit();
    const button = tree.root.find((n) => n.props?.testID === 'storefront-whatsapp-button');
    let ancestor = button.parent;
    let sawDecisionCard = false;
    while (ancestor) {
      if (ancestor.props?.testID === 'storefront-visit-decision') sawDecisionCard = true;
      expect(ancestor.props?.testID).not.toBe('storefront-visit-contact');
      ancestor = ancestor.parent;
    }
    expect(sawDecisionCard).toBe(true);
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

  // Task 22: the seven-row week is now a disclosure, collapsed by default --
  // this presses the "All hours" toggle so a test can still reach the rows
  // the way the touch-target sweep's own "expanded state too" section does.
  function expandHours(tree: ReturnType<typeof create>) {
    const toggle = tree.root.find(
      (n) => n.props?.testID === 'storefront-visit-hours-toggle' && typeof n.props?.onPress === 'function',
    );
    act(() => { toggle.props.onPress(); });
  }

  // An empty object means "never filled in". Seven "Closed" rows would invent a
  // claim the shop never made -- the same rule StockCard follows when it
  // refuses to say "all in stock today" about a shop with nothing listed.
  it('says nothing at all when the shop has never set hours', () => {
    expect(has(renderHours({}), 'storefront-visit-hours')).toBe(false);
  });

  it('collapses to a single "Today" line by default, with an All hours toggle', () => {
    const tree = renderHours(HOURS);
    expect(has(tree, 'storefront-visit-hours-toggle')).toBe(true);
    // None of the seven day rows are in the tree until the toggle is pressed
    // -- exactly the shape a Modal-while-closed or a `flyers: []` carousel
    // hid from the sweep before; this is what proves the collapse is real
    // rather than merely styled shut.
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      expect(has(tree, `storefront-visit-hours-${day}`)).toBe(false);
    }
  });

  it('prints every day of the week once expanded', () => {
    const tree = renderHours(HOURS);
    expandHours(tree);
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      expect(has(tree, `storefront-visit-hours-${day}`)).toBe(true);
    }
  });

  it('collapses again on a second press', () => {
    const tree = renderHours(HOURS);
    expandHours(tree);
    expect(has(tree, 'storefront-visit-hours-mon')).toBe(true);
    expandHours(tree);
    expect(has(tree, 'storefront-visit-hours-mon')).toBe(false);
  });

  it('prints a split shift as both ranges, not just the first, once expanded', () => {
    const tree = renderHours(HOURS);
    expandHours(tree);
    expect(textOf(tree, 'storefront-visit-hours-wed')).toContain('08:00 – 11:30, 14:00 – 21:00');
  });

  it('says Closed on a day with no ranges, once expanded', () => {
    const tree = renderHours(HOURS);
    expandHours(tree);
    expect(textOf(tree, 'storefront-visit-hours-tue')).toContain('Closed');
  });

  it('marks the day the customer is actually standing in, once expanded', () => {
    const tree = renderHours(HOURS);
    expandHours(tree);
    const today = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()];
    expect(textOf(tree, `storefront-visit-hours-${today}`)).toContain('today');
  });

  it('collapses to "Today: Closed" on a day with no ranges', () => {
    // Deterministic at ANY real clock, with no fake timer needed: this
    // fixture configures only 'tue' (to an explicit closure), so
    // `rangesFor` returns [] for whichever weekday the suite actually runs
    // on -- the absent-key branch for six of them, the explicit `[]` for
    // Tuesday itself -- and `formatDayHours([])` is "Closed" either way.
    const tuesdayOnly = { tue: [] };
    const text = textOf(renderHours(tuesdayOnly), 'storefront-visit-hours');
    expect(text).toContain('Today:');
    expect(text).toContain('Closed');
  });
});

// THE DECISION PILL'S TEXT, under a CONTROLLED clock. `isOpenAt` (and so the
// pill built on it) reads the device clock, so asserting its exact wording
// against `new Date()` would make this suite pass at 10am and fail at 10pm --
// precisely the trap this task's own brief warns against. `jest.useFakeTimers`
// pins the instant every test in this block runs at, scoped to only this
// block (`afterEach` restores real timers) so no other describe block in this
// file is affected.
describe('the decision pill, at a fixed instant', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function renderAt(hours: object, iso: string) {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(iso));
    return render(<VisitPanel storefront={shop({ openingHours: hours })} areas={AREAS} colors={colors} />);
  }

  it('reads "Open · closes <time>" while a range is open', () => {
    // 2026-08-03 is the Monday HOURS already keys off (see MONDAY-anchored
    // fixtures elsewhere in this suite); 10:00 sits inside its 08:00-21:00
    // block.
    const tree = renderAt(HOURS, '2026-08-03T10:00:00');
    expect(textOf(tree, 'storefront-visit-open-now')).toBe('Open · closes 9pm');
  });

  it('reads "Closed · opens <time>" on a day with nothing left, but hours later this week', () => {
    // Tuesday carries no ranges in HOURS; Wednesday opens at 08:00.
    const tree = renderAt(HOURS, '2026-08-04T10:00:00');
    expect(textOf(tree, 'storefront-visit-open-now')).toBe('Closed · opens tomorrow, 8am');
  });

  it('reads bare "Closed" when nothing reopens within a week', () => {
    const neverReopens = { mon: [{ open: '08:00', close: '09:00' }] };
    const tree = renderAt(neverReopens, '2026-08-03T20:00:00');
    expect(textOf(tree, 'storefront-visit-open-now')).toBe('Closed');
  });

  // isConfigured false -- the shop never set hours at all -- must print no
  // pill whatsoever, not a "Closed" that invents a claim the shop never made.
  it('renders no pill at all for a shop that never set hours', () => {
    const tree = renderAt({}, '2026-08-03T10:00:00');
    expect(has(tree, 'storefront-visit-open-now')).toBe(false);
  });
});
