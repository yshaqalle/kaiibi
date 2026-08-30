import { findShortfalls, type OrderShortfall } from '@/lib/order-fulfilment';
import { ORDERS_NEEDING_ACTION } from '@/lib/order-status';
import { DEFAULT_PALETTE, DEFAULT_THEME, type StorefrontPalette, type StorefrontTheme } from '@/lib/storefront-catalog';
import { normalizeSlug, validateSlug, type SlugProblem } from '@/lib/storefront-slug';
import { supabase } from '@/lib/supabase';
import type { StorefrontFlyerLinkKind, StorefrontProduct } from '@/types/models';

// The shop-side counterpart to storefront.ts's public reads: everything a
// shop does to its OWN page -- the editor screen holds layout and state, this
// holds every query. Two tables back one shape here (see 20260924000000's
// reasoning for why slug/whatsapp live on shops and the rest on storefronts),
// so ShopStorefront below is a join, not a table.

// WHY a page the shop did not unpublish is a draft. The 20260930000500 trigger
// takes a page down whenever a shop crosses back out of a dark state, and it
// records WHICH dark state -- because the two are not the same news:
//
//   'lapsed'    -- the plan ran past its grace month. A bill was missed.
//   'suspended' -- an operator suspended the shop. The bill may have been fine;
//                  the shop needs to know a person did this and to reach us.
//
// Kept as a union rather than a boolean so the editor cannot say one of these
// about the other. Mirrors the two values storefronts_lapse_reason_matches_stamp
// permits in the database.
export type LapseReason = 'lapsed' | 'suspended';

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
  // Set once, by publish_storefront's own first publish, and never cleared
  // by unpublish (20260926000100) -- unlike publishedAt, which goes back to
  // null the moment a shop pulls its page down. This is the signal for "has
  // this shop EVER chosen a design", the property DesignStrip's "Chosen for
  // you" badge is required to hold sticky (T3): a shop that has published,
  // even once, has chosen, whatever it chose, and is never told otherwise
  // again just because it later unpublished.
  firstPublishedAt: string | null;
  // WHY the page is a draft, when the reason is not the shop's own doing.
  //
  // Set by the 20260930000500 trigger at the moment a lapsed shop comes back
  // -- pays, is extended, or has its window widened -- because that is when
  // its page is taken down. Once published_at is null nothing else could tell
  // "the plan lapsed and we took it down" apart from "never published" or "the
  // shop pulled it down itself", and the editor would have to leave the shop
  // to guess.
  //
  // Cleared by publish_storefront, so the sentence cannot outlive its cause,
  // and never set for a shop that had nothing published to take down.
  lapseUnpublishedAt: string | null;
  // WHICH of the two dark states took it down -- see LapseReason below. Null
  // exactly when lapseUnpublishedAt is null; the database holds the two
  // together with a check constraint, so this is never a half-record.
  lapseUnpublishedReason: LapseReason | null;
  // Whether the shop has asked the flyer band to move on its own
  // (storefronts.auto_advance, 20260930000200). NOT in EditableFields below
  // and deliberately so: publish_storefront (20260925000200) copies a fixed
  // list of keys out of `draft` and auto_advance is not one of them, so a
  // value staged there would never reach the live column. setAutoAdvance
  // writes it live instead -- the same posture delivery areas already take,
  // and the editor already tells the shop those save straight to the live
  // page.
  autoAdvance: boolean;
  // Unpublished edits, staged server-side (20260925000200_storefront_draft.sql)
  // so a shop that writes its page and taps Back loses nothing. Null means
  // "nothing staged" -- every field the shop has touched but not published is
  // a key here, in the same camelCase shape as EditableFields below (it is
  // NOT a mirror of the table's own snake_case columns). Absent from
  // get_public_storefront by construction: that function selects named live
  // columns and this is never one of them.
  draft: Partial<EditableFields> | null;
};

// The fields a shopkeeper can edit before Publish -- staged into `draft`
// above rather than written to a live column immediately, until Publish
// copies them over (publish_storefront, same migration). `slug` and
// `payment_mode` are deliberately excluded: a slug is claimed immediately
// via claimSlug because it is globally unique and cannot be provisionally
// reserved, and payment_mode has exactly one permitted value today. Lives
// here, not on the editor screen, because it is a shape the data layer
// itself now owns -- `ShopStorefront.draft` is typed against it directly.
export type EditableFields = Pick<
  ShopStorefront,
  'theme' | 'palette' | 'headline' | 'about' | 'heroImageUrl' | 'offersDelivery' | 'whatsappE164'
>;

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
    first_published_at?: string | null;
    lapse_unpublished_at?: string | null;
    lapse_unpublished_reason?: string | null;
    auto_advance?: boolean | null;
    draft?: Record<string, unknown> | null;
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
    firstPublishedAt: sf.first_published_at ?? null,
    lapseUnpublishedAt: sf.lapse_unpublished_at ?? null,
    // Narrowed rather than cast: the column is `text` on the wire, and a value
    // outside the union would have to render as SOMETHING on screen. Anything
    // unrecognised reads as "no explanation available", which shows the draft
    // with no sentence -- the old behaviour -- instead of a wrong sentence.
    lapseUnpublishedReason:
      sf.lapse_unpublished_reason === 'lapsed' || sf.lapse_unpublished_reason === 'suspended'
        ? sf.lapse_unpublished_reason
        : null,
    autoAdvance: Boolean(sf.auto_advance),
    draft: (sf.draft as Partial<EditableFields> | null) ?? null,
  };
}

