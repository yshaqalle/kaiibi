import type { CheckoutDetails } from '@/components/storefront/checkout-form';
import { formatCents } from '@/lib/currency';
import { openExternalUrl } from '@/lib/external-url';
import { waLink } from '@/lib/storefront';
import { saveCart, type StorefrontCart } from '@/lib/storefront-cart';
import { supabase } from '@/lib/supabase';

// The two functions in this file are the only callers of
// place_storefront_order (supabase/migrations/20260927000000_place_order.sql)
// -- read that file before changing either. It recomputes every price and the
// total from the shop's current `products` rows; the client sends only
// product ids and quantities, never money. So PlacedOrder below is exactly
// the RETURNING shape of that function, and it is the ONLY source of the
// figures shown to the customer -- there is no locally-computed total
// anywhere downstream of placeOrder.
export type OrderLine = {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
};

export type PlacedOrder = {
  number: number;
  status: string;
  paymentMode: string;
  fulfilment: 'collect' | 'deliver';
  deliveryArea: string | null;
  customerPhone: string;
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  items: OrderLine[];
  /**
   * The customer's own link to this order, minted by place_storefront_order
   * (20261016000000) and returned in this same payload -- so the confirmation
   * screen shows it with no second query and no loading state.
   *
   * Null for a response that carried none: an older client, or any path that
   * did not mint one. Callers must render NOTHING in that case rather than a
   * link with `undefined` in it, which is the #108 defect exactly.
   */
  shareToken: string | null;
};

function mapOrder(data: Record<string, unknown>): PlacedOrder {
  const items = ((data.items as Record<string, unknown>[] | null) ?? []).map((line) => ({
    productId: line.product_id as string,
    name: line.name as string,
    unitPriceCents: line.unit_price_cents as number,
    quantity: line.quantity as number,
    lineTotalCents: line.line_total_cents as number,
  }));
  return {
    number: data.number as number,
    status: data.status as string,
    paymentMode: data.payment_mode as string,
    fulfilment: data.fulfilment as 'collect' | 'deliver',
    deliveryArea: (data.delivery_area as string | null) ?? null,
    customerPhone: data.customer_phone as string,
    subtotalCents: data.subtotal_cents as number,
    deliveryFeeCents: data.delivery_fee_cents as number,
    totalCents: data.total_cents as number,
    shareToken: (data.share_token as string | null) ?? null,
    items,
  };
}

// Writes the order. This is the ONE write both checkout buttons share --
// "Place order" calls this directly, and placeOrderViaWhatsApp below calls
// this FIRST and only opens wa.me once it has returned, so an order exists
// whether or not the customer ever sends the WhatsApp message. Nothing here
// computes a price; p_items carries only product id and quantity, exactly
// what the RPC's header says the client is allowed to decide.
export async function placeOrder(
  slug: string,
  cart: StorefrontCart,
  details: CheckoutDetails
): Promise<PlacedOrder> {
  const { data, error } = await supabase.rpc('place_storefront_order', {
    p_slug: slug,
    p_customer: {
      name: details.name,
      phone: details.phone,
      fulfilment: details.fulfilment,
      delivery_area: details.deliveryArea,
      delivery_landmark: details.deliveryLandmark,
      note: details.note,
    },
    p_items: cart.lines.map((line) => ({ product_id: line.productId, quantity: line.quantity })),
  });

  if (error) throw error;

  const order = mapOrder(data as Record<string, unknown>);

  // Reached only once the RPC above has resolved without throwing -- a
  // rejected order (a stale product, a full cart, a rate limit) throws on
  // the line above and this save is never reached, so a failed placement
  // leaves the basket exactly as the customer left it. See property 5: a
  // basket lost to a flaky connection is a lost sale.
  saveCart({ slug, lines: [] });

  return order;
}

function formatOrderLine(line: OrderLine): string {
  return `${line.quantity} x ${line.name} — ${formatCents(line.lineTotalCents)}`;
}

function paymentSentence(order: PlacedOrder): string {
  // storefronts.payment_mode has exactly one permitted value today
  // ('on_collection', see 20260924000000_storefront.sql) -- what differs
  // between orders is WHEN the customer pays, so the sentence branches on
  // `fulfilment` rather than on a payment_mode this file cannot yet vary by.
  const when = order.fulfilment === 'deliver' ? 'on delivery' : 'on collection';
  return `Pay ${formatCents(order.totalCents)} ${when}.`;
}

// Pure and independently testable, per the brief: shop name, order number,
// every line with quantity and price, the delivery line if there is one, the
// total, and how the customer pays. No supabase, no I/O -- the WhatsApp
// message below and any future channel (a printed slip, an SMS) read this
// exact same string, so there is exactly one place that decides what an
// order "looks like" in words.
export function buildOrderMessage(order: PlacedOrder, shopName: string): string {
  const lines = [`Order #${order.number} — ${shopName}`, '', ...order.items.map(formatOrderLine)];

  if (order.fulfilment === 'deliver' && order.deliveryArea) {
    lines.push('', `Delivery (${order.deliveryArea}) — ${formatCents(order.deliveryFeeCents)}`);
  }

  lines.push('', `Total: ${formatCents(order.totalCents)}`, '', paymentSentence(order));
  return lines.join('\n');
}

// The WhatsApp checkout path. Property 2, the sharpest one in the brief: a
// WhatsApp button that only opens a chat produces sales the app cannot see --
// the exact fragmentation the storefront exists to end. So this calls
// placeOrder FIRST and awaits it; only once the order has actually landed
// does it build the message and open wa.me. If the customer's browser blocks
// the popup, or they close the WhatsApp tab without sending anything, the
// order placed above is unaffected -- it already exists, exactly as if
// "Place order" had been pressed instead.
export async function placeOrderViaWhatsApp(
  slug: string,
  cart: StorefrontCart,
  details: CheckoutDetails,
  shopName: string,
  shopWhatsappE164: string
): Promise<PlacedOrder> {
  const order = await placeOrder(slug, cart, details);

  // The order above is the fact that matters -- it is already written and the
  // cart already cleared. Opening wa.me is a convenience on top, not part of
  // that fact, so a failure here (openExternalUrl does synchronous DOM work
  // on web -- document.createElement, a.click() -- that a Trusted-Types CSP
  // or a blocked popup can make throw) must never surface as a rejected
  // promise. A caller awaiting this must not be able to mistake "the chat
  // didn't open" for "the order failed": the order already exists either way.
  try {
    const message = buildOrderMessage(order, shopName);
    openExternalUrl(waLink(shopWhatsappE164, message));
  } catch {
    // Swallowed deliberately -- see comment above.
  }

  return order;
}
