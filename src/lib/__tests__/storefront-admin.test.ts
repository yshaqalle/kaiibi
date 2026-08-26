type FakeState = {
  rpcCalls: [string, unknown][];
  rpcResult: { data: unknown; error: unknown };
  updateCalls: { table: string; payload: unknown }[];
  updateResult: { error: unknown };
  eqCalls: [string, unknown][];
  orderCalls: [string, unknown][];
  selectCalls: { table: string; columns: string }[];
  selectResult: { data: unknown; error: unknown };
};

// Hoisted above the imports by babel-plugin-jest-hoist -- storefront-admin.ts
// picks up this client rather than the real one, the same shape as
// balances.test.ts's fake. saveDraft and publishDraft both go through
// supabase.rpc; discardDraft is a plain literal update, so `from().update().eq()`
// needs a chain too. getStorefrontPreviewProducts ends in `.eq().eq()` with
// no `.order()` -- it sorts client-side (storefront-admin.ts's own comment
// on why) -- so the chain itself must be thenable, the same pattern
// support-queue.test.ts uses for a query with no fixed terminal call.
// listOrders DOES end in `.order()` (newest first), so that method is on the
// chain too, and it stays thenable rather than becoming a fixed terminal
// call -- the same reasoning, one method further along.
jest.mock('@/lib/supabase', () => {
  const state: FakeState = {
    rpcCalls: [],
    rpcResult: { data: null, error: null },
    updateCalls: [],
    updateResult: { error: null },
    eqCalls: [],
    orderCalls: [],
    selectCalls: [],
    selectResult: { data: [], error: null },
  };
  const client = {
    rpc: async (name: string, params: unknown) => {
      state.rpcCalls.push([name, params]);
      return state.rpcResult;
    },
    from: (table: string) => ({
      update: (payload: unknown) => {
        state.updateCalls.push({ table, payload });
        return {
          eq: (column: string, value: unknown) => {
            state.eqCalls.push([column, value]);
            return Promise.resolve(state.updateResult);
          },
        };
      },
      select: (columns: string) => {
        state.selectCalls.push({ table, columns });
        const chain = {
          eq: (column: string, value: unknown) => {
            state.eqCalls.push([column, value]);
            return chain;
          },
          order: (column: string, opts: unknown) => {
            state.orderCalls.push([column, opts]);
            return chain;
          },
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(state.selectResult).then(resolve, reject),
        };
        return chain;
      },
    }),
  };
  return { supabase: client, __state: state };
});

const { __state: fake } = jest.requireMock('@/lib/supabase') as { __state: FakeState };

import {
  acceptOrder,
  cancelOrder,
  completeOrder,
  discardDraft,
  getOrderItems,
  getStorefrontPreviewProducts,
  listOrders,
  markOrderReady,
  publishBlockers,
  publishDraft,
  saveDraft,
} from '@/lib/storefront-admin';

beforeEach(() => {
  fake.rpcCalls.length = 0;
  fake.rpcResult = { data: null, error: null };
  fake.updateCalls.length = 0;
  fake.updateResult = { error: null };
  fake.eqCalls.length = 0;
  fake.orderCalls.length = 0;
  fake.selectCalls.length = 0;
  fake.selectResult = { data: [], error: null };
});

describe('publishBlockers', () => {
  it('lets a complete shop publish', () => {
    expect(publishBlockers({ slug: 'xamdi', whatsappE164: '+252634456789', onlineProductCount: 3 })).toEqual([]);
  });

  it('blocks without a slug', () => {
    expect(publishBlockers({ slug: null, whatsappE164: '+252634456789', onlineProductCount: 3 })).toContain('no_slug');
  });

  it('blocks without a WhatsApp number, because every button on the page opens that chat', () => {
    expect(publishBlockers({ slug: 'xamdi', whatsappE164: null, onlineProductCount: 3 })).toContain('no_whatsapp');
  });

  it('blocks with nothing listed, because an empty page helps nobody', () => {
    expect(publishBlockers({ slug: 'xamdi', whatsappE164: '+252634456789', onlineProductCount: 0 })).toContain('no_products');
  });

  it('reports every blocker at once rather than one at a time', () => {
    const blockers = publishBlockers({ slug: null, whatsappE164: null, onlineProductCount: 0 });
    expect(blockers).toEqual(expect.arrayContaining(['no_slug', 'no_whatsapp', 'no_products']));
    expect(blockers).toHaveLength(3);
  });
});