// Null means "this shop has never set up a page" -- distinct from a page that
// exists but is unpublished (publishedAt null on a real row). ensureStorefront
// is what turns the former into the latter.
export async function getMyStorefront(shopId: string): Promise<ShopStorefront | null> {
  const { data, error } = await supabase
    .from('shops')
    .select(
      'id, slug, whatsapp_e164, storefronts(theme, palette, headline, about, hero_image_url, offers_delivery, published_at, first_published_at, lapse_unpublished_at, lapse_unpublished_reason, auto_advance, draft)'
    )
    .eq('id', shopId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const sf = (data as unknown as { storefronts: Record<string, unknown> | null }).storefronts;
  if (!sf) return null;
  return mapStorefrontRow(data as { id: string; slug: string | null; whatsapp_e164: string | null }, sf);
}

// Does a `storefronts` row exist for this shop? The nav's whole question about
// a lapsed page (use-storefront-nav.ts), asked as a count rather than a read.
//
// This used to be `getMyStorefront(shopId) !== null`, which is the EDITOR's
// query: every live column plus `draft`, the jsonb holding a shop's entire
// unsaved page. `head: true` skips the row payload altogether -- PostgREST
// answers in Content-Range and sends no body -- so the nav's one question
// costs a number instead of a page. Same reasoning N3 applied to
// countOrdersNeedingAction below, one caller further up.
//
// Deliberately NOT `count > 0` on a broader read: `shop_id` is the primary key
// of `storefronts` (20260924000000), so this is at most one row and the count
// is 0 or 1. RLS (storefronts_member_all) is what narrows it to the caller's
// own shop; the `eq` is what makes the QUERY itself scoped rather than leaning
// on that alone, the same posture listOrders takes.
export async function shopHasStorefront(shopId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('storefronts')
    .select('shop_id', { count: 'exact', head: true })
    .eq('shop_id', shopId);
  if (error) throw error;
  return (count ?? 0) > 0;
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

// Stages a patch into the draft -- never writes a live column, and never
// replaces the draft outright. save_storefront_draft (20260925000200) does
// `draft = coalesce(draft, '{}') || p_patch` in one UPDATE, which is why this
// is a single RPC call rather than a read-then-write from here: two
// back-to-back saves (headline, then about) would otherwise race, each
// reading before the other's write landed, and whichever wrote last would
// silently drop the other's field. A DB-side merge has no such window.
//
// whatsappE164 arrives already normalized -- ContentDrawer's commitPhone
// calls toE164 itself before this is ever reached, the same validation
// saveStorefront used to run here. There is nothing else in EditableFields
// that needs translating: this stores exactly the camelCase shape it is
// given, because `draft` is not a mirror of any table's columns.
export async function saveDraft(shopId: string, patch: Partial<EditableFields>): Promise<void> {
  const { error } = await supabase.rpc('save_storefront_draft', { p_shop_id: shopId, p_patch: patch });
  if (error) throw error;
}

// The one atomic publish: publish_storefront (20260925000200) copies the
// draft into the live columns (and shops.whatsapp_e164), sets published_at,
// and clears the draft, all inside one function body -- a failure partway
// through (most likely the shops_whatsapp_is_e164 CHECK, if a draft somehow
// held an unnormalized number) rolls the whole thing back rather than
// leaving a new headline live under the old WhatsApp number, or vice versa.
export async function publishDraft(shopId: string): Promise<void> {
  const { error } = await supabase.rpc('publish_storefront', { p_shop_id: shopId });
  if (error) throw error;
}

// Property 7: discarding a draft is possible and returns the editor to the
// live page. Unlike saveDraft this replaces the whole column rather than
// merging into it -- there is nothing to preserve, the shop is throwing the
// staged edits away -- so a plain literal update is correct and no RPC is
// needed; storefronts_member_all and storefronts_module_gate already cover
// an ordinary write to this table.
export async function discardDraft(shopId: string): Promise<void> {
  const { error } = await supabase.from('storefronts').update({ draft: null }).eq('shop_id', shopId);
  if (error) throw error;
}

// ── Flyers ──────────────────────────────────────────────────────────────
//
// The shop-side counterpart to getPublicStorefront's `flyers`. That read
// derives every word of an offer from the promotion row on every call
// (20260930000100's header says why: "a page advertising a discount the till
// refuses does it around the clock, to strangers"). Nothing here undoes that
// -- a flyer stores a promotion_id and never a copy of the offer's words.
//
// `image_path` is `text not null` and holds whatever uploadImage returned.
// That helper (src/lib/storage.ts) hands back an absolute public URL rather
// than the bucket path it wrote to, and there is deliberately exactly ONE
// upload path in this app, so the URL is what gets stored. publicImageUrl --
// the reader that turns this column into something an <Image> can show --
// passes an already-absolute URL straight through untouched, for exactly
// this case (its own comment: hero_image_url, products.image_url and
// shops.logo_url all store full URLs the same way). Adding a second uploader
// that returned the path instead would buy nothing and cost the property
// that there is only one.

export type ShopFlyer = {
  id: string;
  imagePath: string;
  headline: string | null;
  subline: string | null;
  linkKind: StorefrontFlyerLinkKind;
  linkValue: string | null;
  position: number;
  draft: boolean;
  promotionId: string | null;
};

// Everything about a flyer except its id -- what a create writes, and what an
// update may write a subset of.
export type NewFlyer = Omit<ShopFlyer, 'id'>;

// What the UI says out loud ("3 of 5") and stops offering Add at. The DATABASE
// is the authority (enforce_storefront_flyer_limit, 20260930000000) and this
// is only the client's copy of the same number -- flyerErrorMessage below is
// what happens when the two disagree, which is why it reads the cap out of
// the refusal rather than printing this constant.
export const FLYER_LIMIT = 5;

function mapFlyerRow(row: {
  id: string;
  image_path: string;
  headline: string | null;
  subline: string | null;
  link_kind: string;
  link_value: string | null;
  position: number;
  draft: boolean;
  promotion_id: string | null;
}): ShopFlyer {
  return {
    id: row.id,
    imagePath: row.image_path,
    headline: row.headline ?? null,
    subline: row.subline ?? null,
    // Falls back the same way `theme` and `palette` do above, and for the
    // same reason: the CHECK constraint makes an unknown value impossible,
    // so this is one line rather than a branch anything downstream can reach.
    linkKind: (['none', 'category', 'whatsapp'] as const).includes(row.link_kind as StorefrontFlyerLinkKind)
      ? (row.link_kind as StorefrontFlyerLinkKind)
      : 'none',
    linkValue: row.link_value ?? null,
    position: row.position,
    draft: row.draft,
    promotionId: row.promotion_id ?? null,
  };
}

const FLYER_COLUMNS = 'id, image_path, headline, subline, link_kind, link_value, position, draft, promotion_id';

// In `position` order -- the order a customer will see them in, which is the
// only order the editor's own list is allowed to show, or dragging one row
// would move a different one.
export async function listFlyers(shopId: string): Promise<ShopFlyer[]> {
  const { data, error } = await supabase
    .from('storefront_flyers')
    .select(FLYER_COLUMNS)
    .eq('shop_id', shopId)
    .order('position', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as never[]).map(mapFlyerRow);
}

// Deliberately NOT pre-checked against FLYER_LIMIT here. The trigger is the
// authority (a count(*) on the client is not safe against a second device
// adding the sixth at the same moment, which is the whole reason
// 20260930000000 uses a trigger and not an RLS `with check`), and its refusal
// is a typed one flyerErrorMessage turns into a sentence.
export async function createFlyer(shopId: string, flyer: NewFlyer): Promise<void> {
  const { error } = await supabase.from('storefront_flyers').insert({
    shop_id: shopId,
    image_path: flyer.imagePath,
    headline: flyer.headline,
    subline: flyer.subline,
    link_kind: flyer.linkKind,
    link_value: flyer.linkValue,
    position: flyer.position,
    draft: flyer.draft,
    promotion_id: flyer.promotionId,
  });
  if (error) throw error;
}

// A key ABSENT from the patch leaves its column untouched; a key present
// holding null clears it. Same distinction publish_storefront draws with
// `draft ? 'headline'` and the editor already draws with hasOwnProperty --
// without it, detaching an offer (promotionId: null) would be indistinguishable
// from not mentioning it, and would silently never happen.
export async function updateFlyer(id: string, patch: Partial<NewFlyer>): Promise<void> {
  const has = (key: keyof NewFlyer) => Object.prototype.hasOwnProperty.call(patch, key);
  const row: Record<string, unknown> = {
    ...(has('imagePath') && { image_path: patch.imagePath }),
    ...(has('headline') && { headline: patch.headline }),
    ...(has('subline') && { subline: patch.subline }),
    ...(has('linkKind') && { link_kind: patch.linkKind }),
    ...(has('linkValue') && { link_value: patch.linkValue }),
    ...(has('position') && { position: patch.position }),
    ...(has('draft') && { draft: patch.draft }),
    ...(has('promotionId') && { promotion_id: patch.promotionId }),
  };
  const { error } = await supabase.from('storefront_flyers').update(row).eq('id', id);
  if (error) throw error;
}

export async function deleteFlyer(id: string): Promise<void> {
  const { error } = await supabase.from('storefront_flyers').delete().eq('id', id);
  if (error) throw error;
}

// Writes each flyer its index in the list it was handed, rather than swapping
// a pair: the list on screen IS the intended order, so sending the whole
// order leaves no arithmetic for a caller to get wrong and no way for two
// rows to end up sharing a position. There is deliberately no unique index on
// (shop_id, position) (20260930000000's own note -- a non-deferrable one
// would refuse a swap halfway through), so the rows can be walked in order
// with no intermediate state to dodge.
//
// Sequential, not Promise.all: at most five statements, and a failure partway
// through should stop rather than race four more writes at a list the shop is
// about to be told did not save.
export async function reorderFlyers(orderedIds: string[]): Promise<void> {
  for (let index = 0; index < orderedIds.length; index += 1) {
    const { error } = await supabase
      .from('storefront_flyers')
      .update({ position: index })
      .eq('id', orderedIds[index]);
    if (error) throw error;
  }
}

// Live, not staged -- see ShopStorefront.autoAdvance's own comment for why a
// draft would swallow it.
export async function setAutoAdvance(shopId: string, on: boolean): Promise<void> {
  const { error } = await supabase.from('storefronts').update({ auto_advance: on }).eq('shop_id', shopId);
  if (error) throw error;
}

// The sentence a shopkeeper reads when the flyer limit trigger refuses.
//
// enforce_storefront_flyer_limit (20260930000000) raises the same typed shape
// enforce_shop_limit does -- message 'flyer_limit_reached', DETAIL carrying
// {resource, limit, usage} as JSON -- specifically so a client can translate
// it. parseLimitReached (entitlements.ts) deliberately does NOT recognise it:
// that function's message is 'limit_reached' and its resource must be one of
// LIMIT_RESOURCES, and five-per-shop is a fixed property of the design rather
// than something a plan sells more of. So this is the sibling translator, the
// same role orderErrorMessage plays for the order RPCs' own refusals.
//
// The cap is read out of the refusal rather than printed from FLYER_LIMIT: an
// over-the-air JS bundle can outlive the migration that changed the trigger's
// number, and the sentence a shop reads must be the number the database
// actually just enforced.
//
// Returns null for anything else, so a caller keeps its own error path intact.
export function flyerErrorMessage(err: unknown): string | null {
  const e = err as { message?: unknown; details?: unknown; detail?: unknown } | null;
  if (!e || typeof e !== 'object' || e.message !== 'flyer_limit_reached') return null;

  const raw = typeof e.details === 'string' ? e.details : typeof e.detail === 'string' ? e.detail : null;
  let limit = FLYER_LIMIT;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { limit?: unknown };
      if (typeof parsed.limit === 'number') limit = parsed.limit;
    } catch {
      // A refusal whose DETAIL did not parse is still a refusal -- fall back
      // to this build's own number rather than saying nothing.
    }
  }
  return `Your page can show ${limit} flyers, and you already have ${limit}. Remove one before adding another.`;
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

// The one answer to "which location does this shop mean when it names none":
// primary first, then oldest -- the same order complete_sale itself defaults
// to (20260908000300_sale_entry_date.sql:182-189). checkOrderFulfilment below
// and listAddressSuffixSuggestions both read it from here rather than each
// running its own query, because two rules for "the shop's location" is how a
// shop ends up quoting stock from one branch and an address from another.
// Returns null -- never throws -- when the shop has no location at all; what
// that means differs per caller (a blocker for stock, an empty suggestion
// list for an address).
async function primaryLocation(
  shopId: string
): Promise<{ id: string; neighborhood: string | null; city: string | null } | null> {
  const { data, error } = await supabase
    .from('shop_locations')
    .select('id, neighborhood, city')
    .eq('shop_id', shopId)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string; neighborhood: string | null; city: string | null } | null) ?? null;
}

