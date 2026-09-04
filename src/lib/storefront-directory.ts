import { publicImageUrl } from '@/lib/storage';
import type { OpeningHours } from '@/lib/store-hours';
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
    openingHours: (row.opening_hours as OpeningHours | null) ?? {},
    // Same rule as `highlights` on the shop page: anything that is not an
    // array reads as none, so a client ahead of its database renders no chips
    // rather than throwing on `.map`.
    categories: Array.isArray(row.categories) ? (row.categories as string[]).filter(Boolean) : [],
    productCount: Number(row.product_count ?? 0),
  };
}

// The most this reads in one call, and the RPC's own clamp ceiling. Past this
// the directory is silently partial -- the chips, the search and the featured
// pick all reason over what was fetched, not over what exists -- so this is the
// number to change when pagination arrives, and the number to keep the SQL's
// `least(greatest(...), 100)` in step with.
export const DIRECTORY_PAGE_SIZE = 100;

export async function listPublicShops(city?: string | null): Promise<PublicShopSummary[]> {
  // `p_city: null` rather than omitting the argument: the function defaults it
  // to null anyway, but passing it explicitly means a trimmed-to-empty filter
  // ("   ") reads as "every city" here rather than as a city no shop is in.
  const wanted = city?.trim() ? city.trim() : null;
  // `p_limit` PASSED, not left to the function's default. The default is 60 and
  // the clamp ceiling is 100 -- so leaving it out quietly capped the directory
  // at 60 while this file's own comments (and the chips, and the search) all
  // reasoned about 100. Asking for the ceiling makes the number the comments
  // describe the number the caller actually gets.
  //
  // DIRECTORY_PAGE_SIZE is that ceiling by name, so the day this needs
  // pagination there is one constant to find rather than a literal to hunt.
  const { data, error } = await supabase.rpc('list_public_storefronts', {
    p_city: wanted,
    p_limit: DIRECTORY_PAGE_SIZE,
  });
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

// SEARCH, and it runs in memory for the same reason the city chips do: the
// whole directory is one bounded read, so filtering here is instant and cannot
// fail. There is no p_query on the RPC and deliberately so -- a server-side
// search over 100 rows would be a round trip and a spinner to do what a
// `filter` does in a frame.
//
// Matches the shop's NAME, its CITY and its BLURB, because a customer types
// what they want ("solar", "pharmacy") as readily as who they want. It does not
// match product names: the directory read carries no products, and pretending
// otherwise would silently return nothing for the most obvious query of all.
// That is the honest limit of this control until there is a search RPC behind
// it -- see the placeholder copy, which says "shops" and not "items".
export function searchShops(shops: PublicShopSummary[], query: string): PublicShopSummary[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return shops;
  // Every whitespace-separated word must match somewhere, so "borama grocer"
  // finds Baraka Grocers in Borama -- an AND across words rather than one
  // substring, which would fail the moment somebody types two of the three
  // things they know about a shop.
  const words = wanted.split(/\s+/);
  return shops.filter((shop) => {
    const haystack = [shop.shopName, shop.city ?? '', shopBlurb(shop) ?? ''].join(' ').toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

// The category chips, derived from the rows exactly as the city chips are and
// for the same reason: they cannot offer a filter the grid below them cannot
// fill, because they are built from that grid.
//
// A shop in two categories contributes to both, so tapping either finds it.
export function categoriesOf(shops: PublicShopSummary[]): string[] {
  const seen = new Map<string, string>();
  for (const shop of shops) {
    for (const raw of shop.categories) {
      const name = raw.trim();
      if (!name) continue;
      // Case-folded key, first spelling wins -- citiesOf's rule, for the same
      // reason: two shops that typed "Grocery" and "grocery" are one chip.
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, name);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export function inCategory(shops: PublicShopSummary[], category: string | null): PublicShopSummary[] {
  if (!category) return shops;
  const wanted = category.trim().toLowerCase();
  return shops.filter((shop) => shop.categories.some((c) => c.trim().toLowerCase() === wanted));
}