// The DB-side merge itself (editing the headline, then the about text, must
// not clobber the headline) is proved against a real database in
// verify-storefront-editor.sql -- save_storefront_draft is `draft =
// coalesce(draft, '{}') || p_patch`, which no sequence of client-side calls
// can race. What belongs here is only that this function is a thin,
// faithful wrapper around that RPC: the right name, the right shape, and the
// RPC's own error surfacing rather than a swallowed one.
describe('saveDraft', () => {
  it('sends the patch to save_storefront_draft for the DB to merge', async () => {
    await saveDraft('shop-1', { headline: 'New headline' });
    expect(fake.rpcCalls).toEqual([['save_storefront_draft', { p_shop_id: 'shop-1', p_patch: { headline: 'New headline' } }]]);
  });

  it('throws the RPC error rather than swallowing it', async () => {
    fake.rpcResult = { data: null, error: { message: 'boom' } };
    await expect(saveDraft('shop-1', { headline: 'x' })).rejects.toEqual({ message: 'boom' });
  });
});

describe('publishDraft', () => {
  it('calls the atomic publish_storefront RPC for the shop', async () => {
    await publishDraft('shop-1');
    expect(fake.rpcCalls).toEqual([['publish_storefront', { p_shop_id: 'shop-1' }]]);
  });

  it('throws the RPC error rather than swallowing it', async () => {
    fake.rpcResult = { data: null, error: { message: 'not authorized for shop shop-1' } };
    await expect(publishDraft('shop-1')).rejects.toEqual({ message: 'not authorized for shop shop-1' });
  });
});

// Property 7: discarding a draft is possible and returns the editor to the
// live page. There is nothing to merge away -- unlike saveDraft, a discard
// replaces the whole column with null, so a plain literal update is correct
// and no RPC is needed.
describe('discardDraft', () => {
  it('clears the draft column directly', async () => {
    await discardDraft('shop-1');
    expect(fake.updateCalls).toEqual([{ table: 'storefronts', payload: { draft: null } }]);
    expect(fake.eqCalls).toEqual([['shop_id', 'shop-1']]);
  });

  it('throws on failure rather than swallowing it', async () => {
    fake.updateResult = { error: { message: 'boom' } };
    await expect(discardDraft('shop-1')).rejects.toEqual({ message: 'boom' });
  });
});

