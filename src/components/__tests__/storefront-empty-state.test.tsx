import { act, create } from 'react-test-renderer';

import { EmptyState } from '@/components/storefront/theme-shared';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const colors = paletteColors('ink');

const shop: PublicStorefront = {
  shopName: 'Barwaaqo Grocers',
  city: 'Hargeisa',
  slug: 'barwaaqo',
  whatsappE164: '+252634456789',
  theme: 'market',
  palette: 'ink',
  headline: null,
  about: null,
  heroImageUrl: null,
  offersDelivery: true,
  collectAddress: null,
  collectNeighborhood: null,
  paymentMode: 'on_collection',
  openingHours: {},
  tradingSince: null, highlights: [], images: [],
  contactPhone: null, instagram: null,
  flyers: [],
  autoAdvance: false,
};

// react-test-renderer unmounts a tree created outside act(), so every render
// here goes through this -- the same discipline the theme-level suites use.
function render(el: React.ReactElement): ReturnType<typeof create> {
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(el); });
  return tree;
}

// `<Text>Nothing in {category} right now.</Text>` gives children as an ARRAY
// of three fragments, not one string -- so collecting only string children
// silently drops every interpolated line, which is exactly the line these
// tests are about. Flatten instead.
function textsOf(tree: ReturnType<typeof create>): string[] {
  return tree.root
    .findAll((n) => n.props?.children !== undefined)
    .flatMap((n) => [n.props.children].flat(Infinity))
    .filter((c): c is string => typeof c === 'string');
}

// "Nothing listed yet." was the whole empty state -- a full stop on a page
// whose entire purpose is to start a conversation, printed next to a WhatsApp
// number it declined to offer. An empty screen is an invitation to act.
describe('an empty shop invites the customer to ask', () => {
  it('says why it is empty and offers the number', () => {
    const tree = render(
<EmptyState colors={colors} storefront={shop} />);
    const texts = textsOf(tree).join(' ');

    expect(texts).toContain('Nothing listed yet');
    expect(texts).toMatch(/message us|ask us/i);
    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-empty-whatsapp').length).toBeGreaterThan(0);
  });

  // Same rule WhatsAppButton and ProductActions already follow: lose the
  // button rather than render one that opens a chat with nobody.
  it('offers no WhatsApp action when the shop has no number', () => {
    const tree = render(
<EmptyState colors={colors} storefront={{ ...shop, whatsappE164: null }} />);

    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-empty-whatsapp')).toHaveLength(0);
    // ...and does not promise a message it cannot deliver.
    expect(textsOf(tree).join(' ')).not.toMatch(/message us/i);
  });
});

// A flyer with link_kind='category' can filter the grid down to nothing --
// the category the shop named on the poster may have sold out since. The
// theme rendered the SAME "Nothing listed yet." for that as for a shop with no
// products at all, which tells a customer looking at a full shop that it is
// empty.
describe('a category that filtered to nothing is a different empty', () => {
  it('names the category rather than claiming the shop is empty', () => {
    const tree = render(
      <EmptyState colors={colors} storefront={shop} category="Solar" onClearCategory={jest.fn()} />,
    );
    const texts = textsOf(tree).join(' ');

    expect(texts).toContain('Solar');
    expect(texts).not.toContain('Nothing listed yet');
  });

  it('offers the way back to everything, and calls it', () => {
    const onClear = jest.fn();
    const tree = render(
<EmptyState colors={colors} storefront={shop} category="Solar" onClearCategory={onClear} />);

    const back = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-empty-clear-category' && typeof n.props?.onPress === 'function',
    );
    expect(back.length).toBeGreaterThan(0);

    back[0].props.onPress();
    expect(onClear).toHaveBeenCalled();
  });
});
