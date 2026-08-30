type FakeState = {
  rpcCalls: [string, unknown][];
  rpcResult: { data: unknown; error: unknown };
  updateCalls: { table: string; payload: unknown }[];
  updateResult: { error: unknown };
  insertCalls: { table: string; payload: unknown }[];
  insertResult: { error: unknown };
  deleteCalls: string[];
  deleteResult: { error: unknown };
  eqCalls: [string, unknown][];
  inCalls: [string, unknown][];
  orderCalls: [string, unknown][];
  selectCalls: { table: string; columns: string; options?: unknown }[];
  selectResult: { data: unknown; error: unknown; count?: number | null };
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
// call -- the same reasoning, one method further along. countOrdersNeedingAction
// ends in `.in()` (N3) rather than `.order()`, and its own select() carries a
// second argument ({count: 'exact', head: true}) that no earlier query here
// used -- both captured for that test alone.
jest.mock('@/lib/supabase', () => {
  const state: FakeState = {
    rpcCalls: [],
    rpcResult: { data: null, error: null },
    updateCalls: [],
    updateResult: { error: null },
    insertCalls: [],
    insertResult: { error: null },
    deleteCalls: [],
    deleteResult: { error: null },
    eqCalls: [],
    inCalls: [],
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
      // Flyers are the first storefront-admin rows written by a plain insert
      // (delivery areas go through saveDeliveryArea's own upsert-by-id) and
      // the first deleted by one, so both chains join the fake here.
      insert: (payload: unknown) => {
        state.insertCalls.push({ table, payload });
        return Promise.resolve(state.insertResult);
      },
      delete: () => {
        state.deleteCalls.push(table);
        return {
          eq: (column: string, value: unknown) => {
            state.eqCalls.push([column, value]);
            return Promise.resolve(state.deleteResult);
          },
        };
      },
      select: (columns: string, options?: unknown) => {
        state.selectCalls.push({ table, columns, options });
        const chain = {
          eq: (column: string, value: unknown) => {
            state.eqCalls.push([column, value]);
            return chain;
          },
          in: (column: string, values: unknown) => {
            state.inCalls.push([column, values]);
            return chain;
          },
          order: (column: string, opts: unknown) => {
            state.orderCalls.push([column, opts]);
            return chain;
          },
          // primaryLocation's terminal pair -- the only query here that ends
          // in .limit(1).maybeSingle() rather than being awaited as a list.
          // Both read the same selectResult, so a test sets `data` to a single
          // row object (or null) rather than an array.
          limit: () => chain,
          maybeSingle: () => Promise.resolve(state.selectResult),
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
  countOrdersNeedingAction,
  createFlyer,
  deleteFlyer,
  discardDraft,
  FLYER_LIMIT,
  amendOrder,
  flyerErrorMessage,
  getCurrentPrices,
  getOrderItems,
  getStorefrontPreviewProducts,
  listAddressSuffixSuggestions,
  listFlyers,
  listOrders,
  markOrderReady,
  orderErrorMessage,
  publishBlockers,
  publishDraft,
  reorderFlyers,
  saveDraft,
  setAutoAdvance,
  shopHasStorefront,
  updateFlyer,
} from '@/lib/storefront-admin';

beforeEach(() => {
  fake.rpcCalls.length = 0;
  fake.rpcResult = { data: null, error: null };
  fake.updateCalls.length = 0;
  fake.updateResult = { error: null };
  fake.insertCalls.length = 0;
  fake.insertResult = { error: null };
  fake.deleteCalls.length = 0;
  fake.deleteResult = { error: null };
  fake.eqCalls.length = 0;
  fake.inCalls.length = 0;
  fake.orderCalls.length = 0;
  fake.selectCalls.length = 0;
  fake.selectResult = { data: [], error: null };
});

// The nav's whole question about a shop's page is "is there a row", and that
// is a count, not a read. It used to be answered with getMyStorefront, which
// selects every live column AND the `draft` jsonb -- a shop's entire unsaved
// editor state, dragged down a phone connection so a menu could decide whether
// to draw two rows.
describe('shopHasStorefront', () => {
  it('asks for a count only -- head:true, no rows, and no draft payload', async () => {
    fake.selectResult = { data: null, error: null, count: 1 };
    expect(await shopHasStorefront('shop-1')).toBe(true);
    expect(fake.selectCalls).toEqual([
      { table: 'storefronts', columns: 'shop_id', options: { count: 'exact', head: true } },
    ]);
    expect(fake.eqCalls).toEqual([['shop_id', 'shop-1']]);
  });

  it('is false for a shop that has never set a page up', async () => {
    fake.selectResult = { data: null, error: null, count: 0 };
    expect(await shopHasStorefront('shop-1')).toBe(false);
  });

  // Same defensive fallback countOrdersNeedingAction takes: a null count is
  // not an answer, and "no page" is the safe reading -- it hides the rows,
  // which is what they did before any of this existed.
  it('treats a null count as no page rather than throwing', async () => {
    fake.selectResult = { data: null, error: null, count: null };
    expect(await shopHasStorefront('shop-1')).toBe(false);
  });

  // A failure must reach the caller. useShopHasStorefront forgets a rejected
  // lookup so the next mount asks again -- swallowing the error here into
  // `false` would instead pin "no page" on one bad request.
  it('throws rather than answering when the query fails', async () => {
    fake.selectResult = { data: null, error: { message: 'nope' }, count: null };
    await expect(shopHasStorefront('shop-1')).rejects.toEqual({ message: 'nope' });
  });
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

// What a shop is offered to APPEND when the address derived from its name is
// already another shop's. The rule that matters is the one it cannot break:
// every suggestion comes from a place the shop actually trades in, so no code
// path here can produce a counter.
describe('listAddressSuffixSuggestions', () => {
  it('offers the neighbourhood first, then the city', async () => {
    fake.selectResult = { data: { id: 'loc-1', neighborhood: 'Koodbuur', city: 'Hargeisa' }, error: null };
    await expect(listAddressSuffixSuggestions('shop-1')).resolves.toEqual(['koodbuur', 'hargeisa']);
  });

  it('resolves the same primary location the rest of the data layer does', async () => {
    fake.selectResult = { data: { id: 'loc-1', neighborhood: 'Road No 1', city: 'Berbera' }, error: null };
    await listAddressSuffixSuggestions('shop-1');
    // Primary first, then oldest -- the ordering complete_sale defaults to.
    expect(fake.orderCalls).toEqual([
      ['is_primary', { ascending: false }],
      ['created_at', { ascending: true }],
    ]);
    expect(fake.selectCalls).toEqual([
      { table: 'shop_locations', columns: 'id, neighborhood, city', options: undefined },
    ]);
  });

  it('normalizes a suggestion into something that can be a web address', async () => {
    fake.selectResult = { data: { id: 'loc-1', neighborhood: 'Road No 1', city: null }, error: null };
    await expect(listAddressSuffixSuggestions('shop-1')).resolves.toEqual(['road-no-1']);
  });

  it('offers a place once when the neighbourhood and the city are the same word', async () => {
    fake.selectResult = { data: { id: 'loc-1', neighborhood: 'Berbera', city: 'Berbera' }, error: null };
    await expect(listAddressSuffixSuggestions('shop-1')).resolves.toEqual(['berbera']);
  });

  // THE property, said as plainly as it can be said: a shop with no
  // neighbourhood and no city is offered NOTHING, not '2'. A number reads
  // like a mistake; the editor asks for the part of town instead.
  it('offers nothing -- never a number -- when the shop has no place recorded', async () => {
    fake.selectResult = { data: { id: 'loc-1', neighborhood: null, city: null }, error: null };
    await expect(listAddressSuffixSuggestions('shop-1')).resolves.toEqual([]);

    fake.selectResult = { data: null, error: null };
    await expect(listAddressSuffixSuggestions('shop-1')).resolves.toEqual([]);
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
          subtotal_cents: 4499,
          delivery_fee_cents: 100,
          total_cents: 4599,
          // Not yet completed -- complete_storefront_order (20260928000200)
          // is the only writer of this column, and it sets it in the same
          // statement as status -> 'completed'.
          sale_id: null,
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
          'id, number, customer_name, customer_phone, fulfilment, delivery_area, delivery_landmark, note, status, cancellation_reason, subtotal_cents, delivery_fee_cents, total_cents, sale_id, created_at, order_items(quantity)',
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
        subtotalCents: 4499,
        deliveryFeeCents: 100,
        totalCents: 4599,
        saleId: null,
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
          subtotal_cents: 100,
          delivery_fee_cents: 0,
          total_cents: 100,
          sale_id: null,
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
    expect(order.deliveryFeeCents).toBe(0);
  });

  // Task 6: the reconciliation block's whole reason to exist -- a completed
  // order's sale_id read back as ShopOrder.saleId, not silently dropped or
  // left undefined by a mapper that forgets the column.
  it('reads the sale a completed order became', async () => {
    fake.selectResult = {
      data: [
        {
          id: 'o4',
          number: 3,
          customer_name: 'Hodan Jama',
          customer_phone: '+252634456781',
          fulfilment: 'collect',
          delivery_area: null,
          delivery_landmark: null,
          note: null,
          status: 'completed',
          cancellation_reason: null,
          subtotal_cents: 8600,
          delivery_fee_cents: 0,
          total_cents: 8600,
          sale_id: 'f3a2c1de-0000-0000-0000-000000000000',
          created_at: '2026-08-20T09:00:00Z',
          order_items: [{ quantity: 1 }],
        },
      ],
      error: null,
    };
    const [order] = await listOrders('shop-1');
    expect(order.saleId).toBe('f3a2c1de-0000-0000-0000-000000000000');
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
          subtotal_cents: 100,
          delivery_fee_cents: 0,
          total_cents: 100,
          sale_id: null,
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

// N3: what Settings' Orders badge and the Dashboard's attention row both
// count -- read as a count now, not derived from a full fetch. 'pending' and
// 'accepted' are the two moves the shop itself has not made yet; 'ready'
// still counts -- a prepped order nobody has handed over or collected is
// just as unfinished, the same reading orders.tsx's own UNCONFIRMED filter
// gives it. 'completed' and 'cancelled' are the two terminal states,
// deliberately excluded server-side via `.in('status', ORDERS_NEEDING_ACTION)`
// -- a count that never reaches zero is a badge nobody trusts by the second
// week.
describe('countOrdersNeedingAction', () => {
  it("asks for a count only -- head:true, no rows -- filtered to the shop's own pending/accepted/ready orders", async () => {
    fake.selectResult = { data: null, error: null, count: 3 };
    const count = await countOrdersNeedingAction('shop-1');
    expect(fake.selectCalls).toEqual([{ table: 'orders', columns: 'id', options: { count: 'exact', head: true } }]);
    expect(fake.eqCalls).toEqual([['shop_id', 'shop-1']]);
    expect(fake.inCalls).toEqual([['status', ['pending', 'accepted', 'ready']]]);
    expect(count).toBe(3);
  });

  it('is zero when nothing needs action', async () => {
    fake.selectResult = { data: null, error: null, count: 0 };
    expect(await countOrdersNeedingAction('shop-1')).toBe(0);
  });

  // count comes back null on some failure shapes even without `error` set --
  // same defensive fallback listOrders' own `data ?? []` takes.
  it('treats a null count as zero rather than throwing', async () => {
    fake.selectResult = { data: null, error: null, count: null };
    expect(await countOrdersNeedingAction('shop-1')).toBe(0);
  });

  it('throws on failure rather than swallowing it', async () => {
    fake.selectResult = { data: null, error: { message: 'boom' }, count: null };
    await expect(countOrdersNeedingAction('shop-1')).rejects.toEqual({ message: 'boom' });
  });
});

// B1: the sentence a shopkeeper reads instead of a raw snake_case token.
// Every code transition_order / complete_storefront_order / (20260928000600)
// actually raise, per the migrations themselves -- not a re-derived guess at
// the list.
describe('orderErrorMessage', () => {
  it('returns null for an error with no string message, so callers keep their existing fallback', () => {
    expect(orderErrorMessage(null)).toBeNull();
    expect(orderErrorMessage({})).toBeNull();
    expect(orderErrorMessage({ message: 42 })).toBeNull();
  });

  it('returns null for a code it does not recognise -- e.g. a network drop', () => {
    expect(orderErrorMessage({ message: 'Network request failed' })).toBeNull();
  });

  it('maps insufficient_stock to a sentence that says what to do, not the code', () => {
    const msg = orderErrorMessage({ message: 'insufficient_stock' });
    expect(msg).not.toBe('insufficient_stock');
    expect(msg).toMatch(/stock/i);
  });

  // NARROWED BY 20260929000200. This code no longer means "a price moved" or
  // "your shop charges tax" -- both of those now complete normally. It means
  // the order's stored total is not the sum of its own lines, which is why the
  // detail carries `lines_cents` beside `quoted_cents`. Must still read as a
  // sentence, never the raw code, and must not go back to blaming a price
  // change: a shopkeeper sent to re-check their prices would find nothing
  // wrong with them.
  it('maps order_total_changed to a sentence about the order not adding up, not an arithmetic-bug-sounding code', () => {
    const msg = orderErrorMessage({
      message: 'order_total_changed',
      details: JSON.stringify({ quoted_cents: 900, lines_cents: 800, message: 'payments total 900 is more than sale total 800' }),
    });
    expect(msg).toMatch(/total/i);
    expect(msg).not.toBe('order_total_changed');
    expect(msg).not.toMatch(/tax/i);
  });

  it('maps order_product_deleted, naming the product from the detail payload', () => {
    const msg = orderErrorMessage({ message: 'order_product_deleted', details: JSON.stringify({ products: 'Rice 5kg' }) });
    expect(msg).toContain('Rice 5kg');
  });

  it('maps order_product_deleted even with no parseable detail', () => {
    const msg = orderErrorMessage({ message: 'order_product_deleted' });
    expect(msg).toMatch(/catalogue/i);
  });

  it('maps order_has_no_items', () => {
    expect(orderErrorMessage({ message: 'order_has_no_items' })).toMatch(/cancel/i);
  });

  // ADDED BY 20260929000250. 20260929000200 files every order line at the
  // agreed price, which puts it behind complete_sale's per-line ceiling for
  // one -- and an order line CAN exceed it, because
  // order_items.line_total_cents is a plain integer. Such an order completed
  // before that branch; untranslated it came back as complete_sale's raw
  // `agreed price for X is out of range: ...`, straight onto the shop's
  // screen through the `default: return null` below.
  it('maps order_line_out_of_range to a sentence, not complete_sale\'s raw English about an agreed price', () => {
    const msg = orderErrorMessage({
      message: 'order_line_out_of_range',
      details: JSON.stringify({
        message: 'agreed price for Generator is out of range: 600000000 x 2 is more than the 1000000000 cents one line may carry',
      }),
    });
    expect(msg).not.toBe('order_line_out_of_range');
    expect(msg).not.toMatch(/agreed price/i);
    expect(msg).toMatch(/line/i);
  });

  it('maps invalid_payment_method', () => {
    expect(orderErrorMessage({ message: 'invalid_payment_method' })).toMatch(/payment method/i);
  });

  // The review's specific instruction: name the likeliest real cause, a
  // completion that committed while the response timed out and a retry that
  // now reads as "already done", so the shop can tell that apart from
  // "failed" and know whether it was paid.
  it('maps invalid_order_transition to a sentence about the order having already moved on', () => {
    const msg = orderErrorMessage({
      message: 'invalid_order_transition',
      details: JSON.stringify({ from: 'ready', to: 'completed' }),
    });
    expect(msg).not.toBe('invalid_order_transition');
    expect(msg).toMatch(/already/i);
  });

  it('maps cancellation_reason_required', () => {
    expect(orderErrorMessage({ message: 'cancellation_reason_required' })).toMatch(/reason/i);
  });

  // B2's server-side half: 20260928000600's typed refusal, mapped to a
  // sentence that tells a settings-only manager who to ask.
  it('maps pos_access_required to a sentence naming what to do about it', () => {
    const msg = orderErrorMessage({ message: 'pos_access_required' });
    expect(msg).toMatch(/pos access/i);
    expect(msg).toMatch(/owner|manager/i);
  });

  // module_not_included is deliberately NOT handled here -- describePlanError
  // (entitlements.ts) already owns it, and runAction chains this after that
  // call. A second mapping here would just drift from the first.
  it('returns null for module_not_included -- that belongs to describePlanError, not this function', () => {
    expect(orderErrorMessage({ message: 'module_not_included', details: JSON.stringify({ module: 'storefront' }) })).toBeNull();
  });

  it('falls back gracefully when details is present but not valid JSON', () => {
    const msg = orderErrorMessage({ message: 'order_product_deleted', details: 'not json' });
    expect(msg).toMatch(/catalogue/i);
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

// ── Flyers (Task 5) ─────────────────────────────────────────────────────
//
// The five-per-shop limit itself is a database trigger (20260930000000) and
// is proved against a real database in verify-storefront-flyers.sql check 7.
// What belongs here is only that these are thin, faithful wrappers around the
// table -- the right columns, the right order -- and that the trigger's
// refusal is turned into a sentence rather than passed through as the raw
// token this repo has shipped to users before.

describe('listFlyers', () => {
  it("reads a shop's flyers in the order a customer will see them, mapping every column", async () => {
    fake.selectResult = {
      data: [
        {
          id: 'f1',
          image_path: 'shop-1/storefront-flyer-1.jpg',
          headline: '20% off all solar',
          subline: 'This week only.',
          link_kind: 'category',
          link_value: 'Solar',
          position: 0,
          draft: false,
          promotion_id: 'promo-solar',
        },
      ],
      error: null,
    };
    const flyers = await listFlyers('shop-1');
    expect(fake.selectCalls).toEqual([
      { table: 'storefront_flyers', columns: 'id, image_path, headline, subline, link_kind, link_value, position, draft, promotion_id' },
    ]);
    expect(fake.eqCalls).toEqual([['shop_id', 'shop-1']]);
    expect(fake.orderCalls).toEqual([['position', { ascending: true }]]);
    expect(flyers).toEqual([
      {
        id: 'f1',
        imagePath: 'shop-1/storefront-flyer-1.jpg',
        headline: '20% off all solar',
        subline: 'This week only.',
        linkKind: 'category',
        linkValue: 'Solar',
        position: 0,
        draft: false,
        promotionId: 'promo-solar',
      },
    ]);
  });

  it('throws on failure rather than showing a shop an empty list of flyers it actually has', async () => {
    fake.selectResult = { data: null, error: { message: 'boom' } };
    await expect(listFlyers('shop-1')).rejects.toEqual({ message: 'boom' });
  });
});

describe('createFlyer', () => {
  it('inserts the flyer under the shop, in snake_case, at the position it was given', async () => {
    await createFlyer('shop-1', {
      imagePath: 'shop-1/storefront-flyer-1.jpg',
      headline: 'Ciid wanaagsan',
      subline: null,
      linkKind: 'none',
      linkValue: null,
      position: 2,
      draft: true,
      promotionId: null,
    });
    expect(fake.insertCalls).toEqual([
      {
        table: 'storefront_flyers',
        payload: {
          shop_id: 'shop-1',
          image_path: 'shop-1/storefront-flyer-1.jpg',
          headline: 'Ciid wanaagsan',
          subline: null,
          link_kind: 'none',
          link_value: null,
          position: 2,
          draft: true,
          promotion_id: null,
        },
      },
    ]);
  });

  it('throws the trigger error rather than swallowing it, so the caller can say what happened', async () => {
    fake.insertResult = { error: { message: 'flyer_limit_reached' } };
    await expect(
      createFlyer('shop-1', {
        imagePath: 'x',
        headline: null,
        subline: null,
        linkKind: 'none',
        linkValue: null,
        position: 5,
        draft: false,
        promotionId: null,
      })
    ).rejects.toEqual({ message: 'flyer_limit_reached' });
  });
});

describe('updateFlyer', () => {
  it('writes only the fields it was handed, so an edit to the headline cannot blank the image', async () => {
    await updateFlyer('f1', { headline: 'New words', draft: false });
    expect(fake.updateCalls).toEqual([{ table: 'storefront_flyers', payload: { headline: 'New words', draft: false } }]);
    expect(fake.eqCalls).toEqual([['id', 'f1']]);
  });

  it('carries an explicitly cleared field through as null rather than dropping it', async () => {
    await updateFlyer('f1', { promotionId: null, subline: null });
    expect(fake.updateCalls).toEqual([{ table: 'storefront_flyers', payload: { promotion_id: null, subline: null } }]);
  });

  it('throws on failure rather than swallowing it', async () => {
    fake.updateResult = { error: { message: 'boom' } };
    await expect(updateFlyer('f1', { headline: 'x' })).rejects.toEqual({ message: 'boom' });
  });
});

describe('deleteFlyer', () => {
  it('deletes the one row by id', async () => {
    await deleteFlyer('f1');
    expect(fake.deleteCalls).toEqual(['storefront_flyers']);
    expect(fake.eqCalls).toEqual([['id', 'f1']]);
  });

  it('throws on failure rather than letting a row vanish from screen while it still exists', async () => {
    fake.deleteResult = { error: { message: 'boom' } };
    await expect(deleteFlyer('f1')).rejects.toEqual({ message: 'boom' });
  });
});

describe('reorderFlyers', () => {
  it('writes each flyer its index in the order it was given, so the list itself is the truth', async () => {
    await reorderFlyers(['b', 'a', 'c']);
    expect(fake.updateCalls).toEqual([
      { table: 'storefront_flyers', payload: { position: 0 } },
      { table: 'storefront_flyers', payload: { position: 1 } },
      { table: 'storefront_flyers', payload: { position: 2 } },
    ]);
    expect(fake.eqCalls).toEqual([
      ['id', 'b'],
      ['id', 'a'],
      ['id', 'c'],
    ]);
  });

  it('throws on failure rather than leaving the shop looking at an order that never saved', async () => {
    fake.updateResult = { error: { message: 'boom' } };
    await expect(reorderFlyers(['a', 'b'])).rejects.toEqual({ message: 'boom' });
  });
});

// auto_advance is written LIVE, not staged into `draft` -- publish_storefront
// (20260925000200) copies a fixed list of keys out of that column and
// auto_advance is not one of them, so a staged value would never reach the
// live page. Same posture as delivery areas, which the editor already tells
// the shop save straight to the live page.
describe('setAutoAdvance', () => {
  it("writes the column directly rather than staging it in a draft that would never publish it", async () => {
    await setAutoAdvance('shop-1', true);
    expect(fake.updateCalls).toEqual([{ table: 'storefronts', payload: { auto_advance: true } }]);
    expect(fake.eqCalls).toEqual([['shop_id', 'shop-1']]);
    expect(fake.rpcCalls).toEqual([]);
  });

  it('throws on failure rather than swallowing it', async () => {
    fake.updateResult = { error: { message: 'boom' } };
    await expect(setAutoAdvance('shop-1', false)).rejects.toEqual({ message: 'boom' });
  });
});

describe('flyerErrorMessage', () => {
  it("turns the trigger's flyer_limit_reached into a sentence naming the cap and the fix", () => {
    const message = flyerErrorMessage({
      message: 'flyer_limit_reached',
      details: JSON.stringify({ resource: 'storefront_flyers', limit: 5, usage: 5 }),
    });
    expect(message).not.toBeNull();
    expect(message).not.toContain('flyer_limit_reached');
    expect(message).toContain('5');
    expect(message).toMatch(/remove one/i);
  });

  it("reads the cap out of the refusal rather than assuming this build's own number", () => {
    expect(flyerErrorMessage({ message: 'flyer_limit_reached', details: JSON.stringify({ limit: 3, usage: 3 }) })).toContain('3');
  });

  it('still says something useful when the refusal carries no detail at all', () => {
    const message = flyerErrorMessage({ message: 'flyer_limit_reached' });
    expect(message).toMatch(/remove one/i);
    expect(message).toContain(String(FLYER_LIMIT));
  });

  it('returns null for anything else, so a caller keeps its own error path for a real failure', () => {
    expect(flyerErrorMessage(new Error('network request failed'))).toBeNull();
    expect(flyerErrorMessage({ message: 'module_not_included' })).toBeNull();
    expect(flyerErrorMessage(null)).toBeNull();
  });
});

// ── amendOrder ──────────────────────────────────────────────────────────
//
// The RPC's argument NAMES are the contract, not their order: PostgREST calls
// by name, and a renamed one is a silent no-op that falls back to the SQL
// default. p_pricing defaulting to 'agreed' server-side is the reason that
// matters here more than usual -- a dropped p_pricing does not fail, it
// quietly charges the customer the agreed price when the shop asked for
// today's.
const AMENDED_ROW = {
  id: 'order-1',
  number: 7,
  customer_name: 'Hodan',
  customer_phone: '+252634300001',
  fulfilment: 'collect',
  delivery_area: null,
  delivery_landmark: null,
  note: null,
  status: 'pending',
  cancellation_reason: null,
  subtotal_cents: 7500,
  delivery_fee_cents: 0,
  total_cents: 7500,
  sale_id: null,
  created_at: '2026-08-30T09:00:00Z',
};

describe('amendOrder', () => {
  it('calls amend_order with the argument names the function declares', async () => {
    fake.rpcResult = { data: AMENDED_ROW, error: null };
    await amendOrder('order-1', [{ productId: 'prod-1', quantity: 3 }], 'only three bags on the shelf');
    expect(fake.rpcCalls).toEqual([
      [
        'amend_order',
        {
          p_order_id: 'order-1',
          p_lines: [{ product_id: 'prod-1', quantity: 3 }],
          p_reason: 'only three bags on the shelf',
        },
      ],
    ]);
  });

  it('omits every optional argument it was not given, so the SQL defaults stay the single source of them', async () => {
    fake.rpcResult = { data: AMENDED_ROW, error: null };
    await amendOrder('order-1', [{ productId: 'prod-1', quantity: 3 }], 'reason');
    const params = fake.rpcCalls[0][1] as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(['p_lines', 'p_order_id', 'p_reason']);
  });

  it('sends the pricing mode, the customer note, the fulfilment and the contact when given', async () => {
    fake.rpcResult = { data: AMENDED_ROW, error: null };
    await amendOrder('order-1', [{ productId: 'prod-1', quantity: 2 }], 'short by one', {
      pricing: 'current',
      customerNote: "we'll have the rest Thursday",
      fulfilment: { fulfilment: 'deliver', deliveryArea: 'Xero Awr', deliveryLandmark: 'Blue gate' },
      contact: { customerName: 'Hodan A', customerPhone: '+252634399999' },
    });
    expect(fake.rpcCalls[0][1]).toEqual({
      p_order_id: 'order-1',
      p_lines: [{ product_id: 'prod-1', quantity: 2 }],
      p_reason: 'short by one',
      p_pricing: 'current',
      p_customer_note: "we'll have the rest Thursday",
      p_fulfilment: { fulfilment: 'deliver', delivery_area: 'Xero Awr', delivery_landmark: 'Blue gate' },
      p_contact: { customer_name: 'Hodan A', customer_phone: '+252634399999' },
    });
  });

  it('maps the returned row through the same shape listOrders produces', async () => {
    fake.rpcResult = { data: AMENDED_ROW, error: null };
    const order = await amendOrder('order-1', [{ productId: 'prod-1', quantity: 3 }], 'reason');
    expect(order.id).toBe('order-1');
    expect(order.number).toBe(7);
    expect(order.subtotalCents).toBe(7500);
    expect(order.totalCents).toBe(7500);
    expect(order.status).toBe('pending');
    expect(order.customerName).toBe('Hodan');
  });

  // amend_order returns the orders row alone -- there is no nested
  // order_items on it -- so itemCount cannot come from the response. It comes
  // from the lines that were SENT, which is not a guess: the function rebuilds
  // order_items from exactly that array, drops the zeros, and raises rather
  // than deviating from it. Without this the sheet would render "0 items"
  // straight after a successful amend, so the assertion is against the row's
  // OWN itemCount being wrong, not merely present.
  it('counts the units it just asked for rather than reading the response', async () => {
    fake.rpcResult = { data: AMENDED_ROW, error: null };
    const order = await amendOrder(
      'order-1',
      [
        { productId: 'prod-1', quantity: 3 },
        { productId: 'prod-2', quantity: 0 },
        { productId: 'prod-3', quantity: 4 },
      ],
      'reason'
    );
    // 7, not 0 (the response carries no order_items) and not 2 (a count of
    // surviving lines rather than of units).
    expect(order.itemCount).toBe(7);
  });

  it('throws when the RPC refuses, so the caller can translate the code', async () => {
    fake.rpcResult = { data: null, error: { message: 'order_not_amendable' } };
    await expect(amendOrder('order-1', [{ productId: 'prod-1', quantity: 1 }], 'reason')).rejects.toMatchObject({
      message: 'order_not_amendable',
    });
  });
});

describe('orderErrorMessage — the amend refusals', () => {
  it('maps amendment_reason_required to a sentence naming the field, not the code', () => {
    const msg = orderErrorMessage({ message: 'amendment_reason_required' });
    expect(msg).not.toBe('amendment_reason_required');
    expect(msg).toMatch(/reason/i);
  });

  // ASSERTED AGAINST THE FALLBACK, not against the word "completed". The
  // no-detail sentence necessarily says "completed or cancelled" itself, so
  // `toMatch(/completed/i)` passed even with the status lookup stubbed out to
  // null -- found by mutation. What actually distinguishes the branches is the
  // NEXT MOVE each one names, so that is what these assert.
  it('maps order_not_amendable for a completed order to the sale-side remedy', () => {
    const msg = orderErrorMessage({
      message: 'order_not_amendable',
      details: JSON.stringify({ status: 'completed' }),
    });
    const generic = orderErrorMessage({ message: 'order_not_amendable' });
    expect(msg).toMatch(/transactions|refund/i);
    expect(msg).not.toBe(generic);
    expect(msg).not.toBe('order_not_amendable');
  });

  it('maps order_not_amendable for a cancelled order to a different remedy again', () => {
    const cancelled = orderErrorMessage({
      message: 'order_not_amendable',
      details: JSON.stringify({ status: 'cancelled' }),
    });
    const completed = orderErrorMessage({
      message: 'order_not_amendable',
      details: JSON.stringify({ status: 'completed' }),
    });
    expect(cancelled).toMatch(/new one|place a new/i);
    expect(cancelled).not.toBe(completed);
  });

  it('maps order_not_amendable with no parseable detail', () => {
    expect(orderErrorMessage({ message: 'order_not_amendable' })).toMatch(/can't be changed|cannot be changed/i);
  });

  // The permission sentence must name what to ask for. A shopkeeper who reads
  // "you don't have permission" and nothing else has to guess which one.
  it('maps sales_edit_required to a sentence naming the permission to ask for', () => {
    const msg = orderErrorMessage({ message: 'sales_edit_required' });
    expect(msg).toMatch(/permission|owner|manager/i);
    expect(msg).not.toBe('sales_edit_required');
  });

  it('maps order_line_not_in_order to the reason adding is refused, naming no code', () => {
    const msg = orderErrorMessage({ message: 'order_line_not_in_order' });
    expect(msg).toMatch(/add/i);
    expect(msg).not.toBe('order_line_not_in_order');
  });

  it('maps invalid_contact to a sentence about the phone number', () => {
    const msg = orderErrorMessage({ message: 'invalid_contact' });
    expect(msg).toMatch(/phone|number/i);
  });

  it('maps unknown_delivery_area and delivery_unavailable to different, actionable sentences', () => {
    const unknown = orderErrorMessage({ message: 'unknown_delivery_area', details: JSON.stringify({ area: 'Atlantis' }) });
    const unavailable = orderErrorMessage({ message: 'delivery_unavailable' });
    expect(unknown).toMatch(/area/i);
    expect(unavailable).toMatch(/delivery/i);
    expect(unknown).not.toBe(unavailable);
  });

  it('maps order_total_out_of_range to a size sentence, distinct from the per-line one', () => {
    const total = orderErrorMessage({ message: 'order_total_out_of_range' });
    const line = orderErrorMessage({ message: 'order_line_out_of_range' });
    expect(total).toMatch(/large|big|too/i);
    expect(total).not.toBe(line);
  });

  // These four are programming errors -- the sheet cannot produce them -- and
  // they stay unmapped ON PURPOSE, per this function's own header: a code it
  // does not recognise must reach the caller's fallback intact rather than be
  // swallowed into a sentence that tells a shopkeeper they did something
  // wrong when the app did.
  it('leaves the client-bug codes unmapped so they surface in a bug report', () => {
    expect(orderErrorMessage({ message: 'invalid_lines' })).toBeNull();
    expect(orderErrorMessage({ message: 'invalid_quantity' })).toBeNull();
    expect(orderErrorMessage({ message: 'duplicate_line' })).toBeNull();
    expect(orderErrorMessage({ message: 'invalid_pricing' })).toBeNull();
  });
});

// The amend sheet's pricing choice needs today's shelf price per line, which
// the order's own snapshot cannot answer. Read as its own small query rather
// than widened onto getOrderItems: an order that is never amended must not
// pay for it.
describe('getCurrentPrices', () => {
  it('reads price_cents for exactly the products asked about', async () => {
    fake.selectResult = { data: [{ id: 'p1', price_cents: 1500 }, { id: 'p2', price_cents: 1000 }], error: null };
    expect(await getCurrentPrices(['p1', 'p2'])).toEqual({ p1: 1500, p2: 1000 });
    expect(fake.selectCalls).toEqual([{ table: 'products', columns: 'id, price_cents', options: undefined }]);
    expect(fake.inCalls).toEqual([['id', ['p1', 'p2']]]);
  });

  it('asks nothing at all for an empty list', async () => {
    expect(await getCurrentPrices([])).toEqual({});
    expect(fake.selectCalls).toEqual([]);
  });

  // A missing product is an ABSENT key, never a zero: order-amendment.ts
  // treats absent as "cannot re-price this" and zero as "free".
  it('leaves a product it got no row for out of the map entirely', async () => {
    fake.selectResult = { data: [{ id: 'p1', price_cents: 1500 }], error: null };
    const prices = await getCurrentPrices(['p1', 'p2']);
    expect(prices).toEqual({ p1: 1500 });
    expect('p2' in prices).toBe(false);
  });

  it('throws rather than answering with a partial map', async () => {
    fake.selectResult = { data: null, error: { message: 'nope' } };
    await expect(getCurrentPrices(['p1'])).rejects.toEqual({ message: 'nope' });
  });
});