// What to offer a shop whose derived address is already taken: the part of
// town it trades in, then the town. Neighbourhood first because it is what
// distinguishes two shops with the same name in the same city -- which is the
// whole collision.
//
// DELIBERATELY INCAPABLE OF RETURNING A NUMBER. There is no counter here and
// no fallback that invents one: a shop with neither neighbourhood nor city
// gets an empty list, and the editor asks it for the part of town instead.
// `xamdi-electronics-2` reads like a mistake; `xamdi-electronics-koodbuur`
// reads like an address a customer can trust.
//
// Normalized through normalizeSlug so what is offered is already a legal DNS
// label ('Road No 1' -> 'road-no-1'), and de-duplicated so a location whose
// neighbourhood and city are the same word offers it once.
export async function listAddressSuffixSuggestions(shopId: string): Promise<string[]> {
  const location = await primaryLocation(shopId);
  if (!location) return [];
  const candidates = [location.neighborhood, location.city]
    .map((part) => normalizeSlug(part ?? ''))
    .filter((part) => part.length > 0);
  return [...new Set(candidates)];
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

function mapStorefrontProductRow(row: {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  price_cents: number;
  stock: number;
  image_url: string | null;
}): StorefrontProduct {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    category: row.category ?? null,
    priceCents: row.price_cents,
    stock: row.stock,
    imageUrl: row.image_url ?? null,
  };
}

