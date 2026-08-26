// Task 3: surfaces what an order asked for against what a shop can actually
// supply right now, before "accept" is offered. Plan 3 deliberately does not
// reserve stock when a customer adds to cart (reserving on add would let
// anyone empty a shop's shelves from a browser with no account), so an order
// can legitimately ask for more than a shop currently holds -- a shop that
// sold its last kettle at the counter this morning will hit this. Without a
// check here, a shop accepts, tells the customer yes, and only discovers it
// cannot fill the order when complete_sale itself refuses the sale
// (20260908000300_sale_entry_date.sql:294-299, "insufficient stock for %").
// This surfaces the same shortage before that promise is made.
//
// A shortfall found here is reported, never resolved: nothing in this file
// reduces a quantity or drops a line. The shop decides whether to source
// more, part-fill, or cancel -- see checkOrderFulfilment in
// storefront-admin.ts for the query layer that feeds this.

export type OrderFulfilmentLine = {
  // Null when order_items.product_id has gone `on delete set null`
  // (20260926000050_orders.sql) -- the product itself no longer exists, but
  // the order line must stay readable, so productName/quantity are the
  // snapshot values the order kept.
  productId: string | null;
  productName: string;
  quantity: number;
  // Stock at the location the sale would be filed against, read from
  // product_location_stock -- the same table complete_sale checks
  // (20260908000300_sale_entry_date.sql:294-299), never products.stock
  // (a column product_stock_is_derived_trigger recomputes and silently
  // reverts direct writes to -- 20260810000000_stock_by_location.sql:168).
  // 0 for a deleted product: there is no stock row left to read.
  available: number;
};

export type OrderShortfall = {
  productId: string | null;
  productName: string;
  quantity: number;
  available: number;
  shortBy: number;
};

// Pure and total: every line the shop cannot fully satisfy right now, each
// annotated with exactly how short it is. A line at or above its ordered
// quantity -- including exactly at it, the boundary this is easiest to get
// wrong at -- is left out entirely: this is a list of problems, not a
// line-by-line report card.
export function findShortfalls(lines: OrderFulfilmentLine[]): OrderShortfall[] {
  const shortfalls: OrderShortfall[] = [];
  for (const line of lines) {
    if (line.available < line.quantity) {
      shortfalls.push({
        productId: line.productId,
        productName: line.productName,
        quantity: line.quantity,
        available: line.available,
        shortBy: line.quantity - line.available,
      });
    }
  }
  return shortfalls;
}
