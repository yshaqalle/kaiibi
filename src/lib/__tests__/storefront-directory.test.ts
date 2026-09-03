import { citiesOf, listPublicShops, shopBlurb } from '@/lib/storefront-directory';
import type { PublicShopSummary } from '@/types/models';

// `mock`-prefixed because jest.mock's factory is hoisted above this line and
// may only close over variables named that way.
const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => mockRpc(...args) } }));
jest.mock('@/lib/storage', () => ({
  publicImageUrl: (path: string | null) => (path ? `https://cdn.test/${path}` : null),
}));

beforeEach(() => mockRpc.mockReset());

function summary(overrides: Partial<PublicShopSummary> = {}): PublicShopSummary {
  return {
    shopName: 'Alpha Hardware', slug: 'dir-alpha', city: 'Hargeisa',
    headline: null, about: null, heroImageUrl: null, offersDelivery: false, productCount: 4,
    ...overrides,
  };
}

describe('reading the directory', () => {
  it('calls the one anon RPC rather than querying a table', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await listPublicShops();
    expect(mockRpc).toHaveBeenCalledWith('list_public_storefronts', { p_city: null });
  });

  it('passes a city through trimmed', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await listPublicShops('  Hargeisa  ');
    expect(mockRpc).toHaveBeenCalledWith('list_public_storefronts', { p_city: 'Hargeisa' });
  });

  // A filter typed down to whitespace means "everywhere", not "a city no shop
  // is in" -- the difference between the whole directory and an empty page.
  it('treats a whitespace-only city as no filter at all', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await listPublicShops('   ');
    expect(mockRpc).toHaveBeenCalledWith('list_public_storefronts', { p_city: null });
  });

  it('maps the row shape the RPC actually returns', async () => {
    mockRpc.mockResolvedValue({
      data: [{
        shop_name: 'Alpha Hardware', slug: 'dir-alpha', city: 'Hargeisa',
        headline: 'Everything that plugs in.', about: 'A long story.',
        hero_image_url: 'heroes/alpha.jpg', offers_delivery: true, product_count: 12,
      }],
      error: null,
    });
    const [shop] = await listPublicShops();
    expect(shop).toEqual({
      shopName: 'Alpha Hardware', slug: 'dir-alpha', city: 'Hargeisa',
      headline: 'Everything that plugs in.', about: 'A long story.',
      heroImageUrl: 'https://cdn.test/heroes/alpha.jpg', offersDelivery: true, productCount: 12,
    });
  });

  // The Expo bundle updates over the air and migrations do not, so a client
  // WILL run against a database whose function has fewer columns than it
  // expects. A missing field must arrive as the value an empty shop already
  // produces, never as undefined.
  it('degrades a row from an older database rather than rendering undefined', async () => {
    mockRpc.mockResolvedValue({ data: [{ shop_name: 'Beta', slug: 'beta' }], error: null });
    const [shop] = await listPublicShops();
    expect(shop.city).toBeNull();
    expect(shop.headline).toBeNull();
    expect(shop.heroImageUrl).toBeNull();
    expect(shop.offersDelivery).toBe(false);
    expect(shop.productCount).toBe(0);
  });

  it('reads a null payload as an empty directory', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await expect(listPublicShops()).resolves.toEqual([]);
  });

  it('throws the RPC error rather than showing an empty directory', async () => {
    mockRpc.mockResolvedValue({ data: null, error: new Error('network') });
    await expect(listPublicShops()).rejects.toThrow('network');
  });
});

// Derived from the rows, not fetched -- so the chips can never offer a city the
// grid below them cannot fill.
describe('the city chips', () => {
  it('lists each city once, alphabetically', () => {
    expect(citiesOf([
      summary({ city: 'Hargeisa' }), summary({ city: 'Borama' }), summary({ city: 'Hargeisa' }),
    ])).toEqual(['Borama', 'Hargeisa']);
  });

  it('folds spellings that differ only by case into one chip', () => {
    expect(citiesOf([summary({ city: 'Hargeisa' }), summary({ city: 'hargeisa' })]))
      .toEqual(['Hargeisa']);
  });

  it('offers no chip for a shop that has no city on file', () => {
    expect(citiesOf([summary({ city: null }), summary({ city: '  ' })])).toEqual([]);
  });
});

describe('what a card says under the name', () => {
  it('leads with the headline, which is the line the shop wrote to sell itself', () => {
    expect(shopBlurb(summary({ headline: 'Fresh in by six.', about: 'A long story.' })))
      .toBe('Fresh in by six.');
  });

  it('falls back to the story when there is no headline', () => {
    expect(shopBlurb(summary({ headline: null, about: 'A long story.' }))).toBe('A long story.');
  });

  it('treats a blank headline as no headline', () => {
    expect(shopBlurb(summary({ headline: '   ', about: 'A long story.' }))).toBe('A long story.');
  });

  // The card drops the line rather than reserving space for it.
  it('says nothing at all when the shop has written neither', () => {
    expect(shopBlurb(summary({ headline: null, about: null }))).toBeNull();
  });
});
