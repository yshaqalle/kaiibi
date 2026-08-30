import { supabase } from '@/lib/supabase';
import type { OrderStatus } from '@/lib/storefront-admin';

// What a customer holding a link may see, and the one thing they may do.
//
// ITS OWN MODULE, not part of storefront-admin.ts, and that is a boundary
// rather than filing. Every function in that module assumes a signed-in shop
// member and reaches for a shop id; these two are called with NO SESSION AT
// ALL. Mixing them invites a future edit to pull a shop-scoped helper onto
// the customer's page, which is precisely the leak get_public_order's own
// header spends its length refusing.
//
// The projection is decided in SQL (20261017000000), not here. This file maps
// keys and nothing else -- it never widens what came back, and it cannot,
// because what came back is already the whole of what a customer may have.

export type PublicOrderLine = {
  productName: string;
  quantity: number;
  lineTotalCents: number;
};

export type PublicOrderAmendment = {
  /** The only prose a customer is ever shown. Never the internal reason. */
  customerNote: string | null;
  wasCents: number;
  nowCents: number;
  before: PublicOrderLine[];
  after: PublicOrderLine[];
};

export type PublicOrder = {
  shopName: string;
  /**
   * The shop's own WhatsApp number, so "something is wrong" reaches THEM.
   * Null for a shop that has not set one -- the caller must then not offer a
   * button that opens an empty chat.
   */
  shopWhatsapp: string | null;
  number: number;
  status: OrderStatus;
  placedAt: string;
  fulfilment: 'collect' | 'deliver';
  /**
   * Where the customer actually has to go: their own landmark on a delivery,
   * the shop's address on a collection. Null when neither exists -- render
   * nothing rather than an empty line.
   */
  whereToGo: string | null;
  lines: PublicOrderLine[];
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  /** Non-null once the customer has agreed to an amendment. */
  confirmedAt: string | null;
  /** Null when the order has never been amended. */
  amendment: PublicOrderAmendment | null;
};

type LineRow = { product_name: string; quantity: number; line_total_cents: number };
type OrderRow = {
  shop_name: string;
  shop_whatsapp: string | null;
  number: number;
  status: string;
  placed_at: string;
  fulfilment: string;
  where_to_go: string | null;
  lines: LineRow[] | null;
  subtotal_cents: number;
  delivery_fee_cents: number;
  total_cents: number;
  confirmed_at: string | null;
  amendment: {
    customer_note: string | null;
    was_cents: number;
    now_cents: number;
    before: LineRow[] | null;
    after: LineRow[] | null;
  } | null;
};

const mapLine = (row: LineRow): PublicOrderLine => ({
  productName: row.product_name,
  quantity: row.quantity,
  lineTotalCents: row.line_total_cents,
});

function mapOrder(row: OrderRow): PublicOrder {
  return {
    shopName: row.shop_name,
    shopWhatsapp: row.shop_whatsapp ?? null,
    number: row.number,
    status: row.status as OrderStatus,
    placedAt: row.placed_at,
    fulfilment: row.fulfilment as 'collect' | 'deliver',
    whereToGo: row.where_to_go ?? null,
    lines: (row.lines ?? []).map(mapLine),
    subtotalCents: row.subtotal_cents,
    deliveryFeeCents: row.delivery_fee_cents,
    totalCents: row.total_cents,
    confirmedAt: row.confirmed_at ?? null,
    amendment: row.amendment
      ? {
          customerNote: row.amendment.customer_note ?? null,
          wasCents: row.amendment.was_cents,
          nowCents: row.amendment.now_cents,
          before: (row.amendment.before ?? []).map(mapLine),
          after: (row.amendment.after ?? []).map(mapLine),
        }
      : null,
  };
}

/**
 * Read an order from its share token.
 *
 * Returns null when the server did not recognise the token -- which covers an
 * unknown one, an expired one and a typo, deliberately indistinguishably. A
 * REQUEST failure throws instead, because "this link is not valid" and "your
 * connection dropped" are different things to tell a customer.
 */
export async function getPublicOrder(token: string): Promise<PublicOrder | null> {
  // No round trip for an empty path segment: the answer is already known, and
  // asking would put an empty token in the server's logs.
  if (!token || token.trim() === '') return null;

  const { data, error } = await supabase.rpc('get_public_order', { p_token: token });
  if (error) throw error;
  if (!data) return null;
  return mapOrder(data as OrderRow);
}

/**
 * Agree to the order as it now stands.
 *
 * The ONLY write on this surface, and it can do nothing but stamp the
 * agreement -- see confirm_public_order's own header for why that asymmetry
 * is the whole security argument for the feature. Returns the re-read order
 * (the same projection) so the page can render the result without a second
 * request, or null if the token was not recognised.
 *
 * There is deliberately no counterpart for "something's wrong": that opens
 * WhatsApp and writes nothing at all.
 */
export async function confirmPublicOrder(token: string): Promise<PublicOrder | null> {
  if (!token || token.trim() === '') return null;

  const { data, error } = await supabase.rpc('confirm_public_order', { p_token: token });
  if (error) throw error;
  if (!data) return null;
  return mapOrder(data as OrderRow);
}