// B3: get_public_storefront_products (20260924000100) deliberately returns
// zero rows while `published_at is null` -- right for a customer, wrong for
// this screen's own preview, which exists to show a shop what its page will
// look like the moment it FIRST publishes. This queries `products` directly,
// filtered the same way countOnlineProducts already does (is_listed_online,
// no published-state check at all), so the preview is non-empty for a shop
// that has never published but has real products marked to sell online.
describe('getStorefrontPreviewProducts', () => {
  it('reads products admin-side, filtered to is_listed_online, regardless of publish state', async () => {
    fake.selectResult = {
      data: [
        { id: 'p1', name: 'Zebra print scarf', description: null, category: 'Clothing', price_cents: 500, stock: 2, image_url: null },
      ],
      error: null,
    };
    const products = await getStorefrontPreviewProducts('shop-1');
    expect(fake.selectCalls).toEqual([
      { table: 'products', columns: 'id, name, description, category, price_cents, stock, image_url' },
    ]);
    expect(fake.eqCalls).toEqual([
      ['shop_id', 'shop-1'],
      ['is_listed_online', true],
    ]);
    expect(products).toEqual([
      { id: 'p1', name: 'Zebra print scarf', description: null, category: 'Clothing', priceCents: 500, stock: 2, imageUrl: null },
    ]);
  });

  // Mirrors get_public_storefront_products' own `order by (stock > 0) desc,
  // category nulls last, name` byte-for-byte -- a PostgREST `.order()` call
  // cannot express a computed boolean column, so this is sorted client-side
  // instead; what matters is that the RESULT matches, not the mechanism.
  it('sorts in-stock first, then category (uncategorised last), then name -- exactly like the public RPC', async () => {
    fake.selectResult = {
      data: [
        { id: 'out-of-stock', name: 'Anvil', description: null, category: 'Tools', price_cents: 100, stock: 0, image_url: null },
        { id: 'no-category', name: 'Widget', description: null, category: null, price_cents: 100, stock: 5, image_url: null },
        { id: 'zebra', name: 'Zebra print scarf', description: null, category: 'Clothing', price_cents: 500, stock: 2, image_url: null },
        { id: 'apple-tools', name: 'Apple corer', description: null, category: 'Tools', price_cents: 300, stock: 4, image_url: null },
      ],
      error: null,
    };
    const products = await getStorefrontPreviewProducts('shop-1');
    // In stock: Clothing before Tools before Tools/name tiebreak (Apple < Zebra
    // has no effect here -- they're different categories), then the
    // uncategorised in-stock item, then the one out-of-stock item last of all.
    expect(products.map((p) => p.id)).toEqual(['zebra', 'apple-tools', 'no-category', 'out-of-stock']);
  });

  it('throws on failure rather than swallowing it', async () => {
    fake.selectResult = { data: null, error: { message: 'boom' } };
    await expect(getStorefrontPreviewProducts('shop-1')).rejects.toEqual({ message: 'boom' });
  });
});

