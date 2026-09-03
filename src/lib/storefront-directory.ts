import { publicImageUrl } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import type { PublicShopSummary } from '@/types/models';

// The directory read. One RPC, no slug -- see
// 20261019000000_a_stranger_can_browse_the_shops.sql for why that is the whole
// point of it and what makes it safe.
//
// Same discipline as storefront.ts: this calls the RPC rather than querying
// tables, so the column list lives in the function and no client can widen it.

// A client shipped ahead of its database is the normal case here -- the Expo
// bundle updates over the air and migrations do not -- so every field is read
// defensively and a missing one becomes the value an empty shop already
// produces, never a third state a renderer would have to test for.
function toSummary(row: Record<string, unknown>): PublicShopSummary {
  return {
    shopName: (row.shop_name as string) ?? '',
    slug: (row.slug as string) ?? '',
    city: (row.city as string | null) ?? null,
    headline: (row.headline as string | null) ?? null,
    about: (row.about as string | null) ?? null,
    // The same bucket path -> URL conversion getPublicStorefront does, in the
    // same place: nothing downstream should need to know which bucket a hero
    // image lives in.
    heroImageUrl: publicImageUrl((row.hero_image_url as string | null) ?? null),
    offersDelivery: Boolean(row.offers_delivery),
    productCount: Number(row.product_count ?? 0),
  };
}

export async function listPublicShops(city?: string | null): Promise<PublicShopSummary[]> {
  // `p_city: null` rather than omitting the argument: the function defaults it
  // to null anyway, but passing it explicitly means a trimmed-to-empty filter
  // ("   ") reads as "every city" here rather than as a city no shop is in.
  const wanted = city?.trim() ? city.trim() : null;
  const { data, error } = await supabase.rpc('list_public_storefronts', { p_city: wanted });
  if (error) throw error;
  return (data ?? []).map(toSummary);
}

// The chips above the grid, derived from the rows rather than fetched.
//
// A second RPC for `select distinct city` would be a second anon function to
// justify, a second round trip, and a list that can disagree with the grid
// under it -- a chip for a city whose only shop unpublished between the two
// calls is a filter that returns nothing. Deriving them cannot drift, because
// there is only one read.
//
// Bounded by the same 100-row cap the RPC clamps to, which is the honest limit
// of this approach: past that, cities stop being complete and this needs its
// own read. Named here so the next person meets the ceiling in a comment
// rather than in a bug report.
export function citiesOf(shops: PublicShopSummary[]): string[] {
  const seen = new Map<string, string>();
  for (const shop of shops) {
    const city = shop.city?.trim();
    if (!city) continue;
    // Keyed case-insensitively so "hargeisa" and "Hargeisa" are one chip, but
    // the FIRST spelling seen is the one shown -- the shops are already sorted
    // by product count then name, so that is a stable choice rather than
    // whichever row the planner returned last.
    const key = city.toLowerCase();
    if (!seen.has(key)) seen.set(key, city);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// What the card prints under the shop name. The headline is what the shop
// wrote to sell itself in one line, so it leads; `about` is the fallback
// because a shop with a story and no headline still has something to say, and
// the card clamps it to two lines anyway. Null when there is neither -- the
// card drops the line rather than printing a placeholder.
export function shopBlurb(shop: PublicShopSummary): string | null {
  return shop.headline?.trim() || shop.about?.trim() || null;
}