// In-stock first, then category, then name -- the exact order
// get_public_storefront_products (20260924000100) sorts by, reproduced here
// rather than delegated to PostgREST: `order by (stock > 0) desc` is a
// computed boolean expression, which `.order()` on the JS client can only
// name a real column for, not express. Ties broken the way Postgres does:
// nulls (an uncategorised product) sort after every real category name.
function compareStorefrontProducts(a: StorefrontProduct, b: StorefrontProduct): number {
  const inStockA = a.stock > 0 ? 1 : 0;
  const inStockB = b.stock > 0 ? 1 : 0;
  if (inStockA !== inStockB) return inStockB - inStockA;
  if (a.category !== b.category) {
    if (a.category === null) return 1;
    if (b.category === null) return -1;
    const byCategory = a.category.localeCompare(b.category);
    if (byCategory !== 0) return byCategory;
  }
  return a.name.localeCompare(b.name);
}

// The preview's product list, read admin-side rather than through
// get_public_storefront_products -- same reason countOnlineProducts above
// bypasses that RPC: it deliberately returns zero rows while
// `published_at is null` (a draft shop must read as a nonexistent one to a
// customer), which would make the editor's OWN preview show an empty
// catalogue for every shop on its first run, the exact moment three real
// products are sitting there marked to sell online. Column list and sort
// order are kept byte-for-byte identical to that RPC -- the preview is
// supposed to be what a customer will see the moment this shop publishes,
// not a different query that happens to look similar.
export async function getStorefrontPreviewProducts(shopId: string): Promise<StorefrontProduct[]> {
  const { data, error } = await supabase
    .from('products')
    .select('id, name, description, category, price_cents, stock, image_url')
    .eq('shop_id', shopId)
    .eq('is_listed_online', true);
  if (error) throw error;
  return (data ?? []).map(mapStorefrontProductRow).sort(compareStorefrontProducts);
}

// published_at is the draft/live switch itself (20260924000000's comment on
// the column): null pulls the page down without deleting anything it shows.
// Deliberately narrowed to the pull-down direction only -- the old
// `setPublished(shopId, true)` was unreachable in practice (nothing called
// it) and a foot-gun the moment something did: it would set published_at
// WITHOUT copying the draft into the live columns first, defeating
// publish_storefront's atomic copy (20260925000200) and shipping whatever
// was already live under a freshly "published" timestamp. Going live has
// exactly one path -- publishDraft, below -- and this function cannot be
// asked to take it.
export async function unpublish(shopId: string): Promise<void> {
  const { error } = await supabase.from('storefronts').update({ published_at: null }).eq('shop_id', shopId);
  if (error) throw error;
}

// Task 9 built this as a read-only list, and its comment used to say status
// was "deliberately not read". Task 6 turns the list into an inbox a shop
// works from, and every state that list has to be a tab of needs `status` on
// the row -- see orders.tsx for the actions that now change it, each guarded
// to exactly the moves 20260928000100_order_transitions.sql /
// 20260928000200_complete_storefront_order.sql permit.
export type OrderStatus = 'pending' | 'accepted' | 'ready' | 'completed' | 'cancelled';

export type ShopOrder = {
  id: string;
  number: number;
  customerName: string;
  customerPhone: string;
  fulfilment: 'collect' | 'deliver';
  // Snapshot of the area name, never an id -- same reasoning as the column's
  // own comment: null for collect, the shop's `storefront_delivery_areas`
  // name at order time for deliver.
  deliveryArea: string | null;
  // B4: "Hargeisa addresses are landmarks, not street numbers" is this
  // branch's entire delivery premise (checkout-form.tsx collects it,
  // place_storefront_order validates and stores it) -- selecting deliveryArea
  // above without this leaves a shop that has to phone every delivery
  // customer to find out where to actually go. Null for collect, same as
  // deliveryArea.
  deliveryLandmark: string | null;
  // Free text the customer left at checkout. Null when they left nothing --
  // shown only in the detail view, never worth a list column of its own.
  note: string | null;
  status: OrderStatus;
  // Non-null only once status is 'cancelled' -- orders_cancellation_reason_
  // required (20260928000100) guarantees the two travel together server-side.
  cancellationReason: string | null;
  // Total UNITS across every line, not the number of lines -- what a shop
  // actually has to pull off the shelf. sales.item_count (0001_init.sql) is
  // computed the same way, by summing quantity.
  itemCount: number;
  // The three money columns 20260926000050_orders.sql's own CHECK
  // (orders_total_is_subtotal_plus_delivery) guarantees add up: subtotal is
  // goods only, deliveryFee is 0 on a collect order (the sibling CHECK,
  // orders_delivery_matches_fulfilment, enforces that server-side), total is
  // their sum -- the exact figure the customer agreed to pay at checkout
  // (checkout-form.tsx's own Goods/Delivery/Total breakdown). The order
  // detail sheet reads all three so a shop sees the SAME numbers the
  // customer did, not just the goods subtotal.
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  /**
   * The sale this order became, or null until it is completed. Set by
   * complete_storefront_order in the same statement as the status
   * (20260928000200), so the two can never disagree AT THE MOMENT OF
   * COMPLETION.
   *
   * They can still disagree LATER: `on delete set null` means this goes back
   * to null if the sale is ever deleted (delete_sale, 20260908000900,
   * reachable from Accounting -> Transactions with no storefront exemption),
   * and delete_sale never touches orders.status. So `status === 'completed'
   * && saleId === null` is a real, reachable state -- a completed order
   * whose sale was later voided -- not a legacy case from before this column
   * existed. order-detail.tsx's reconciliation block is gated on saleId
   * itself for exactly this reason, not on status alone.
   *
   * The link runs ONE WAY only -- there is no sales.order_id -- which is why
   * a completed order is indistinguishable from a walk-in once it reaches the
   * Transactions tab. The sheet's reconciliation block is this link read back.
   */
  saleId: string | null;
  createdAt: string;
  /**
   * The customer's own link to this order (20261016000000). Null for any
   * order placed before that migration -- such an order simply has no link to
   * share, and the sheet must render nothing rather than a broken address.
   */
  shareToken: string | null;
  /** When the customer agreed to the latest amendment, if they have. */
  confirmedAt: string | null;
  /**
   * When this order was last amended, or null if it never has been. Paired
   * with confirmedAt by isAwaitingCustomer (order-amendment.ts) -- the two are
   * compared rather than null-checked, because an order amended AGAIN after an
   * agreement is awaiting a new one.
   */
  lastAmendedAt: string | null;
};