// Task 9 built this as a read-only list; Task 6 turns it into an inbox, which
// needs `status` read for the first time (the column plan 3 deliberately
// left out -- see orders.tsx's own header) plus `note` and
// `cancellation_reason` for the detail view. Nothing here writes a status --
// that is acceptOrder/markOrderReady/cancelOrder/completeOrder below, each a
// thin wrapper around the one door the DB actually permits.
describe('listOrders', () => {
  it("reads a shop's own orders, newest first, with the item count summed from order_items -- not the line count", async () => {
    fake.selectResult = {
      data: [
        {
          id: 'o1',
          number: 7,
          customer_name: 'Amina Yusuf',
          customer_phone: '+252634456789',
          fulfilment: 'deliver',
          delivery_area: 'Hargeisa - 26 June',
          delivery_landmark: 'Behind Maansoor Hotel, blue gate',
          note: 'Ring the bell twice',
          status: 'accepted',
          cancellation_reason: null,
          total_cents: 4599,
          created_at: '2026-08-20T10:00:00Z',
          // Two lines, five units apiece -- ten items to pack, not two.
          // sales.item_count (0001_init.sql) sums quantity the same way.
          order_items: [{ quantity: 5 }, { quantity: 5 }],
        },
      ],
      error: null,
    };
    const orders = await listOrders('shop-1');
    expect(fake.selectCalls).toEqual([
      {
        table: 'orders',
        columns:
          'id, number, customer_name, customer_phone, fulfilment, delivery_area, delivery_landmark, note, status, cancellation_reason, total_cents, created_at, order_items(quantity)',
      },
    ]);
    expect(fake.eqCalls).toEqual([['shop_id', 'shop-1']]);
    expect(fake.orderCalls).toEqual([['created_at', { ascending: false }]]);
    expect(orders).toEqual([
      {
        id: 'o1',
        number: 7,
        customerName: 'Amina Yusuf',
        customerPhone: '+252634456789',
        fulfilment: 'deliver',
        deliveryArea: 'Hargeisa - 26 June',
        deliveryLandmark: 'Behind Maansoor Hotel, blue gate',
        note: 'Ring the bell twice',
        status: 'accepted',
        cancellationReason: null,
        itemCount: 10,
        totalCents: 4599,
        createdAt: '2026-08-20T10:00:00Z',
      },
    ]);
  });

  // orders_delivery_matches_fulfilment (20260926000050) guarantees a collect
  // order never carries a delivery_area server-side; this just proves the
  // mapper passes that null through rather than inventing a placeholder.
  // Same guarantee covers delivery_landmark.
  it('carries a collect order through with no delivery area or landmark', async () => {
    fake.selectResult = {
      data: [
        {
          id: 'o2',
          number: 1,
          customer_name: 'Xamse Cali',
          customer_phone: '+252634456780',
          fulfilment: 'collect',
          delivery_area: null,
          delivery_landmark: null,
          note: null,
          status: 'pending',
          cancellation_reason: null,
          total_cents: 100,
          created_at: '2026-08-20T09:00:00Z',
          order_items: [{ quantity: 1 }],
        },
      ],
      error: null,
    };
    const [order] = await listOrders('shop-1');
    expect(order.fulfilment).toBe('collect');
    expect(order.deliveryArea).toBeNull();
    expect(order.deliveryLandmark).toBeNull();
  });

  // Property 2 of Task 6: the status column plan 3 left out, because nothing
  // could change it -- now everything can, and a cancelled order carries WHY
  // (orders_cancellation_reason_required, 20260928000100).
  it('reads the status and cancellation reason of a cancelled order', async () => {
    fake.selectResult = {
      data: [
        {
          id: 'o3',
          number: 2,
          customer_name: 'Xamse Cali',
          customer_phone: '+252634456780',
          fulfilment: 'collect',
          delivery_area: null,
          delivery_landmark: null,
          note: null,
          status: 'cancelled',
          cancellation_reason: 'Out of stock, customer notified',
          total_cents: 100,
          created_at: '2026-08-20T09:00:00Z',
          order_items: [{ quantity: 1 }],
        },
      ],
      error: null,
    };
    const [order] = await listOrders('shop-1');
    expect(order.status).toBe('cancelled');
    expect(order.cancellationReason).toBe('Out of stock, customer notified');
  });

  it('throws on failure rather than swallowing it', async () => {
    fake.selectResult = { data: null, error: { message: 'boom' } };
    await expect(listOrders('shop-1')).rejects.toEqual({ message: 'boom' });
  });
});

// Task 6: the lines a shop must pull off the shelf, with the price the
// customer actually agreed to (order_items snapshots product_name and
// unit_price_cents at checkout time -- 20260926000050's own header) rather
// than today's product price. Ordered by product_name, the same tie-break
// complete_storefront_order itself uses when it assembles this same table
// for complete_sale (20260928000200_complete_storefront_order.sql:307-324),
// so the detail view lists lines in the order the shop will see them posted.
describe('getOrderItems', () => {
  it("reads an order's lines, snapshotted price included, ordered by product name", async () => {
    fake.selectResult = {
      data: [
        { id: 'i1', product_id: 'p1', product_name: 'Rice 5kg', unit_price_cents: 1200, quantity: 2, line_total_cents: 2400 },
      ],
      error: null,
    };
    const items = await getOrderItems('order-1');
    expect(fake.selectCalls).toEqual([
      { table: 'order_items', columns: 'id, product_id, product_name, unit_price_cents, quantity, line_total_cents' },
    ]);
    expect(fake.eqCalls).toEqual([['order_id', 'order-1']]);
    expect(fake.orderCalls).toEqual([['product_name', { ascending: true }]]);
    expect(items).toEqual([
      { id: 'i1', productId: 'p1', productName: 'Rice 5kg', unitPriceCents: 1200, quantity: 2, lineTotalCents: 2400 },
    ]);
  });

  // Same `on delete set null` shape checkOrderFulfilment already treats as
  // "no product to check stock against" -- the line stays readable off its
  // own snapshot regardless.
  it('carries a deleted product through with a null productId', async () => {
    fake.selectResult = {
      data: [
        { id: 'i2', product_id: null, product_name: 'Discontinued kettle', unit_price_cents: 900, quantity: 1, line_total_cents: 900 },
      ],
      error: null,
    };
    const [item] = await getOrderItems('order-1');
    expect(item.productId).toBeNull();
  });

  it('throws on failure rather than swallowing it', async () => {
    fake.selectResult = { data: null, error: { message: 'boom' } };
    await expect(getOrderItems('order-1')).rejects.toEqual({ message: 'boom' });
  });
});

