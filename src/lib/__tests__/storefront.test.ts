// storefront.ts imports '@/lib/supabase', which constructs the real client at
// module load and throws without EXPO_PUBLIC_SUPABASE_* env vars -- same
// reason billing-period.test.ts mocks this module. waLink itself never
// touches Supabase; this only unblocks the import. getPublicDeliveryAreas
// below needs an actual `rpc` to call, so it's a jest.fn() rather than the
// empty object waLink alone got away with.
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));
// storefront_flyers.image_path is a PATH into the bucket, never a URL
// (20260930000000 says why), so the reader resolves it. That resolution is
// the bucket's business, not this module's -- stubbed here so a mapping test
// asserts the mapping and not Supabase's URL shape.
jest.mock('@/lib/storage', () => ({ publicImageUrl: (path: string | null) => (path ? `https://cdn.test/${path}` : null) }));

import { supabase } from '@/lib/supabase';
import { getPublicDeliveryAreas, getPublicStorefront, waLink } from '@/lib/storefront';

const rpc = supabase.rpc as jest.Mock;

describe('waLink', () => {
  it('drops the plus, because wa.me takes bare digits', () => {
    expect(waLink('+252634456789', 'hello')).toBe('https://wa.me/252634456789?text=hello');
  });

  it('encodes the message', () => {
    expect(waLink('+252634456789', 'Anker 20W charger — $12')).toBe(
      'https://wa.me/252634456789?text=Anker%2020W%20charger%20%E2%80%94%20%2412',
    );
  });

  it('handles a newline, which a multi-line order message needs', () => {
    expect(waLink('+252634456789', 'a\nb')).toBe('https://wa.me/252634456789?text=a%0Ab');
  });
});

// Task 3: get_public_storefront gained a `flyers` column in 20260930000100
// and nothing read it. These pin the wiring from that column to the shape
// the themes render.
describe('getPublicStorefront flyers', () => {
  beforeEach(() => rpc.mockReset());

  const row = {
    shop_name: 'Xamdi Electronics',
    city: 'Hargeisa',
    slug: 'xamdi',
    whatsapp_e164: '+252634456789',
    theme: 'market',
    palette: 'ink',
    headline: null,
    about: null,
    hero_image_url: null,
    offers_delivery: true,
    payment_mode: 'on_collection',
  };

  it('maps each flyer, resolving image_path to a URL and the derived offer', async () => {
    rpc.mockResolvedValue({
      data: [{
        ...row,
        flyers: [{
          id: 'f1',
          image_path: 'shop-1/flyer-solar.jpg',
          headline: '20% off all solar',
          subline: 'This week only.',
          link_kind: 'category',
          link_value: 'Solar',
          position: 0,
          offer: { value: '20%', scope: 'All Solar', when: 'Friday 14 — Sunday 16 August' },
        }],
      }],
      error: null,
    });

    const storefront = await getPublicStorefront('xamdi');
    expect(storefront?.flyers).toEqual([{
      id: 'f1',
      imageUrl: 'https://cdn.test/shop-1/flyer-solar.jpg',
      headline: '20% off all solar',
      subline: 'This week only.',
      linkKind: 'category',
      linkValue: 'Solar',
      offer: { value: '20%', scope: 'All Solar', when: 'Friday 14 — Sunday 16 August' },
    }]);
  });

  it('carries a flyer with no offer through as an announcement', async () => {
    rpc.mockResolvedValue({
      data: [{
        ...row,
        flyers: [{
          id: 'f2', image_path: 'shop-1/eid.jpg', headline: 'Eid stock has landed',
          subline: null, link_kind: 'none', link_value: null, position: 1, offer: null,
        }],
      }],
      error: null,
    });
    const storefront = await getPublicStorefront('xamdi');
    expect(storefront?.flyers[0].offer).toBeNull();
    expect(storefront?.flyers[0].linkKind).toBe('none');
  });

  // The CHECK constraint makes an unknown link_kind impossible, so this is
  // the same belt-and-braces `theme` and `palette` already get one field
  // above: a page that goes slightly quieter than the shop chose beats a
  // slide wired to a branch no renderer has.
  it('falls back to "none" on a link_kind it does not recognise', async () => {
    rpc.mockResolvedValue({
      data: [{ ...row, flyers: [{ id: 'f3', image_path: 'a.jpg', link_kind: 'telegram', link_value: 'x' }] }],
      error: null,
    });
    const storefront = await getPublicStorefront('xamdi');
    expect(storefront?.flyers[0].linkKind).toBe('none');
  });

  // The RPC coalesces to '[]' and never returns null (20260930000100), so a
  // renderer has one empty state rather than two -- but a client running
  // against a database where that migration has not landed gets no `flyers`
  // key at all, and must render a page rather than throw.
  it('reads a missing flyers column as no flyers', async () => {
    rpc.mockResolvedValue({ data: [row], error: null });
    expect((await getPublicStorefront('xamdi'))?.flyers).toEqual([]);
  });
});

// Task 6, property 5: this is the FIRST caller of get_public_delivery_areas
// (20260924000100_storefront_public_read.sql) -- it has had none since plan
// 1. Mirrors getPublicStorefront/getPublicStorefrontProducts exactly: an RPC
// call, an explicit column map, no session required (granted to anon).
describe('getPublicDeliveryAreas', () => {
  beforeEach(() => rpc.mockReset());

  it('calls the RPC with the slug and maps snake_case rows to camelCase', async () => {
    rpc.mockResolvedValue({
      data: [
        { name: 'Near the stadium', fee_cents: 300 },
        { name: 'Outside town', fee_cents: 800 },
      ],
      error: null,
    });
    const areas = await getPublicDeliveryAreas('xamdi');
    expect(rpc).toHaveBeenCalledWith('get_public_delivery_areas', { p_slug: 'xamdi' });
    expect(areas).toEqual([
      { name: 'Near the stadium', feeCents: 300 },
      { name: 'Outside town', feeCents: 800 },
    ]);
  });

  it('returns an empty list rather than null, same as getPublicStorefrontProducts', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await getPublicDeliveryAreas('xamdi')).toEqual([]);
  });

  it('throws on an RPC error rather than swallowing it', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('db down') });
    await expect(getPublicDeliveryAreas('xamdi')).rejects.toThrow('db down');
  });
});