function mapOrderRow(row: {
  id: string;
  number: number;
  customer_name: string;
  customer_phone: string;
  fulfilment: string;
  delivery_area: string | null;
  delivery_landmark: string | null;
  note: string | null;
  status: string;
  cancellation_reason: string | null;
  subtotal_cents: number;
  delivery_fee_cents: number;
  total_cents: number;
  sale_id: string | null;
  created_at: string;
  share_token: string | null;
  customer_confirmed_at: string | null;
  order_amendments: { amended_at: string }[] | null;
  order_items: { quantity: number }[] | null;
}): ShopOrder {
  return {
    id: row.id,
    number: row.number,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    fulfilment: row.fulfilment as 'collect' | 'deliver',
    deliveryArea: row.delivery_area ?? null,
    deliveryLandmark: row.delivery_landmark ?? null,
    note: row.note ?? null,
    status: row.status as OrderStatus,
    cancellationReason: row.cancellation_reason ?? null,
    itemCount: (row.order_items ?? []).reduce((sum, item) => sum + item.quantity, 0),
    subtotalCents: row.subtotal_cents,
    deliveryFeeCents: row.delivery_fee_cents,
    totalCents: row.total_cents,
    saleId: row.sale_id ?? null,
    createdAt: row.created_at,
    shareToken: row.share_token ?? null,
    confirmedAt: row.customer_confirmed_at ?? null,
    // The LATEST amendment. PostgREST returns the nested rows unordered, so
    // the max is taken here rather than trusting position -- reading [0]
    // would flag the wrong thing on an order amended twice.
    // Compared as DATES, not as strings. Lexicographic ordering happens to be
    // right for the ISO-8601-with-fixed-offset form PostgREST returns today,
    // which is exactly why it is the kind of thing that breaks quietly if that
    // ever changes -- and isAwaitingCustomer, the only consumer, already
    // parses these to Date. One comparison rule for one value.
    lastAmendedAt: (row.order_amendments ?? []).reduce<string | null>(
      (latest, a) =>
        latest === null || new Date(a.amended_at).getTime() > new Date(latest).getTime() ? a.amended_at : latest,
      null
    ),
  };
}

// Task 7: what a shop still owes an order. Lives in ./order-status, not here
// -- see that file's own comment for why -- and is re-exported so existing
// importers of storefront-admin.ts see no change.
export { ORDERS_NEEDING_ACTION };

// RLS ("own orders", 20260926000050) already narrows this to the caller's own
// shop; the `eq` here is what makes the QUERY itself scoped rather than
// relying on RLS alone to filter a table-wide select. Newest first -- the
// order a shopkeeper checking in on their page actually wants, and the same
// direction receivables/invoices lists read in.
export async function listOrders(shopId: string): Promise<ShopOrder[]> {
  const { data, error } = await supabase
    .from('orders')
    .select(
      'id, number, customer_name, customer_phone, fulfilment, delivery_area, delivery_landmark, note, status, cancellation_reason, subtotal_cents, delivery_fee_cents, total_cents, sale_id, created_at, share_token, customer_confirmed_at, order_items(quantity), order_amendments(amended_at)'
    )
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => mapOrderRow(row as never));
}

// N3: the badge on Settings -> Orders and the attention row on the dashboard
// both used to be `listOrders(shopId).length` after a client-side filter --
// every column, every order the shop has EVER placed, all its nested
// order_items, fetched on every focus, to produce one integer. This is the
// same count, read as a count: PostgREST's `head: true` skips the row
// payload entirely and returns only Content-Range, so the response is a
// number, not a table. `.in()` does the ORDERS_NEEDING_ACTION filtering
// server-side rather than client-side, so there is no array here to dedupe
// against the three places that used to re-inline it (attention.ts,
// settings-sidebar.tsx, orders.tsx's own unconfirmedOrders) -- two of those
// three now call this instead, and orders.tsx's is a different question (the
// SUM of unconfirmed totals, not merely their count), which still needs the
// full rows this function deliberately no longer fetches.
export async function countOrdersNeedingAction(shopId: string): Promise<number> {
  const { count, error } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('shop_id', shopId)
    .in('status', ORDERS_NEEDING_ACTION);
  if (error) throw error;
  return count ?? 0;
}

// Task 6: the lines a shop must pull off the shelf, at the price the customer
// actually agreed to -- order_items snapshots product_name and
// unit_price_cents at checkout (20260926000050's own header), never joined
// live against today's `products` row. Ordered by product_name, the same
// tie-break complete_storefront_order uses when it assembles this same table
// for complete_sale (20260928000200:307-324), so the detail view lists lines
// in the order the shop will see them posted.
export type OrderLine = {
  id: string;
  // Null when the product has since been deleted (`on delete set null`,
  // 20260926000050) -- the line stays readable off its own snapshot.
  productId: string | null;
  productName: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
};

function mapOrderLineRow(row: {
  id: string;
  product_id: string | null;
  product_name: string;
  unit_price_cents: number;
  quantity: number;
  line_total_cents: number;
}): OrderLine {
  return {
    id: row.id,
    productId: row.product_id ?? null,
    productName: row.product_name,
    unitPriceCents: row.unit_price_cents,
    quantity: row.quantity,
    lineTotalCents: row.line_total_cents,
  };
}

