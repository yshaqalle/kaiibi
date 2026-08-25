import { DEFAULT_PALETTE, DEFAULT_THEME } from '@/lib/storefront-catalog';
import { supabase } from '@/lib/supabase';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

// Reads the public page. Every one of these calls the RPCs in
// 20260924000100 rather than querying tables: the column list lives in the
// function, so no client -- including a future one written in a hurry -- can
// widen it into products.cost_cents.

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
    // An unknown key falls back rather than rendering an unstyled page. The DB
    // constrains these, so this is the second line of defence, not the first.
    theme: row.theme ?? DEFAULT_THEME,
    palette: row.palette ?? DEFAULT_PALETTE,
    headline: row.headline ?? null,
    about: row.about ?? null,
    heroImageUrl: row.hero_image_url ?? null,
    offersDelivery: Boolean(row.offers_delivery),
    paymentMode: row.payment_mode,
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

// wa.me takes bare digits -- a leading plus produces a chat with nobody.
export function waLink(e164: string, message: string): string {
  return `https://wa.me/${e164.replace(/^\+/, '')}?text=${encodeURIComponent(message)}`;
}
