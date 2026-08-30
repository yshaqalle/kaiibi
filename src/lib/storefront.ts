import { publicImageUrl } from '@/lib/storage';
import { DEFAULT_PALETTE, DEFAULT_THEME } from '@/lib/storefront-catalog';
import { supabase } from '@/lib/supabase';
import { whatsappLink } from '@/lib/whatsapp';
import type {
  PublicDeliveryArea, PublicStorefront, StorefrontFlyer, StorefrontFlyerLinkKind,
  StorefrontFlyerOffer, StorefrontProduct,
} from '@/types/models';

// Reads the public page. Every one of these calls the RPCs in
// 20260924000100 rather than querying tables: the column list lives in the
// function, so no client -- including a future one written in a hurry -- can
// widen it into products.cost_cents.

const LINK_KINDS: StorefrontFlyerLinkKind[] = ['none', 'category', 'whatsapp'];

// `link_kind` is CHECK-constrained to exactly these three
// (20260930000000_storefront_flyers.sql), so an unknown value should be
// impossible. Falling back anyway is the same one line `theme` and `palette`
// already get above, for the same reason: a slide that quietly goes nowhere
// beats a slide wired to a branch no renderer has.
function linkKindOf(value: unknown): StorefrontFlyerLinkKind {
  return LINK_KINDS.includes(value as StorefrontFlyerLinkKind) ? (value as StorefrontFlyerLinkKind) : 'none';
}

const DISCOUNT_TYPES: StorefrontFlyerOffer['discountType'][] = ['percentage', 'fixed'];
const OFFER_SCOPES: StorefrontFlyerOffer['scope'][] = ['store', 'brand', 'category'];

// The offer arrives as the promotion's RAW FACTS -- six columns, no words
// (20260930000300). JSON null when the flyer names no live promotion: the
// database has already dropped every flyer whose promotion is not currently
// running, so anything that reaches here is an offer the till would honour
// this second.
//
// The words are derived downstream by offerCopyFor (src/lib/poster.ts), the
// same function the printed poster uses. Nothing is reworded on the way past;
// nothing is worded here either.
//
// A row missing the fields, or carrying a discount_type/scope outside the
// CHECK-constrained sets, reads as no offer at all rather than as a claim
// nobody can render -- the same rule linkKindOf follows above, and the same
// reason: a client shipped ahead of its database (the Expo bundle updates
// over the air, migrations do not) must show a flyer with no offer line, not
// throw on a customer's phone.
function offerOf(value: unknown): StorefrontFlyerOffer | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const discountType = raw.discount_type as StorefrontFlyerOffer['discountType'];
  const scope = raw.scope as StorefrontFlyerOffer['scope'];
  if (!DISCOUNT_TYPES.includes(discountType) || !OFFER_SCOPES.includes(scope)) return null;
  if (typeof raw.discount_value !== 'number') return null;
  return {
    discountType,
    discountValue: raw.discount_value,
    scope,
    scopeValue: (raw.scope_value as string) ?? null,
    startsAt: (raw.starts_at as string) ?? null,
    endsAt: (raw.ends_at as string) ?? null,
  };
}

// `flyers` is a jsonb array the RPC already coalesces to '[]', already
// filtered to live flyers, and already ordered (position, created_at, id) --
// see 20260930000100. None of that is re-done here; this is the snake_case
// -> camelCase map every other read in this file performs, plus the one
// thing the database deliberately left to the reader: turning image_path
// into a URL.
//
// The Array.isArray guard is not defensive noise. A client shipped ahead of
// its database -- the Expo bundle updates over the air, migrations do not --
// calls a get_public_storefront with no `flyers` column at all, and must
// render the shop's page with no flyers rather than throw on a customer's
// phone.
function flyersOf(value: unknown): StorefrontFlyer[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    return {
      id: row.id as string,
      imageUrl: publicImageUrl(row.image_path as string | null),
      headline: (row.headline as string) ?? null,
      subline: (row.subline as string) ?? null,
      linkKind: linkKindOf(row.link_kind),
      linkValue: (row.link_value as string) ?? null,
      offer: offerOf(row.offer),
    };
  });
}

