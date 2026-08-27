// '@/lib/supabase' constructs the real client at module load and throws
// without EXPO_PUBLIC_SUPABASE_* env vars -- same convention support.test.ts
// documents (src/lib/__tests__/support.test.ts:1-5). checkOrderFulfilment
// lives in storefront-admin.ts, which imports the real client, so this file
// needs the mock even though findShortfalls itself is pure.
type FulfilmentFakeState = {
  results: Record<string, { data: unknown; error: unknown }>;
  queries: { table: string; calls: unknown[][] }[];
};

jest.mock('@/lib/supabase', () => {
  const state: FulfilmentFakeState = {
    results: {},
    queries: [],
  };
  const client = {
    from: (table: string) => {
      const record: { table: string; calls: unknown[][] } = { table, calls: [] };
      const defaultResult = { data: table === 'shop_locations' ? null : [], error: null };
      const chain = {
        select: (columns: string) => {
          record.calls.push(['select', columns]);
          return chain;
        },
        eq: (column: string, value: unknown) => {
          record.calls.push(['eq', column, value]);
          return chain;
        },
        in: (column: string, value: unknown) => {
          record.calls.push(['in', column, value]);
          return chain;
        },
        order: (column: string, opts: unknown) => {
          record.calls.push(['order', column, opts]);
          return chain;
        },
        limit: (n: number) => {
          record.calls.push(['limit', n]);
          return chain;
        },
        maybeSingle: () => {
          state.queries.push(record);
          return Promise.resolve(state.results[table] ?? defaultResult);
        },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          state.queries.push(record);
          return Promise.resolve(state.results[table] ?? defaultResult).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return { supabase: client, __state: state };
});

const { __state: fake } = jest.requireMock('@/lib/supabase') as { __state: FulfilmentFakeState };

import { findShortfalls, type OrderFulfilmentLine } from '@/lib/order-fulfilment';
import { checkOrderFulfilment } from '@/lib/storefront-admin';

beforeEach(() => {
  fake.results = {};
  fake.queries.length = 0;
});

// Property: a shortfall is surfaced, never auto-resolved. findShortfalls is
// the one place that decides what counts as short -- pure and total, so the
// four boundary cases plan 3 needs (satisfiable, short by two, deleted
// product, exactly at the boundary) can be proved without touching a
// database at all.
describe('findShortfalls', () => {
  it('reports nothing for a line the shop can fully satisfy', () => {
    const lines: OrderFulfilmentLine[] = [
      { productId: 'p1', productName: 'Kettle', quantity: 3, available: 5 },
    ];
    expect(findShortfalls(lines)).toEqual([]);
  });

  it('reports a line short by two units, with the exact shortfall', () => {
    const lines: OrderFulfilmentLine[] = [
      { productId: 'p1', productName: 'Kettle', quantity: 5, available: 3 },
    ];
    expect(findShortfalls(lines)).toEqual([
      { productId: 'p1', productName: 'Kettle', quantity: 5, available: 3, shortBy: 2 },
    ]);
  });

  // order_items.product_id is `on delete set null` (20260926000050_orders.sql)
  // -- product_name and quantity are retained, but there is no stock row left
  // to read, so available is 0 and the whole quantity is short.
  it('treats a deleted product as fully unavailable, not as filterable', () => {
    const lines: OrderFulfilmentLine[] = [
      { productId: null, productName: 'Discontinued mug', quantity: 2, available: 0 },
    ];
    expect(findShortfalls(lines)).toEqual([
      { productId: null, productName: 'Discontinued mug', quantity: 2, available: 0, shortBy: 2 },
    ]);
  });

  // The boundary: available exactly equal to quantity must not be flagged
  // (a false alarm) and one unit under must not be missed.
  it('does not flag a line at exactly the available quantity', () => {
    const lines: OrderFulfilmentLine[] = [
      { productId: 'p1', productName: 'Kettle', quantity: 4, available: 4 },
    ];
    expect(findShortfalls(lines)).toEqual([]);
  });

  it('reports only the short lines out of a mixed order, each independently', () => {
    const lines: OrderFulfilmentLine[] = [
      { productId: 'ok', productName: 'Fine', quantity: 2, available: 10 },
      { productId: 'short', productName: 'Short', quantity: 5, available: 3 },
      { productId: null, productName: 'Gone', quantity: 1, available: 0 },
      { productId: 'boundary', productName: 'Boundary', quantity: 4, available: 4 },
    ];
    expect(findShortfalls(lines)).toEqual([
      { productId: 'short', productName: 'Short', quantity: 5, available: 3, shortBy: 2 },
      { productId: null, productName: 'Gone', quantity: 1, available: 0, shortBy: 1 },
    ]);
  });

  // place_storefront_order never aggregates the cart and order_items carries
  // no unique(order_id, product_id), so one order can carry two lines for
  // the same product. Stock 5, lines of 3 and 4: each line alone is under 5
  // and would slip through a per-line comparison, but complete_sale
  // decrements the SAME stock cumulatively when the order is handed over --
  // 3 and then 4 against a shelf of 5 is short by 2, and the shop must be
  // told that before "accept" is offered, not after hand-over fails.
  it('sums two lines of the same product before comparing to the shared stock figure', () => {
    const lines: OrderFulfilmentLine[] = [
      { productId: 'p1', productName: 'Kettle', quantity: 3, available: 5 },
      { productId: 'p1', productName: 'Kettle', quantity: 4, available: 5 },
    ];
    expect(findShortfalls(lines)).toEqual([
      { productId: 'p1', productName: 'Kettle', quantity: 7, available: 5, shortBy: 2 },
    ]);
  });

  it('does not flag two lines of the same product whose SUM is still within stock', () => {
    const lines: OrderFulfilmentLine[] = [
      { productId: 'p1', productName: 'Kettle', quantity: 2, available: 5 },
      { productId: 'p1', productName: 'Kettle', quantity: 3, available: 5 },
    ];
    expect(findShortfalls(lines)).toEqual([]);
  });

  // Two DIFFERENT deleted products both carry productId: null -- they must
  // not be summed together as though they were the same missing product.
  it('keeps two deleted-product lines separate rather than summing them', () => {
    const lines: OrderFulfilmentLine[] = [
      { productId: null, productName: 'Discontinued mug', quantity: 2, available: 0 },
      { productId: null, productName: 'Discontinued kettle', quantity: 1, available: 0 },
    ];
    expect(findShortfalls(lines)).toEqual([
      { productId: null, productName: 'Discontinued mug', quantity: 2, available: 0, shortBy: 2 },
      { productId: null, productName: 'Discontinued kettle', quantity: 1, available: 0, shortBy: 1 },
    ]);
  });
});

// checkOrderFulfilment is the query layer: resolves the same location
// complete_sale defaults to when none is given (primary first, then oldest --
// 20260908000300_sale_entry_date.sql:182-186), reads product_location_stock
// there (never products.stock, which product_stock_is_derived_trigger
// recomputes -- 20260810000000_stock_by_location.sql:168), and hands the
// comparison to findShortfalls.
describe('checkOrderFulfilment', () => {
  it('resolves the primary location, reads stock there, and reports a satisfiable order as empty', async () => {
    fake.results.shop_locations = { data: { id: 'loc-primary' }, error: null };
    fake.results.order_items = {
      data: [{ product_id: 'p1', product_name: 'Kettle', quantity: 3 }],
      error: null,
    };
    fake.results.product_location_stock = {
      data: [{ product_id: 'p1', stock: 5 }],
      error: null,
    };

    const shortfalls = await checkOrderFulfilment('shop-1', 'order-1');
    expect(shortfalls).toEqual([]);

    const locationQuery = fake.queries.find((q) => q.table === 'shop_locations');
    expect(locationQuery?.calls).toEqual([
      // The columns are primaryLocation's, not this caller's: the same
      // resolution now also answers "which neighbourhood does this shop trade
      // in" for the storefront address, and one query for one rule is the
      // point. What this test pins is the ORDERING -- primary first, then
      // oldest -- which is the part complete_sale must agree with.
      ['select', 'id, neighborhood, city'],
      ['eq', 'shop_id', 'shop-1'],
      ['order', 'is_primary', { ascending: false }],
      ['order', 'created_at', { ascending: true }],
      ['limit', 1],
    ]);

    const stockQuery = fake.queries.find((q) => q.table === 'product_location_stock');
    expect(stockQuery?.calls).toEqual([
      ['select', 'product_id, stock'],
      ['eq', 'location_id', 'loc-primary'],
      ['in', 'product_id', ['p1']],
    ]);
  });

  it('reports a line short by two units against real product_location_stock', async () => {
    fake.results.shop_locations = { data: { id: 'loc-primary' }, error: null };
    fake.results.order_items = {
      data: [{ product_id: 'p1', product_name: 'Kettle', quantity: 5 }],
      error: null,
    };
    fake.results.product_location_stock = {
      data: [{ product_id: 'p1', stock: 3 }],
      error: null,
    };

    const shortfalls = await checkOrderFulfilment('shop-1', 'order-1');
    expect(shortfalls).toEqual([
      { productId: 'p1', productName: 'Kettle', quantity: 5, available: 3, shortBy: 2 },
    ]);
  });

  it('surfaces a deleted product as fully short, and stays readable rather than throwing', async () => {
    fake.results.shop_locations = { data: { id: 'loc-primary' }, error: null };
    fake.results.order_items = {
      data: [{ product_id: null, product_name: 'Discontinued mug', quantity: 2 }],
      error: null,
    };
    // No product_location_stock lookup should even be attempted for a null
    // product_id -- proven by product_location_stock never receiving a
    // query when every line's product is gone.

    const shortfalls = await checkOrderFulfilment('shop-1', 'order-1');
    expect(shortfalls).toEqual([
      { productId: null, productName: 'Discontinued mug', quantity: 2, available: 0, shortBy: 2 },
    ]);
    expect(fake.queries.find((q) => q.table === 'product_location_stock')).toBeUndefined();
  });

  it('does not flag a line sitting at exactly the available quantity', async () => {
    fake.results.shop_locations = { data: { id: 'loc-primary' }, error: null };
    fake.results.order_items = {
      data: [{ product_id: 'p1', product_name: 'Kettle', quantity: 4 }],
      error: null,
    };
    fake.results.product_location_stock = {
      data: [{ product_id: 'p1', stock: 4 }],
      error: null,
    };

    const shortfalls = await checkOrderFulfilment('shop-1', 'order-1');
    expect(shortfalls).toEqual([]);
  });

  it('throws when the shop has no location to check stock against', async () => {
    fake.results.shop_locations = { data: null, error: null };
    fake.results.order_items = { data: [{ product_id: 'p1', product_name: 'Kettle', quantity: 1 }], error: null };
    await expect(checkOrderFulfilment('shop-1', 'order-1')).rejects.toThrow(/no location/);
  });

  it('throws the query error rather than swallowing it', async () => {
    fake.results.shop_locations = { data: { id: 'loc-primary' }, error: null };
    fake.results.order_items = { data: null, error: { message: 'boom' } };
    await expect(checkOrderFulfilment('shop-1', 'order-1')).rejects.toEqual({ message: 'boom' });
  });

  // The end-to-end shape of the aggregation bug: two order_items rows naming
  // the same product (place_storefront_order never aggregates the cart), a
  // shelf of 5, lines of 3 and 4. A per-line comparison passes both; the
  // real shortfall of 2 only shows up once the lines are summed first.
  it('sums two order_items rows for the same product before comparing to stock', async () => {
    fake.results.shop_locations = { data: { id: 'loc-primary' }, error: null };
    fake.results.order_items = {
      data: [
        { product_id: 'p1', product_name: 'Kettle', quantity: 3 },
        { product_id: 'p1', product_name: 'Kettle', quantity: 4 },
      ],
      error: null,
    };
    fake.results.product_location_stock = {
      data: [{ product_id: 'p1', stock: 5 }],
      error: null,
    };

    const shortfalls = await checkOrderFulfilment('shop-1', 'order-1');
    expect(shortfalls).toEqual([
      { productId: 'p1', productName: 'Kettle', quantity: 7, available: 5, shortBy: 2 },
    ]);
  });
});
