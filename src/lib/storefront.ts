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

// The offer arrives as a jsonb object built by promotion_offer_copy, or JSON
// null when the flyer names no live promotion. Its three strings are printed
// verbatim by the themes -- nothing here rewords them, because the whole
// point of deriving them in SQL is that the page, the paper poster and the
// till say one thing.
function offerOf(value: unknown): StorefrontFlyerOffer | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.value !== 'string' || typeof raw.scope !== 'string') return null;
  return { value: raw.value, scope: raw.scope, when: (raw.when as string) ?? null };
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
    paymentMode: row.payment_mode,
    flyers: flyersOf(row.flyers),
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
