// storefront.ts imports '@/lib/supabase', which constructs the real client at
// module load and throws without EXPO_PUBLIC_SUPABASE_* env vars -- same
// reason billing-period.test.ts mocks this module. waLink itself never
// touches Supabase; this only unblocks the import. getPublicDeliveryAreas
// below needs an actual `rpc` to call, so it's a jest.fn() rather than the
// empty object waLink alone got away with.
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));

import { supabase } from '@/lib/supabase';
import { getPublicDeliveryAreas, waLink } from '@/lib/storefront';

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
