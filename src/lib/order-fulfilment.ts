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
//
// SUMMED PER PRODUCT FIRST. place_storefront_order never aggregates the
// cart (20260927000000_place_order.sql builds one order_items row per cart
// line) and order_items carries no `unique(order_id, product_id)`, so one
// order can legitimately hold two lines for the same product -- an
// impatient customer who tapped "add" twice on two separate visits to the
// product page, say. Each line's `available` is the SAME stock figure (both
// read product_location_stock for the same product/location), so comparing
// them one at a time tests each line against the whole shelf rather than
// against what is left after the other line takes its share: stock 5, lines
// of 3 and 4, both pass individually and the shop is told the order is
// fillable -- then complete_sale, which decrements CUMULATIVELY, runs out on
// the second line and the hand-over fails on an order the shop already told
// the customer "yes" to. Grouping by productId first and comparing the
// GROUP's total is what checkOrderFulfilment's own maths already assumes.
//
// A line whose product has been deleted (productId null) groups on its own,
// never merged with another null line -- there is no shared identity two
// different discontinued products' lines have in common, and summing them
// together would report one invented shortfall for two unrelated products.
export function findShortfalls(lines: OrderFulfilmentLine[]): OrderShortfall[] {
  type Group = { productId: string | null; productName: string; quantity: number; available: number };

  const groups: Group[] = [];
  const byProductId = new Map<string, Group>();

  for (const line of lines) {
    if (line.productId === null) {
      groups.push({ ...line });
      continue;
    }
    const existing = byProductId.get(line.productId);
    if (existing) {
      existing.quantity += line.quantity;
    } else {
      const group: Group = { ...line, productId: line.productId };
      byProductId.set(line.productId, group);
      groups.push(group);
    }
  }

  const shortfalls: OrderShortfall[] = [];
  for (const group of groups) {
    if (group.available < group.quantity) {
      shortfalls.push({
        productId: group.productId,
        productName: group.productName,
        quantity: group.quantity,
        available: group.available,
        shortBy: group.quantity - group.available,
      });
    }
  }
  return shortfalls;
}