// Task 6, property 4: actions match the state machine exactly. These four are
// thin wrappers around the two doors the DB actually opens
// (transition_order, complete_storefront_order --
// 20260928000100_order_transitions.sql / 20260928000200_complete_storefront_
// order.sql) -- no client-side re-encoding of which move is legal, the same
// posture transition_order's own header takes about not duplicating the
// trigger's table. A move this file did not intend is left to the RPC's own
// invalid_order_transition, not pre-empted here.
describe('acceptOrder', () => {
  it("calls transition_order with 'accepted' -- the only legal move out of pending", async () => {
    await acceptOrder('order-1');
    expect(fake.rpcCalls).toEqual([['transition_order', { p_order_id: 'order-1', p_status: 'accepted' }]]);
  });

  it('throws the RPC error rather than swallowing it', async () => {
    fake.rpcResult = { data: null, error: { message: 'invalid_order_transition' } };
    await expect(acceptOrder('order-1')).rejects.toEqual({ message: 'invalid_order_transition' });
  });
});

describe('markOrderReady', () => {
  it("calls transition_order with 'ready' -- the only legal move out of accepted", async () => {
    await markOrderReady('order-1');
    expect(fake.rpcCalls).toEqual([['transition_order', { p_order_id: 'order-1', p_status: 'ready' }]]);
  });

  it('throws the RPC error rather than swallowing it', async () => {
    fake.rpcResult = { data: null, error: { message: 'invalid_order_transition' } };
    await expect(markOrderReady('order-1')).rejects.toEqual({ message: 'invalid_order_transition' });
  });
});

describe('cancelOrder', () => {
  // orders_cancellation_reason_required (20260928000100) enforces this
  // server-side no matter what; the reason travels through as the RPC's own
  // p_cancellation_reason rather than a second, client-only validation.
  it('calls transition_order with the reason the shop gave', async () => {
    await cancelOrder('order-1', 'Out of stock, customer notified');
    expect(fake.rpcCalls).toEqual([
      ['transition_order', { p_order_id: 'order-1', p_status: 'cancelled', p_cancellation_reason: 'Out of stock, customer notified' }],
    ]);
  });

  it('throws the RPC error rather than swallowing it', async () => {
    fake.rpcResult = { data: null, error: { message: 'cancellation_reason_required' } };
    await expect(cancelOrder('order-1', '')).rejects.toEqual({ message: 'cancellation_reason_required' });
  });
});

// Property 6: completion asks how the customer paid before it posts.
// complete_storefront_order's own permitted list (20260928000200:277) is
// 'cash' | 'zaad' | 'edahab' | 'other' -- complete_sale's list minus
// 'unpaid', because an order handed over at the door has been paid for.
describe('completeOrder', () => {
  it('calls complete_storefront_order with the payment method actually taken at the door', async () => {
    await completeOrder('order-1', 'zaad');
    expect(fake.rpcCalls).toEqual([['complete_storefront_order', { p_order_id: 'order-1', p_payment_method: 'zaad' }]]);
  });

  it('throws the RPC error rather than swallowing it -- e.g. a stock shortfall discovered at hand-over', async () => {
    fake.rpcResult = { data: null, error: { message: 'insufficient_stock' } };
    await expect(completeOrder('order-1', 'cash')).rejects.toEqual({ message: 'insufficient_stock' });
  });
});
