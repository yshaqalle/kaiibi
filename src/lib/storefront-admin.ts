import { toE164 } from '@/lib/phone-e164';
import { DEFAULT_PALETTE, DEFAULT_THEME, type StorefrontPalette, type StorefrontTheme } from '@/lib/storefront-catalog';
import { normalizeSlug, validateSlug, type SlugProblem } from '@/lib/storefront-slug';
import { supabase } from '@/lib/supabase';

// The shop-side counterpart to storefront.ts's public reads: everything a
// shop does to its OWN page -- the editor screen holds layout and state, this
// holds every query. Two tables back one shape here (see 20260924000000's
// reasoning for why slug/whatsapp live on shops and the rest on storefronts),
// so ShopStorefront below is a join, not a table.

export type ShopStorefront = {
  shopId: string;
  slug: string | null;
  whatsappE164: string | null;
  theme: StorefrontTheme;
  palette: StorefrontPalette;
  headline: string | null;
  about: string | null;
  heroImageUrl: string | null;
  offersDelivery: boolean;
  publishedAt: string | null;
};

export type DeliveryArea = { id: string; name: string; feeCents: number; sortOrder: number };

export type PublishBlocker = 'no_slug' | 'no_whatsapp' | 'no_products';

// Pure and total: reports every reason a page can't go live at once, not the
// first one hit. A shop that fixes its slug and is then told about a missing
// WhatsApp number has been made to submit twice for something checkable in
// one pass.
export function publishBlockers(input: {
  slug: string | null;
  whatsappE164: string | null;
  onlineProductCount: number;
}): PublishBlocker[] {
  const blockers: PublishBlocker[] = [];
  if (!input.slug) blockers.push('no_slug');
  if (!input.whatsappE164) blockers.push('no_whatsapp');
  if (input.onlineProductCount <= 0) blockers.push('no_products');
  return blockers;
}

function mapStorefrontRow(
  shop: { id: string; slug: string | null; whatsapp_e164: string | null },
  sf: {
    theme?: string | null;
    palette?: string | null;
    headline?: string | null;
    about?: string | null;
    hero_image_url?: string | null;
    offers_delivery?: boolean | null;
    published_at?: string | null;
  }
): ShopStorefront {
  return {
    shopId: shop.id,
    slug: shop.slug ?? null,
    whatsappE164: shop.whatsapp_e164 ?? null,
    theme: (sf.theme as StorefrontTheme) ?? DEFAULT_THEME,
    palette: (sf.palette as StorefrontPalette) ?? DEFAULT_PALETTE,
    headline: sf.headline ?? null,
    about: sf.about ?? null,
    heroImageUrl: sf.hero_image_url ?? null,
    offersDelivery: Boolean(sf.offers_delivery),
    publishedAt: sf.published_at ?? null,
  };
}

// Null means "this shop has never set up a page" -- distinct from a page that
// exists but is unpublished (publishedAt null on a real row). ensureStorefront
// is what turns the former into the latter.
export async function getMyStorefront(shopId: string): Promise<ShopStorefront | null> {
  const { data, error } = await supabase
    .from('shops')
    .select('id, slug, whatsapp_e164, storefronts(theme, palette, headline, about, hero_image_url, offers_delivery, published_at)')
    .eq('id', shopId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const sf = (data as unknown as { storefronts: Record<string, unknown> | null }).storefronts;
  if (!sf) return null;
  return mapStorefrontRow(data as { id: string; slug: string | null; whatsapp_e164: string | null }, sf);
}

// Inserts the default row (theme/palette/payment_mode all take their column
// defaults) the first time a shop opens the editor. The storefronts_module_gate
// trigger (20260924000000) refuses this on a plan without `storefront`, and
// that error is left to propagate exactly as PostgREST shaped it -- callers
// pass it to describePlanError (entitlements.ts) to turn into an upgrade
// prompt. Wrapping or rewriting it here would break that.
export async function ensureStorefront(shopId: string): Promise<ShopStorefront> {
  const existing = await getMyStorefront(shopId);
  if (existing) return existing;

  const { error } = await supabase.from('storefronts').insert({ shop_id: shopId });
  if (error) throw error;

  const created = await getMyStorefront(shopId);
  if (!created) throw new Error('Storefront row was inserted but could not be read back.');
  return created;
}

// whatsappE164 is re-normalized here (not just typed as the E.164 shape)
// because it is the one field on this patch that a caller may hand over as
// whatever a shopkeeper typed -- toE164 is what turns that into the form the
// `shops_whatsapp_is_e164` CHECK (20260924000000) and the wa.me link both
// require. An unparseable number fails here with a clear message rather than
// as a raw constraint violation from Postgres.
export async function saveStorefront(
  shopId: string,
  patch: Partial<Omit<ShopStorefront, 'shopId' | 'slug' | 'publishedAt'>>
): Promise<void> {
  const shopPatch: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'whatsappE164')) {
    const raw = patch.whatsappE164;
    if (raw == null) {
      shopPatch.whatsapp_e164 = null;
    } else {
      const e164 = toE164(raw);
      if (!e164) throw new Error('invalid_whatsapp');
      shopPatch.whatsapp_e164 = e164;
    }
  }

  const storefrontPatch: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'theme')) storefrontPatch.theme = patch.theme;
  if (Object.prototype.hasOwnProperty.call(patch, 'palette')) storefrontPatch.palette = patch.palette;
  if (Object.prototype.hasOwnProperty.call(patch, 'headline')) storefrontPatch.headline = patch.headline;
  if (Object.prototype.hasOwnProperty.call(patch, 'about')) storefrontPatch.about = patch.about;
  if (Object.prototype.hasOwnProperty.call(patch, 'heroImageUrl')) storefrontPatch.hero_image_url = patch.heroImageUrl;
  if (Object.prototype.hasOwnProperty.call(patch, 'offersDelivery')) storefrontPatch.offers_delivery = patch.offersDelivery;

  if (Object.keys(shopPatch).length > 0) {
    const { error } = await supabase.from('shops').update(shopPatch).eq('id', shopId);
    if (error) throw error;
  }
  if (Object.keys(storefrontPatch).length > 0) {
    const { error } = await supabase.from('storefronts').update(storefrontPatch).eq('shop_id', shopId);
    if (error) throw error;
  }
}

