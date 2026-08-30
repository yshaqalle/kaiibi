// The import sits ABOVE the jest.mock below, which reads backwards but is
// correct: babel-plugin-jest-hoist lifts every jest.mock call above the
// imports before anything runs, so the fake is registered first either way.
// Writing it in that order keeps `import/first` quiet.
import { confirmPublicOrder, getPublicOrder } from '@/lib/public-order';

type FakeState = { rpcCalls: [string, unknown][]; rpcResult: { data: unknown; error: unknown } };

// Its own fake, not storefront-admin's. This module is called with NO SESSION
// AT ALL -- a customer on a link -- and giving it the admin module's mock
// would invite the next edit to reach for a shop-scoped helper here.
jest.mock('@/lib/supabase', () => {
  const state: FakeState = { rpcCalls: [], rpcResult: { data: null, error: null } };
  return {
    supabase: {
      rpc: async (name: string, params: unknown) => {
        state.rpcCalls.push([name, params]);
        return state.rpcResult;
      },
    },
    __state: state,
  };
});

const { __state: fake } = jest.requireMock('@/lib/supabase') as { __state: FakeState };

// The shape get_public_order actually returns (20261017000000). Deliberately
// snake_case and nested exactly as the SQL builds it -- if the two drift, this
// fixture is the thing that should have to change.
const PAYLOAD = {
  shop_name: 'Link Shop',
  number: 7,
  status: 'ready',
  placed_at: '2026-08-30T09:00:00Z',
  fulfilment: 'collect',
  where_to_go: 'Shop 12, Bakaaro Market',
  lines: [{ product_name: 'Basmati rice', quantity: 3, line_total_cents: 7500 }],
  subtotal_cents: 7500,
  delivery_fee_cents: 0,
  total_cents: 7500,
  confirmed_at: null,
  amendment: {
    customer_note: 'We will have the rest on Thursday',
    was_cents: 12500,
    now_cents: 7500,
    before: [{ product_name: 'Basmati rice', quantity: 5, line_total_cents: 12500 }],
    after: [{ product_name: 'Basmati rice', quantity: 3, line_total_cents: 7500 }],
  },
};

beforeEach(() => {
  fake.rpcCalls.length = 0;
  fake.rpcResult = { data: null, error: null };
});

describe('getPublicOrder', () => {
  it('calls the RPC by name, with the token as its only argument', async () => {
    fake.rpcResult = { data: PAYLOAD, error: null };
    await getPublicOrder('a1b2c3d4e5f6g7h8j9k0mnpqrs');
    expect(fake.rpcCalls).toEqual([['get_public_order', { p_token: 'a1b2c3d4e5f6g7h8j9k0mnpqrs' }]]);
    // THE ONLY ARGUMENT, asserted as an exact key set. This function is
    // granted to anon, so every parameter it declares is a field a stranger
    // can send -- a second one appearing here is a design change, not a tweak.
    expect(Object.keys(fake.rpcCalls[0][1] as object)).toEqual(['p_token']);
  });

  it('maps the payload into the shape the page renders', async () => {
    fake.rpcResult = { data: PAYLOAD, error: null };
    const order = await getPublicOrder('tok');
    expect(order).toEqual({
      shopName: 'Link Shop',
      number: 7,
      status: 'ready',
      placedAt: '2026-08-30T09:00:00Z',
      fulfilment: 'collect',
      whereToGo: 'Shop 12, Bakaaro Market',
      lines: [{ productName: 'Basmati rice', quantity: 3, lineTotalCents: 7500 }],
      subtotalCents: 7500,
      deliveryFeeCents: 0,
      totalCents: 7500,
      confirmedAt: null,
      amendment: {
        customerNote: 'We will have the rest on Thursday',
        wasCents: 12500,
        nowCents: 7500,
        before: [{ productName: 'Basmati rice', quantity: 5, lineTotalCents: 12500 }],
        after: [{ productName: 'Basmati rice', quantity: 3, lineTotalCents: 7500 }],
      },
    });
  });

  // An unknown token, an expired one, and a typo all arrive here as SQL null.
  // The page shows one "not found" for all three, which is the same refusal
  // the RPC makes -- it must not become an error the page reports differently.
  it('returns null for a token the server did not recognise', async () => {
    fake.rpcResult = { data: null, error: null };
    expect(await getPublicOrder('nope')).toBeNull();
  });

  it('returns null rather than throwing on an empty token', async () => {
    expect(await getPublicOrder('')).toBeNull();
    // ...and does not spend a round trip asking.
    expect(fake.rpcCalls).toEqual([]);
  });

  it('carries no amendment block when the order was never amended', async () => {
    fake.rpcResult = { data: { ...PAYLOAD, amendment: null }, error: null };
    const order = await getPublicOrder('tok');
    expect(order?.amendment).toBeNull();
  });

  it('throws when the request itself fails, so a network drop is not a missing order', async () => {
    fake.rpcResult = { data: null, error: { message: 'Network request failed' } };
    await expect(getPublicOrder('tok')).rejects.toMatchObject({ message: 'Network request failed' });
  });
});

describe('confirmPublicOrder', () => {
  it('calls the RPC by name, with the token as its only argument', async () => {
    fake.rpcResult = { data: { ...PAYLOAD, confirmed_at: '2026-08-30T10:00:00Z' }, error: null };
    await confirmPublicOrder('tok');
    expect(fake.rpcCalls).toEqual([['confirm_public_order', { p_token: 'tok' }]]);
  });

  // It returns the SAME projection the read does, so the page can re-render
  // from the response instead of fetching again.
  it('returns the re-read order, so the page can render the agreement', async () => {
    fake.rpcResult = { data: { ...PAYLOAD, confirmed_at: '2026-08-30T10:00:00Z' }, error: null };
    const order = await confirmPublicOrder('tok');
    expect(order?.confirmedAt).toBe('2026-08-30T10:00:00Z');
    expect(order?.totalCents).toBe(7500);
  });

  it('returns null for an unknown or expired token', async () => {
    fake.rpcResult = { data: null, error: null };
    expect(await confirmPublicOrder('nope')).toBeNull();
  });

  it('throws when the request fails', async () => {
    fake.rpcResult = { data: null, error: { message: 'boom' } };
    await expect(confirmPublicOrder('tok')).rejects.toMatchObject({ message: 'boom' });
  });
});