export async function getOrderItems(orderId: string): Promise<OrderLine[]> {
  const { data, error } = await supabase
    .from('order_items')
    .select('id, product_id, product_name, unit_price_cents, quantity, line_total_cents')
    .eq('order_id', orderId)
    .order('product_name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => mapOrderLineRow(row as never));
}

// ── Transitions ─────────────────────────────────────────────────────────
//
// Thin wrappers around the two doors the database actually opens --
// transition_order and complete_storefront_order
// (20260928000100_order_transitions.sql / 20260928000200_complete_storefront_
// order.sql). Neither the permitted-moves table nor the payment-method list
// is re-encoded here: a move this file did not anticipate is left to the
// RPC's own `invalid_order_transition` / `invalid_payment_method`, the same
// posture transition_order's own header takes about not duplicating the
// trigger that is the real enforcement. orders.tsx is what only offers a
// button for a move the order's CURRENT status actually permits -- these
// four exist so that decision has something honest to call.

export async function acceptOrder(orderId: string): Promise<void> {
  const { error } = await supabase.rpc('transition_order', { p_order_id: orderId, p_status: 'accepted' });
  if (error) throw error;
}

export async function markOrderReady(orderId: string): Promise<void> {
  const { error } = await supabase.rpc('transition_order', { p_order_id: orderId, p_status: 'ready' });
  if (error) throw error;
}

// `reason` is required by the caller's own form before this is ever called,
// and orders_cancellation_reason_required (20260928000100) holds the same
// line server-side regardless -- this does not re-validate it, only carries
// it through.
export async function cancelOrder(orderId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('transition_order', {
    p_order_id: orderId,
    p_status: 'cancelled',
    p_cancellation_reason: reason,
  });
  if (error) throw error;
}

// complete_storefront_order's own permitted list (20260928000200:277) is
// complete_sale's list minus 'unpaid' -- an order handed over at the door has
// been paid for, and there is no customer record here to leave a balance
// against.
export type PaymentMethod = 'cash' | 'zaad' | 'edahab' | 'other';

export async function completeOrder(orderId: string, paymentMethod: PaymentMethod): Promise<void> {
  const { error } = await supabase.rpc('complete_storefront_order', {
    p_order_id: orderId,
    p_payment_method: paymentMethod,
  });
  if (error) throw error;
}

/**
 * Today's shelf price for a set of products, as `{ [productId]: cents }`.
 *
 * The amend sheet's pricing choice needs this and the order's own snapshot
 * cannot answer it -- `order_items.unit_price_cents` is by definition what the
 * price WAS. Kept as its own small query rather than widened onto
 * getOrderItems, so an order nobody amends never pays for it.
 *
 * A product with no row is ABSENT from the map, never zero: order-amendment.ts
 * reads absent as "this line cannot be re-priced" and would read zero as
 * "free".
 */
export async function getCurrentPrices(productIds: string[]): Promise<Record<string, number>> {
  if (productIds.length === 0) return {};
  const { data, error } = await supabase.from('products').select('id, price_cents').in('id', productIds);
  if (error) throw error;
  const prices: Record<string, number> = {};
  for (const row of (data ?? []) as { id: string; price_cents: number }[]) {
    prices[row.id] = row.price_cents;
  }
  return prices;
}

// ── Amending ────────────────────────────────────────────────────────────
//
// One line of an order, as it should now stand. `quantity: 0` REMOVES the
// line -- it is not an error, and it is the same instruction as leaving the
// line out entirely. A sheet that draws a stepper per line sends the zero.
export type OrderAmendmentLine = { productId: string; quantity: number };

/**
 * Which price an amended line carries.
 *
 * 'agreed' keeps `order_items.unit_price_cents` -- the figure the customer was
 * quoted at checkout. 'current' re-prices from today's `products.price_cents`.
 *
 * BOTH COMPLETE. The often-repeated claim that an amend must re-price to be
 * completable stopped being true at 20260929000000: complete_sale resolves a
 * line as `coalesce(v_agreed_price, v_product.price_cents)` and
 * complete_storefront_order supplies an agreed price for every line, so the
 * quoted figure survives to the till. Which one a shop wants is therefore a
 * question about what it owes the customer, and `amend_order` records the
 * answer on the amendment row rather than choosing for them.
 *
 * 'current' IS A ONE-WAY DOOR, and the UI says so. Re-pricing rewrites
 * `order_items.unit_price_cents`, which is the only place the order's prices
 * live -- so a later 'agreed' amend keeps the RE-PRICED figures, not the
 * original quote. Nothing is lost: `order_amendments.before` holds every
 * previous state, and the pricing column says which amends re-priced. But
 * there is no "put it back" through this function, and a sentence promising
 * one would be false.
 */
export type OrderPricing = 'agreed' | 'current';

export type OrderAmendmentOptions = {
  /** Optional, and the ONLY prose a customer may ever see. Never the reason. */
  customerNote?: string | null;
  /** Omitted means the server's own default, which is 'agreed'. */
  pricing?: OrderPricing;
  fulfilment?: {
    fulfilment: 'collect' | 'deliver';
    deliveryArea?: string | null;
    deliveryLandmark?: string | null;
  } | null;
  contact?: { customerName: string; customerPhone: string } | null;
};

/**
 * Change an order instead of cancelling it.
 *
 * `reason` is internal and required -- `amend_order` refuses a blank one and
 * `order_amendments_reason_required` refuses it again at the table. It is
 * written for the shop to read weeks later and must never reach a customer;
 * `options.customerNote` is the separate field for that.
 *
 * An optional argument this function was not given is OMITTED from the RPC
 * payload rather than sent as null, so the SQL defaults stay the single
 * definition of each default. That matters most for `p_pricing`: sent wrong it
 * charges a different price, and sent not at all it charges the agreed one.
 *
 * There is no way to ADD a product here, deliberately -- `amend_order` refuses
 * a line that is not already on the order (`order_line_not_in_order`). See its
 * migration header for why.
 */
export async function amendOrder(
  orderId: string,
  lines: OrderAmendmentLine[],
  reason: string,
  options?: OrderAmendmentOptions
): Promise<ShopOrder> {
  const params: Record<string, unknown> = {
    p_order_id: orderId,
    p_lines: lines.map((line) => ({ product_id: line.productId, quantity: line.quantity })),
    p_reason: reason,
  };
  if (options?.pricing !== undefined) params.p_pricing = options.pricing;
  if (options?.customerNote !== undefined && options.customerNote !== null) {
    params.p_customer_note = options.customerNote;
  }
  if (options?.fulfilment) {
    const f: Record<string, unknown> = { fulfilment: options.fulfilment.fulfilment };
    if (options.fulfilment.deliveryArea !== undefined) f.delivery_area = options.fulfilment.deliveryArea;
    if (options.fulfilment.deliveryLandmark !== undefined) f.delivery_landmark = options.fulfilment.deliveryLandmark;
    params.p_fulfilment = f;
  }
  if (options?.contact) {
    params.p_contact = {
      customer_name: options.contact.customerName,
      customer_phone: options.contact.customerPhone,
    };
  }

  const { data, error } = await supabase.rpc('amend_order', params);
  if (error) throw error;

  // `returns public.orders` is a composite, which PostgREST answers as one
  // object; the array branch is defensive about a client or version that wraps
  // it, not a case seen in practice.
  const row = (Array.isArray(data) ? data[0] : data) as Parameters<typeof mapOrderRow>[0];

  // itemCount cannot come from the response -- the row carries no nested
  // order_items -- so it comes from the lines that were just SENT. That is not
  // a guess: amend_order rebuilds order_items from exactly this array, drops
  // the zeros, and raises rather than deviating from it. Reading it back with
  // a second round trip would cost a query to learn something already known.
  //
  // The dropped lines are NOT filtered out first, and deliberately not:
  // itemCount is a sum of quantities, a dropped line's quantity is 0, and 0
  // adds nothing. A filter here would read as a safeguard while being
  // incapable of changing any answer -- a mutation pass caught exactly that,
  // removing the filter and leaving every test green.
  return mapOrderRow({ ...row, order_items: lines.map((line) => ({ quantity: line.quantity })) });
}

// The sentence a shopkeeper reads when an order move is refused.
//
// transition_order and complete_storefront_order (20260928000100 /
// 20260928000200 / 20260928000600) raise a short snake_case code plus a JSON
// `detail` -- built for a client to translate, not for a shop to read
// verbatim. Before this, orders.tsx's runAction passed `err.message` straight
// through, so a shop saw the literal token: `insufficient_stock`,
// `order_total_changed`, `invalid_order_transition`. This is the translation,
// the same role checkoutErrorMessage (checkout-errors.ts) plays for
// complete_sale's own refusals and describePlanError (entitlements.ts) plays
// for a plan/module refusal -- each says what the shop can DO, not what went
// wrong.
//
// `module_not_included` is deliberately NOT handled here: describePlanError
// already recognises it (parseModuleNotIncluded) and runAction chains this
// AFTER that call, the house pattern at entitlements.ts:273 --
// `describePlanError(err) ?? orderErrorMessage(err) ?? extractErrorMessage(err, fallback)`.
// A second case for the same code here would just be a second copy of that
// wording, waiting to drift from the first.
//
// Returns null for anything unrecognised, so a caller keeps its existing
// fallback intact -- a network drop or a code this function does not yet
// know about must not be swallowed into a generic sentence that hides what
// actually happened from whoever reads the next bug report.
export function orderErrorMessage(err: unknown): string | null {
  const e = err as { message?: unknown; details?: unknown; detail?: unknown } | null;
  if (!e || typeof e !== 'object' || typeof e.message !== 'string') return null;

  // PostgREST surfaces a raised exception's DETAIL as `details` (parseLimitReached,
  // entitlements.ts, established this shape first) -- `detail` is read too, in
  // case a future PostgREST version or a differently-shaped client renames it.
  const raw = typeof e.details === 'string' ? e.details : typeof e.detail === 'string' ? e.detail : null;
  let detail: Record<string, unknown> | null = null;
  if (raw) {
    try {
      detail = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      detail = null;
    }
  }

  switch (e.message) {
    case 'insufficient_stock':
      // The short items are already named per-line, above this message
      // (order-detail.tsx's own shortfall rows) -- this only says what to do
      // about them.
      return "There isn't enough stock to complete this order. Restock the short item(s) above, or cancel the order if you can't get more in time.";

    case 'order_total_changed':
      // NARROWED BY 20260929000200, and the sentence with it. This used to be
      // B1's known limitation -- complete_sale re-priced from today's
      // products.price_cents and added the shop's tax on top of a quote taken
      // before it, so a re-priced product stranded its order and a
      // tax-charging shop hit this on EVERY order. Both are fixed: the order's
      // own snapshot is what the sale is filed at, and the tax comes out of the
      // quoted total rather than being added to it.
      // What is left is an order whose stored total is not the sum of its own
      // lines -- which the storefront cannot produce and no app screen can
      // write -- so the sentence no longer blames a price change or tax, and
      // says the one thing a shopkeeper can actually do about it.
      return "This order's own total doesn't add up to the items on it, so it can't be completed as it stands. Check the order with the customer and re-take it, or get in touch with support.";

    case 'order_product_deleted': {
      const products = typeof detail?.products === 'string' ? detail.products : 'A product on this order';
      return `${products} no longer exists in your catalogue, so this order can't be completed as it stands. Cancel it and ask the customer to reorder, or add the product back first.`;
    }

    case 'order_line_out_of_range':
      // ADDED BY 20260929000250, for a refusal 20260929000200 created. Filing
      // each line at the price the customer agreed to puts it behind
      // complete_sale's per-line ceiling for an agreed price (1,000,000,000
      // cents), which an order line can exceed -- order_items.line_total_cents
      // is a plain integer -- and such an order completed before that branch.
      // Untranslated it arrived as complete_sale's own English, naming a field
      // (`agreed price`) no storefront screen has ever shown.
      //
      // The detail carries that message unchanged, for a bug report; the
      // sentence says the one thing the shop can do, which is not "fix the
      // price" -- the price is the one it published -- but "this line is too
      // big to ring up as one line".
      return "One line on this order is priced too high for a single sale line to carry, so it can't be completed as it stands. Re-take the order with that line split into smaller quantities, or get in touch with support.";

    case 'order_has_no_items':
      return "This order has nothing left to complete. Cancel it instead.";

    case 'invalid_payment_method':
      return 'Pick a payment method before completing this order.';

    case 'invalid_order_transition':
      // The likeliest real cause named directly, per the review: someone else
      // on the team already acted on this order (another phone, another
      // till) -- including a completion that committed while a response
      // timed out, which makes a retry read as "already done", not "failed".
      return "This order has already moved on -- most likely someone else on your team already acted on it, or this exact action already went through a moment ago. Close this and check its current status before trying again.";

    case 'cancellation_reason_required':
      return 'Enter a reason before cancelling this order.';

    case 'pos_access_required':
      return "Completing an order needs POS access, which your account doesn't have. Ask an owner or manager to complete it, or to grant you POS access.";

    // ── amend_order's refusals (20261012000000) ────────────────────────
    case 'amendment_reason_required':
      return 'Enter a reason for this change before saving it. It is for your own records and the customer never sees it.';

    case 'order_not_amendable': {
      // Naming the status matters: "completed" and "cancelled" call for
      // different next moves, and the sheet may be showing a stale copy of
      // either while someone else on the team acts on the real one.
      const status = typeof detail?.status === 'string' ? detail.status : null;
      if (status === 'completed') {
        return "This order has already been completed and can't be changed. If the sale was wrong, edit or refund the sale itself from Transactions.";
      }
      if (status === 'cancelled') {
        return "This order has been cancelled and can't be changed. Ask the customer to place a new one.";
      }
      return "This order can't be changed as it stands -- it has most likely been completed or cancelled since this screen loaded. Close this and check its current status.";
    }

    case 'sales_edit_required':
      return "Changing an order needs the 'Edit/delete sales' permission, which your account doesn't have. Ask an owner or manager to make the change, or to grant you that permission.";

    case 'order_line_not_in_order':
      // The one refusal that is a deliberate product decision rather than a
      // guard, so the sentence says what to do instead of only what failed.
      return "You can only reduce or remove what the customer already ordered, not add something new to it. To sell them something else, take it as a separate order.";

    case 'invalid_contact':
      return "That phone number isn't in a form we can use. Enter it in full international form, starting with + and the country code.";

    case 'unknown_delivery_area': {
      const area = typeof detail?.area === 'string' ? `"${detail.area}"` : 'That delivery area';
      return `${area} isn't one of your delivery areas any more. Pick one from your storefront's list, or add it back in Storefront settings.`;
    }

    case 'delivery_unavailable':
      return "Your storefront has delivery switched off, so this order can't be moved to delivery. Turn delivery on in Storefront settings first, or keep it as a pick-up.";

    case 'order_total_out_of_range':
      // Distinct from order_line_out_of_range above: that one is a single line
      // too big to ring up, this is the whole order past what an order total
      // can hold. Same advice, different cause, so a bug report says which.
      return "This order's total is too large to store as one order. Reduce the quantities, or split it into more than one order.";

    default:
      return null;
  }
}

// Task 3: what a shop needs to know before "accept" is offered -- which
// lines of this order it cannot currently fill, and by how much. `orders`
// carries no location_id of its own, so this resolves the same location
// complete_sale defaults to when none is given -- primary first, then oldest
// (20260908000300_sale_entry_date.sql:182-189) -- through primaryLocation
// above, which is the single place that rule lives. Stock is then read from
// product_location_stock there -- the exact table and location complete_sale
// checks at payment time -- never products.stock, which is a column a
// trigger recomputes and silently reverts direct reads of any staleness
// assumption against (20260810000000_stock_by_location.sql:168; plan 3 lost
// a test to exactly that mistake).
//
// A line whose product_id has gone `on delete set null`
// (20260926000050_orders.sql) is treated as fully unavailable -- there is no
// stock row left to read -- rather than skipped, so a deleted product still
// shows up as something the shop must resolve, not something silently
// dropped from the count.
//
// The comparison itself is delegated to findShortfalls (order-fulfilment.ts)
// so the "never auto-resolve a shortfall" rule lives in exactly one place,
// provable without a database.
/**
 * What a shop cannot currently fill, for MANY orders at once.
 *
 * THREE QUERIES, WHATEVER N IS -- one location lookup, one for every order's
 * lines, one for every product's stock. That is the whole reason this exists.
 * The single-order form below re-resolved the shop's primary location on every
 * call and ran two more queries, so the orders screen -- which asks once per
 * visible open row -- spent roughly 3N round trips, about 120 for 40 open
 * orders, on mount, on tab switch and after every action. It degraded past
 * 20-30 open orders.
 *
 * orders.tsx could not fix it from where it sat: primaryLocation is private to
 * this module and checkOrderFulfilment took no pre-resolved location, so there
 * was no way to hoist the shared lookup without changing this contract. Its
 * own comment recorded that and left the cost measured for whoever could.
 *
 * Returns an entry for EVERY id asked about, including orders with no lines,
 * so a caller never has to tell "nothing short" apart from "never answered".
 *
 * Location, stock table and comparison are unchanged from the single form --
 * see its comment for why product_location_stock and never products.stock, and
 * why a deleted product counts as fully unavailable rather than being skipped.
 */
export async function checkOrdersFulfilment(
  shopId: string,
  orderIds: string[]
): Promise<Record<string, OrderShortfall[]>> {
  if (orderIds.length === 0) return {};

  const location = await primaryLocation(shopId);
  if (!location) throw new Error(`shop ${shopId} has no location to check stock against`);

  const { data: items, error: itemsError } = await supabase
    .from('order_items')
    .select('order_id, product_id, product_name, quantity')
    .in('order_id', orderIds);
  if (itemsError) throw itemsError;

  const rows = (items ?? []) as {
    order_id: string;
    product_id: string | null;
    product_name: string;
    quantity: number;
  }[];

  const productIds = [...new Set(rows.map((row) => row.product_id).filter((id): id is string => id !== null))];

  const stockByProduct = new Map<string, number>();
  if (productIds.length > 0) {
    const { data: stockRows, error: stockError } = await supabase
      .from('product_location_stock')
      .select('product_id, stock')
      .eq('location_id', location.id)
      .in('product_id', productIds);
    if (stockError) throw stockError;
    for (const row of (stockRows ?? []) as { product_id: string; stock: number }[]) {
      stockByProduct.set(row.product_id, row.stock);
    }
  }

  // Seeded with every id FIRST, so an order whose lines came back empty still
  // gets an answer rather than being absent from the map.
  const byOrder: Record<string, OrderShortfall[]> = {};
  for (const id of orderIds) byOrder[id] = [];

  const linesByOrder = new Map<string, { productId: string | null; productName: string; quantity: number; available: number }[]>();
  for (const row of rows) {
    const list = linesByOrder.get(row.order_id) ?? [];
    list.push({
      productId: row.product_id,
      productName: row.product_name,
      quantity: row.quantity,
      available: row.product_id ? stockByProduct.get(row.product_id) ?? 0 : 0,
    });
    linesByOrder.set(row.order_id, list);
  }

  // findShortfalls PER ORDER, never over the pooled lines: two orders sharing
  // a product are two separate questions, and pooling them would report both
  // short or neither.
  for (const [orderId, lines] of linesByOrder) {
    byOrder[orderId] = findShortfalls(lines);
  }

  return byOrder;
}

/**
 * The same question for ONE order, and now a thin call through the batched
 * form above rather than a second implementation of it. One code path means
 * the detail sheet and the list can never disagree about what "short" means.
 */
export async function checkOrderFulfilment(shopId: string, orderId: string): Promise<OrderShortfall[]> {
  const byOrder = await checkOrdersFulfilment(shopId, [orderId]);
  return byOrder[orderId] ?? [];
}