// validateSlug runs before any round trip -- a structurally bad slug (too
// short, a bad character, a reserved name) is answered for free. Only a slug
// that could actually be claimed reaches is_slug_available, which is the only
// thing that knows whether some other shop already holds it.
export async function checkSlug(slug: string): Promise<'available' | 'taken' | SlugProblem> {
  const normalized = normalizeSlug(slug);
  const problem = validateSlug(normalized);
  if (problem) return problem;

  const { data, error } = await supabase.rpc('is_slug_available', { p_slug: normalized });
  if (error) throw error;
  return data ? 'available' : 'taken';
}

// Same client-side guard as checkSlug, so an obviously-bad slug fails fast
// instead of round-tripping into claim_shop_slug's own reserved-name check or,
// worse, the shops_slug_is_a_dns_label CHECK. Beyond that this is thin: the
// RPC (20260925000000_storefront_slug_claim.sql) is the actual authority on
// membership, the storefront module, and the race against another claim, and
// its slug_taken (errcode P0001) is mapped to a typed Error here so callers
// don't have to know the raw Postgres shape. Any other error -- not a member,
// module missing -- is rethrown exactly as received.
export async function claimSlug(shopId: string, slug: string): Promise<string> {
  const normalized = normalizeSlug(slug);
  const problem = validateSlug(normalized);
  if (problem) throw new Error(problem);

  const { data, error } = await supabase.rpc('claim_shop_slug', { p_shop_id: shopId, p_slug: normalized });
  if (error) {
    if ((error as { message?: unknown }).message === 'slug_taken') throw new Error('slug_taken');
    throw error;
  }
  return data as string;
}

function mapDeliveryAreaRow(row: { id: string; name: string; fee_cents: number; sort_order: number }): DeliveryArea {
  return { id: row.id, name: row.name, feeCents: row.fee_cents, sortOrder: row.sort_order };
}

export async function listDeliveryAreas(shopId: string): Promise<DeliveryArea[]> {
  const { data, error } = await supabase
    .from('storefront_delivery_areas')
    .select('id, name, fee_cents, sort_order')
    .eq('shop_id', shopId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapDeliveryAreaRow);
}

// Upsert by id: an `id` present means the editor is renaming/repricing a row
// already on screen, absent means a new area. `storefront_delivery_areas_shop_idx`
// plus the `unique (shop_id, name)` constraint (20260924000000) are what
// actually enforce a shop can't hold two areas with the same name; a
// duplicate name is left to surface as that constraint's error rather than
// pre-checked here.
export async function saveDeliveryArea(
  shopId: string,
  area: { id?: string; name: string; feeCents: number; sortOrder: number }
): Promise<void> {
  const row = { shop_id: shopId, name: area.name, fee_cents: area.feeCents, sort_order: area.sortOrder };
  if (area.id) {
    const { error } = await supabase.from('storefront_delivery_areas').update(row).eq('id', area.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('storefront_delivery_areas').insert(row);
    if (error) throw error;
  }
}

export async function deleteDeliveryArea(id: string): Promise<void> {
  const { error } = await supabase.from('storefront_delivery_areas').delete().eq('id', id);
  if (error) throw error;
}

// The count publishBlockers' onlineProductCount needs, computed straight from
// `products` rather than through get_public_storefront_products: that RPC
// (20260924000100) deliberately returns zero rows for a page with
// published_at is null (a draft shop must read as a nonexistent one, see its
// own comment), which would make "no_products" impossible to ever clear on a
// shop's FIRST publish -- the exact moment this count has to be right.
export async function countOnlineProducts(shopId: string): Promise<number> {
  const { count, error } = await supabase
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('shop_id', shopId)
    .eq('is_listed_online', true);
  if (error) throw error;
  return count ?? 0;
}

// published_at is the draft/live switch itself (20260924000000's comment on
// the column): now() to go live, null to pull the page down without deleting
// anything it shows.
export async function setPublished(shopId: string, published: boolean): Promise<void> {
  const { error } = await supabase
    .from('storefronts')
    .update({ published_at: published ? new Date().toISOString() : null })
    .eq('shop_id', shopId);
  if (error) throw error;
}