export async function getPublicStorefront(slug: string): Promise<PublicStorefront | null> {
  const { data, error } = await supabase.rpc('get_public_storefront', { p_slug: slug });
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  return {
    shopName: row.shop_name,
    city: row.city ?? null,
    slug: row.slug,
    whatsappE164: row.whatsapp_e164 ?? null,
    // This only substitutes on null/undefined -- an unrecognised but present
    // string (the DB should never emit one; this is not where that is
    // guarded against) passes straight through. The real fallback for an
    // unknown key lives at render time, in StorefrontView (theme) and
    // paletteColors (palette).
    theme: row.theme ?? DEFAULT_THEME,
    palette: row.palette ?? DEFAULT_PALETTE,
    headline: row.headline ?? null,
    about: row.about ?? null,
    heroImageUrl: row.hero_image_url ?? null,
    offersDelivery: Boolean(row.offers_delivery),
    // `?? null` and not a bare read, for the same reason autoAdvance below
    // takes Boolean(...): a client shipped ahead of its database calls a
    // get_public_storefront with no `collect_address` column at all
    // (20261010000100), and `undefined` must arrive as null -- the value a
    // shop with no address on file already produces -- rather than as a
    // distinct third state a renderer would have to test for separately.
    //
    // Only null and undefined substitute. An empty string passes straight
    // through untouched, deliberately: the column is nullable and
    // locations-panel.tsx writes `address.trim() || null`, so '' is not a
    // value this path has to launder, and laundering it here would put the
    // decision in two places.
    collectAddress: (row.collect_address as string | null) ?? null,
    // Same `?? null` and for the same two reasons: a client shipped ahead of
    // its database sees no `collect_neighborhood` column at all, and undefined
    // must arrive as the null a shop with a blank field already produces
    // rather than as a third state. '' still passes through untouched --
    // locations-panel.tsx writes `neighborhood.trim() || null`, and
    // collectLocation drops empty parts anyway.
    collectNeighborhood: (row.collect_neighborhood as string | null) ?? null,
    paymentMode: row.payment_mode,
    flyers: flyersOf(row.flyers),
    // Boolean(...), same guard `offersDelivery` uses two lines up: a client
    // shipped ahead of its database calls a get_public_storefront with no
    // `auto_advance` column at all (20260930000200), and undefined must read
    // as "do not move on your own" -- the same off-by-default rule the
    // column itself carries -- rather than as a thrown error.
    autoAdvance: Boolean(row.auto_advance),
  };
}

export async function getPublicStorefrontProducts(slug: string): Promise<StorefrontProduct[]> {
  const { data, error } = await supabase.rpc('get_public_storefront_products', { p_slug: slug });
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? null,
    category: (row.category as string) ?? null,
    priceCents: row.price_cents as number,
    stock: row.stock as number,
    imageUrl: (row.image_url as string) ?? null,
  }));
}

// The first caller of get_public_delivery_areas (20260924000100) -- it has
// had none since plan 1. Checkout (Task 6) needs a shop's own priced areas
// to offer a customer, and this is the read path Task 2's
// place_storefront_order (20260927000000) already assumes exists on the
// write side: it matches a delivery area by the exact name a client sends
// back, and the only place that name can come from is this list.
export async function getPublicDeliveryAreas(slug: string): Promise<PublicDeliveryArea[]> {
  const { data, error } = await supabase.rpc('get_public_delivery_areas', { p_slug: slug });
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    name: row.name as string,
    feeCents: row.fee_cents as number,
  }));
}

// wa.me takes bare digits -- a leading plus produces a chat with nobody. This
// is whatsappLink (@/lib/whatsapp) under the name storefront screens already
// import: `e164` here is expected pre-normalised (a shop's stored
// whatsapp_e164), so the strict-normaliser round trip is a no-op for every
// real caller. The fallback is the ORIGINAL naive implementation, kept for
// byte-for-byte behaviour on the one input class where it would differ --
// something that fails the strict normaliser (not a real E.164 number) --
// rather than silently swapping in a different, empty-looking link.
export function waLink(e164: string, message: string): string {
  return whatsappLink(e164, message) ?? `https://wa.me/${e164.replace(/^\+/, '')}?text=${encodeURIComponent(message)}`;
}
