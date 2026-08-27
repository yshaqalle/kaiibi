import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { ContentDrawer, type ContentDrawerFocusRequest, type ContentDrawerValue, type SlugState } from '@/components/storefront/editor/content-drawer';
import { DeliveryEditor, type SavedArea } from '@/components/storefront/editor/delivery-editor';
import { DesignStrip } from '@/components/storefront/editor/design-strip';
import { FlyerEditor, type FlyerFields } from '@/components/storefront/editor/flyer-editor';
import { PublishBar } from '@/components/storefront/editor/publish-bar';
import { StorefrontView } from '@/components/storefront/storefront-view';
import { AppModal } from '@/components/ui/app-modal';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { isPromotionLive } from '@/lib/discounts';
import { describePlanError } from '@/lib/entitlements';
import { posterCopyFor } from '@/lib/poster';
import { listPromotions } from '@/lib/promotions';
import { publicImageUrl, uploadImage } from '@/lib/storage';
import {
  checkSlug,
  claimSlug,
  countOnlineProducts,
  createFlyer,
  deleteDeliveryArea,
  deleteFlyer,
  discardDraft,
  ensureStorefront,
  getMyStorefront,
  getStorefrontPreviewProducts,
  listDeliveryAreas,
  listFlyers,
  publishBlockers,
  publishDraft,
  reorderFlyers,
  saveDeliveryArea,
  saveDraft,
  setAutoAdvance,
  unpublish,
  updateFlyer,
  type DeliveryArea,
  type EditableFields,
  type PublishBlocker,
  type ShopFlyer,
  type ShopStorefront,
} from '@/lib/storefront-admin';
import type { Promotion, PublicStorefront, StorefrontFlyer, StorefrontProduct } from '@/types/models';

// Pinned to the light palette -- no dark mode yet, same as every other bento
// admin screen. The PREVIEW below is exempt: it renders the shop's own
// palette, whatever that is.
const theme = Colors.light;

// How long a pause in typing has to last before an edit reaches the server's
// `draft` column (saveDraft, storefront-admin.ts). Long enough that a
// keystroke never fires its own round trip, short enough that "losing the
// network or navigating away costs nothing" (Task 7b property 4) is true in
// practice, not just in principle.
const AUTOSAVE_DEBOUNCE_MS = 800;

function editableFieldsOf(s: ShopStorefront): EditableFields {
  return {
    theme: s.theme,
    palette: s.palette,
    headline: s.headline,
    about: s.about,
    heroImageUrl: s.heroImageUrl,
    offersDelivery: s.offersDelivery,
    whatsappE164: s.whatsappE164,
  };
}

function sameEditableFields(a: EditableFields, b: EditableFields): boolean {
  return (
    a.theme === b.theme &&
    a.palette === b.palette &&
    a.headline === b.headline &&
    a.about === b.about &&
    a.heroImageUrl === b.heroImageUrl &&
    a.offersDelivery === b.offersDelivery &&
    a.whatsappE164 === b.whatsappE164
  );
}

function messageOf(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

export default function StorefrontEditor() {
  const { shop, locations, hasModule } = useAuth();
  const shopId = shop?.id ?? null;
  // The house pattern for a MODULE gate (entitlements.ts:28,44) -- the same
  // hasModule() the sidebar, the tabs and people.tsx's marketing panel use.
  // False does NOT hide the flyer panel: a shop without Promotions can still
  // put up announcement flyers, and only the offer picker goes away, saying
  // so rather than appearing broken.
  const promotionsEnabled = hasModule('promotions');
  const { width } = useWindowDimensions();
  const isWide = width >= TABLET_BREAKPOINT;

  const [loading, setLoading] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // `working` is what's on screen, edited freely -- the live row overlaid
  // with its server-side draft (property 5), then with whatever the
  // shopkeeper has typed since. `livePublished` is the actual published
  // state (on load, and again after every successful publish or discard) --
  // comparing the two is the only source `dirty` needs, and it is never
  // anything saveDraft itself computes. Neither field ever writes on its
  // own: patchDraft below queues an autosave, and Publish/Discard each
  // refetch the row afterward rather than guessing at the server's new
  // shape client-side.
  const [working, setWorking] = useState<ShopStorefront | null>(null);
  const [livePublished, setLivePublished] = useState<EditableFields | null>(null);

  // Patches not yet sent to saveDraft, and the timer that will flush them.
  // Refs, not state: queuing an autosave must never itself trigger a
  // re-render, and flushAutosave needs the latest pending patch synchronously
  // (from handlePublish, from unmount) rather than through a stale closure.
  const pendingDraftPatchRef = useRef<Partial<EditableFields>>({});
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [slugDraft, setSlugDraft] = useState('');
  const [slugState, setSlugState] = useState<SlugState>('idle');

  const [deliveryAreas, setDeliveryAreas] = useState<DeliveryArea[]>([]);
  const [onlineProductCount, setOnlineProductCount] = useState(0);
  const [previewProducts, setPreviewProducts] = useState<StorefrontProduct[]>([]);
  const [flyers, setFlyers] = useState<ShopFlyer[]>([]);
  // EVERY unarchived promotion, not only the running ones. The picker offers
  // only what is running (below), but the preview needs the whole list to
  // tell "this flyer's offer has ended" (drop the panel, exactly as
  // get_public_storefront does) apart from "this flyer never had one".
  const [promotions, setPromotions] = useState<Promotion[]>([]);

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState<ContentDrawerFocusRequest | null>(null);
  // A counter, not Date.now(): two Publish presses inside the same
  // millisecond would otherwise mint identical tokens, and ContentDrawer's
  // effect keys off the token changing -- the second focus would silently
  // no-op.
  const focusTokenRef = useRef(0);
  const scrollRef = useRef<ScrollView>(null);

  // Step 1 of the editor's own load: getMyStorefront tells apart "this shop
  // has a page, possibly still unpublished" from "this shop has never set
  // one up" (null). Only the latter calls ensureStorefront, which is the one
  // call the storefront module gate (20260924000000's trigger) can refuse --
  // a module error from it must read as the upgrade prompt below, not a
  // crash. A shop that already has a row never risks that call at all.
  const load = useCallback(async () => {
    if (!shopId) return;
    setLoading(true);
    setPlanError(null);
    setLoadError(null);
    try {
      const existing = await getMyStorefront(shopId);
      const row = existing ?? (await ensureStorefront(shopId));
      setLivePublished(editableFieldsOf(row));
      // Overlay: the live row, with any leftover draft from a previous,
      // interrupted session on top. This IS what "your unsaved changes"
      // means the moment the editor opens, with no edit required to surface
      // it (property 5).
      setWorking({ ...row, ...(row.draft ?? {}) });
      setSlugDraft(row.slug ?? '');

      const [areasResult, countResult, flyersResult, promotionsResult] = await Promise.allSettled([
        listDeliveryAreas(shopId),
        countOnlineProducts(shopId),
        listFlyers(shopId),
        // Not even attempted without the module -- a shop that does not have
        // Promotions has no offers to attach, and asking would only produce a
        // refusal to swallow. The picker says so on its own.
        promotionsEnabled ? listPromotions(shopId) : Promise.resolve([] as Promotion[]),
      ]);
      setDeliveryAreas(areasResult.status === 'fulfilled' ? areasResult.value ?? [] : []);
      setOnlineProductCount(countResult.status === 'fulfilled' ? countResult.value ?? 0 : 0);
      setFlyers(flyersResult.status === 'fulfilled' ? flyersResult.value ?? [] : []);
      setPromotions(promotionsResult.status === 'fulfilled' ? promotionsResult.value ?? [] : []);
    } catch (err) {
      const plan = describePlanError(err);
      if (plan) setPlanError(plan);
      else setLoadError(messageOf(err, 'Could not load your storefront. Try again.'));
    } finally {
      setLoading(false);
    }
  }, [shopId, promotionsEnabled]);

  useEffect(() => {
    load();
  }, [load]);

  // The preview's products, read admin-side rather than through the public
  // RPC a customer's browser calls (storefront.ts) -- that RPC deliberately
  // returns nothing until the page is published, which would make the
  // preview show an empty catalogue on exactly the run this screen exists
  // for: a shop's first visit, before it has ever published. Keyed on
  // shopId, not on working.slug -- unlike the public page, this preview is
  // the shop looking at its OWN catalogue and needs no address to do it.
  useEffect(() => {
    if (!shopId) {
      setPreviewProducts([]);
      return;
    }
    let cancelled = false;
    getStorefrontPreviewProducts(shopId)
      .then((products) => {
        if (!cancelled) setPreviewProducts(products ?? []);
      })
      .catch(() => {
        if (!cancelled) setPreviewProducts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [shopId]);

  // Debounced slug availability check as a shopkeeper types -- never fired
  // for the slug already on the row, which is trivially available to them.
  useEffect(() => {
    const trimmed = slugDraft.trim();
    if (!trimmed || trimmed === working?.slug) {
      setSlugState('idle');
      return;
    }
    setSlugState('checking');
    const handle = setTimeout(() => {
      checkSlug(trimmed)
        .then((result) => setSlugState(result ?? 'idle'))
        .catch(() => setSlugState('idle'));
    }, 400);
    return () => clearTimeout(handle);
  }, [slugDraft, working?.slug]);

  // Cancels any pending autosave timer without flushing it -- used on
  // unmount and right before a discard, where sending a now-stale patch
  // would just resurrect the draft the shopkeeper is throwing away.
  function cancelPendingAutosave() {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    pendingDraftPatchRef.current = {};
  }

  // Sends whatever is queued to saveDraft right now, bypassing the debounce.
  // Publish calls this first so the very last keystroke -- typed inside the
  // debounce window, before its own timer fired -- is not left behind on a
  // page that just went live without it. Returns whether the flush actually
  // landed (or there was nothing to flush): Publish must treat `false` as a
  // hard stop, never proceed to publishDraft, or a shop could be told it
  // published a page that in fact shipped without its last edit.
  const flushAutosave = useCallback(async (): Promise<boolean> => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const pending = pendingDraftPatchRef.current;
    if (!shopId || Object.keys(pending).length === 0) return true;
    pendingDraftPatchRef.current = {};
    try {
      await saveDraft(shopId, pending);
      return true;
    } catch {
      // An autosave failing silently would strand real work with nothing on
      // screen to explain it -- put the patch back so the next debounce
      // tick, or Publish's own retry, tries again rather than dropping it.
      pendingDraftPatchRef.current = { ...pending, ...pendingDraftPatchRef.current };
      return false;
    }
  }, [shopId]);

  function queueAutosave(patch: Partial<EditableFields>) {
    pendingDraftPatchRef.current = { ...pendingDraftPatchRef.current, ...patch };
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      flushAutosave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  // Flushes -- never cancels -- any pending autosave on unmount. Task 7b's
  // whole justification for the debounce above is "losing the network or
  // navigating away costs nothing" (AUTOSAVE_DEBOUNCE_MS's own comment);
  // cancelling here instead would silently drop up to AUTOSAVE_DEBOUNCE_MS
  // of typing every time a shopkeeper navigates away mid-pause, the exact
  // hole that property was meant to close. Fire-and-forget: a component that
  // has already unmounted has nowhere left to show a failure, which is the
  // same reason flushAutosave itself re-queues on failure rather than
  // throwing -- the next mount's own autosave (or Publish) gets another try.
  // cancelPendingAutosave is kept for the one place that genuinely wants a
  // discard -- see its own comment below.
  useEffect(() => () => {
    flushAutosave();
  }, [flushAutosave]);

  // Every edit does two things: shows immediately in `working` (and so in
  // the preview), and queues an autosave into the server-side draft. Never a
  // write to a live column -- see saveDraft's own comment for why a
  // read-then-write from here would race two autosaves against each other,
  // and publish_storefront's own comment for the atomic copy that is the
  // only path a live column changes through at all.
  function patchDraft(patch: Partial<EditableFields>) {
    setWorking((w) => (w ? { ...w, ...patch } : w));
    queueAutosave(patch);
  }

  async function handleClaimSlug(rawSlug: string) {
    if (!shopId) return;
    try {
      const claimed = await claimSlug(shopId, rawSlug);
      setWorking((w) => (w ? { ...w, slug: claimed } : w));
      setSlugDraft(claimed);
      setSlugState('idle');
    } catch (err) {
      const message = messageOf(err, '');
      if (message === 'slug_taken') setSlugState('taken');
      else if (message) setSlugState(message as SlugState);
    }
  }

  // A thin wrapper around uploadImage (src/lib/storage.ts) -- the same
  // helper uploadShopLogo uses -- so there remains exactly one upload path
  // in the app. ContentDrawer stays free of every data-layer import; this is
  // the only place that knows the path a hero photo lands at.
  async function handleUploadHeroImage(localUri: string): Promise<string> {
    if (!shopId) throw new Error('No shop to upload for.');
    return uploadImage(`${shopId}/storefront-hero-${Date.now()}`, localUri);
  }

  // The same single upload path again, one directory along -- uploadImage
  // returns an absolute public URL and `storefront_flyers.image_path` stores
  // exactly what it returned (publicImageUrl passes an absolute URL straight
  // back through, which is why no second uploader is needed to produce a
  // bucket path). Timestamped, because uploadImage passes `upsert: false`.
  async function handleUploadFlyerImage(localUri: string): Promise<string> {
    if (!shopId) throw new Error('No shop to upload for.');
    return uploadImage(`${shopId}/storefront-flyer-${Date.now()}`, localUri);
  }

  // None of these four swallow a failure: FlyerEditor catches, and it is what
  // turns the five-per-shop trigger's `flyer_limit_reached` into a sentence.
  // Each refetches rather than patching local state, so the list on screen is
  // the list the database actually holds -- including the positions the
  // trigger or another device may have changed underneath it.
  async function refreshFlyers() {
    if (!shopId) return;
    setFlyers((await listFlyers(shopId)) ?? []);
  }

  async function handleCreateFlyer(fields: FlyerFields) {
    if (!shopId) return;
    // Appended at the end of the shop's own order. The database's `position`
    // has no unique index (20260930000000) so a collision would not be
    // refused -- it would just be an ambiguous order -- which is why this is
    // the list length and not a guess.
    await createFlyer(shopId, { ...fields, position: flyers.length });
    await refreshFlyers();
  }

  async function handleUpdateFlyer(id: string, fields: FlyerFields) {
    await updateFlyer(id, fields);
    await refreshFlyers();
  }

  async function handleDeleteFlyer(id: string) {
    await deleteFlyer(id);
    await refreshFlyers();
  }

  async function handleReorderFlyers(orderedIds: string[]) {
    await reorderFlyers(orderedIds);
    await refreshFlyers();
  }

  // Live, not staged: publish_storefront copies a fixed list of keys out of
  // `draft` and auto_advance is not one of them (see setAutoAdvance's own
  // comment), so a staged value would sit there forever. Written first, then
  // reflected on screen -- a failed write must not leave the switch showing a
  // setting the page does not have.
  async function handleAutoAdvanceChange(on: boolean) {
    if (!shopId) return;
    setPublishError(null);
    try {
      await setAutoAdvance(shopId, on);
      setWorking((w) => (w ? { ...w, autoAdvance: on } : w));
    } catch (err) {
      setPublishError(describePlanError(err) ?? messageOf(err, 'Could not save that setting. Try again.'));
    }
  }

  async function handleSaveArea(area: SavedArea) {
    if (!shopId) return;
    await saveDeliveryArea(shopId, area);
    setDeliveryAreas((await listDeliveryAreas(shopId)) ?? []);
  }

  async function handleDeleteArea(id: string) {
    if (!shopId) return;
    await deleteDeliveryArea(id);
    setDeliveryAreas((await listDeliveryAreas(shopId)) ?? []);
  }

  const blockers: PublishBlocker[] = working
    ? publishBlockers({ slug: working.slug, whatsappE164: working.whatsappE164, onlineProductCount }) ?? []
    : [];

  function focusBlocker(first: PublishBlocker) {
    if (!isWide) setDrawerOpen(true);
    focusTokenRef.current += 1;
    if (first === 'no_slug') setFocusRequest({ field: 'slug', token: focusTokenRef.current });
    else if (first === 'no_whatsapp') setFocusRequest({ field: 'whatsapp', token: focusTokenRef.current });
    // no_products has no field in this drawer to jump to -- PublishBar's own
    // caveat already names the fix (add a product marked to sell online),
    // which lives in Inventory, not here.
  }

  // THE PROPERTY THIS FUNCTION EXISTS FOR: Publish is never disabled
  // (PublishBar's own doc comment), so pressing it with blockers present
  // must not silently no-op -- it opens the drawer and focuses the first
  // one, in the fixed order publishBlockers reports them.
  // publish_storefront (20260925000200) is the one atomic write: it copies
  // the draft into the live columns, sets published_at, and clears the
  // draft, all inside one function body -- a failure partway through cannot
  // leave a new headline live under the old WhatsApp number, or vice versa.
  // flushAutosave runs first so the very last keystroke, still sitting in
  // the debounce window, is in the server's draft before that copy happens
  // -- otherwise a shopkeeper who types and immediately presses Publish
  // would ship everything except their last edit. Its result is checked,
  // not just awaited: a failed flush leaves that last edit sitting only in
  // pendingDraftPatchRef, never in the server's draft, so publishing anyway
  // would copy an older draft live, refetch it as the new truth, and tell
  // the shop it published something it did not -- the edit would then sit
  // orphaned with nothing on screen still asking to be saved. The row is
  // refetched afterward rather than guessed at client-side: it is the one
  // place that actually knows what publish_storefront just did to
  // shops.whatsapp_e164.
  async function handlePublish() {
    if (!shopId || !working) return;
    if (blockers.length > 0) {
      focusBlocker(blockers[0]);
      return;
    }
    setPublishing(true);
    setPublishError(null);
    try {
      const flushed = await flushAutosave();
      if (!flushed) {
        setPublishError('Could not save your last changes. Try again before publishing.');
        return;
      }
      await publishDraft(shopId);
      const fresh = await getMyStorefront(shopId);
      if (fresh) {
        setLivePublished(editableFieldsOf(fresh));
        setWorking({ ...fresh, ...(fresh.draft ?? {}) });
      }
    } catch (err) {
      setPublishError(describePlanError(err) ?? messageOf(err, 'Could not publish. Try again.'));
    } finally {
      setPublishing(false);
    }
  }

  async function handleUnpublish() {
    if (!shopId) return;
    setPublishError(null);
    try {
      await unpublish(shopId);
      setWorking((w) => (w ? { ...w, publishedAt: null } : w));
    } catch (err) {
      setPublishError(describePlanError(err) ?? messageOf(err, 'Could not unpublish. Try again.'));
    }
  }

  // Property 7: discarding a draft is possible and returns the editor to the
  // live page. Cancels any autosave still queued first -- sending a
  // now-stale patch after discardDraft has cleared the column would just
  // resurrect what the shopkeeper is throwing away.
  async function handleDiscardDraft() {
    if (!shopId) return;
    cancelPendingAutosave();
    setPublishError(null);
    try {
      await discardDraft(shopId);
      const fresh = await getMyStorefront(shopId);
      if (fresh) {
        setLivePublished(editableFieldsOf(fresh));
        setWorking({ ...fresh, ...(fresh.draft ?? {}) });
      }
    } catch (err) {
      setPublishError(messageOf(err, 'Could not discard your draft. Try again.'));
    }
  }

  function handleEdit() {
    if (!isWide) setDrawerOpen(true);
  }

  function handleTogglePreview() {
    if (!isWide) scrollRef.current?.scrollToEnd({ animated: true });
  }

  if (!shopId || loading) {
    return (
      <SafeAreaView style={[styles.page, styles.center]}>
        <ActivityIndicator color={theme.bentoInk} />
      </SafeAreaView>
    );
  }

  if (planError) {
    return (
      <SafeAreaView style={styles.page} edges={['bottom', 'left', 'right']}>
        <ScreenHeader title="Storefront" />
        <View style={styles.center}>
          <BentoCard title="Storefront" style={styles.upgradeCard}>
            <Text style={styles.upgradeText}>{planError}</Text>
          </BentoCard>
        </View>
      </SafeAreaView>
    );
  }

  if (loadError || !working) {
    return (
      <SafeAreaView style={styles.page} edges={['bottom', 'left', 'right']}>
        <ScreenHeader title="Storefront" />
        <View style={styles.center}>
          <BentoCard title="Storefront" style={styles.upgradeCard}>
            <Caveat tone="wrong" action={{ label: 'Try again', onPress: load }}>
              {loadError ?? 'Could not load your storefront.'}
            </Caveat>
          </BentoCard>
        </View>
      </SafeAreaView>
    );
  }

  const dirty = livePublished ? !sameEditableFields(editableFieldsOf(working), livePublished) : false;
  const status: 'draft' | 'live' = working.publishedAt === null ? 'draft' : 'live';

  const contentValue: ContentDrawerValue = {
    slug: slugDraft,
    headline: working.headline ?? '',
    about: working.about ?? '',
    heroImageUrl: working.heroImageUrl,
    whatsappE164: working.whatsappE164,
  };

  function handleContentChange(patch: Partial<ContentDrawerValue>) {
    if (Object.prototype.hasOwnProperty.call(patch, 'slug') && patch.slug !== undefined) {
      setSlugDraft(patch.slug);
      return;
    }
    const { headline, about, heroImageUrl, whatsappE164 } = patch;
    patchDraft({
      ...(headline !== undefined && { headline }),
      ...(about !== undefined && { about }),
      ...(heroImageUrl !== undefined && { heroImageUrl }),
      ...(whatsappE164 !== undefined && { whatsappE164 }),
    });
  }

  // Matches get_public_storefront's own left join on shop_locations
  // (is_primary) -- supabase/migrations/20260924000100_storefront_public_read.sql.
  // No primary location is exactly what a LEFT JOIN with no match yields
  // there too, so `null` here is correct, not a fallback.
  const primaryCity = locations.find((location) => location.isPrimary)?.city ?? null;

  // What get_public_storefront (20260930000100) would return for this shop,
  // reproduced client-side for the preview -- the same reason
  // getStorefrontPreviewProducts exists rather than calling the public RPC:
  // that function deliberately returns nothing while `published_at is null`,
  // which is exactly when a shop is looking at this preview for the first
  // time.
  //
  // Both halves of the rule are the SHARED implementation, not a second copy:
  // isPromotionLive (src/lib/discounts.ts, "the one place 'is this offer
  // running right now' is decided") is what the SQL's promotion_is_live was
  // written from, and posterCopyFor (src/lib/poster.ts) is what its wording
  // functions were ported from line for line. Calling them here is what keeps
  // the preview from being a third opinion about one offer.
  const previewFlyers: StorefrontFlyer[] = flyers
    .filter((flyer) => !flyer.draft)
    .map((flyer) => {
      const promotion = flyer.promotionId ? promotions.find((p) => p.id === flyer.promotionId) ?? null : null;
      return { flyer, promotion };
    })
    // An offer that has ended takes its whole panel with it -- the JPEG says
    // 20% OFF in letters nothing here can edit, so stripping the derived line
    // and leaving the picture up would satisfy the letter of "stops claiming
    // a discount" and none of its point. A DELETED promotion is different and
    // already handled: `on delete set null` leaves promotionId null, i.e. a
    // plain announcement.
    .filter(({ flyer, promotion }) => !flyer.promotionId || (promotion !== null && isPromotionLive(promotion)))
    .map(({ flyer, promotion }) => {
      const copy = promotion ? posterCopyFor({ promotion, shopName: shop?.name ?? '' }) : null;
      return {
        id: flyer.id,
        imageUrl: publicImageUrl(flyer.imagePath),
        headline: flyer.headline,
        subline: flyer.subline,
        linkKind: flyer.linkKind,
        linkValue: flyer.linkValue,
        offer: copy ? { value: copy.value, scope: copy.scope, when: copy.when } : null,
      };
    });

  const previewStorefront: PublicStorefront = {
    shopName: shop?.name ?? '',
    city: primaryCity,
    slug: working.slug ?? '',
    whatsappE164: working.whatsappE164,
    theme: working.theme,
    palette: working.palette,
    headline: working.headline,
    about: working.about,
    heroImageUrl: working.heroImageUrl,
    offersDelivery: working.offersDelivery,
    paymentMode: 'on_collection',
    flyers: previewFlyers,
    autoAdvance: working.autoAdvance,
  };

  const contentDrawer = (
    <ContentDrawer
      value={contentValue}
      onChange={handleContentChange}
      onClaimSlug={handleClaimSlug}
      slugState={slugState}
      shopName={shop?.name ?? ''}
      onUploadHeroImage={handleUploadHeroImage}
      focusRequest={focusRequest}
    />
  );

  const strips = (
    <>
      <PublishBar
        status={status}
        blockers={blockers}
        dirty={dirty}
        onEdit={handleEdit}
        onTogglePreview={handleTogglePreview}
        onPublish={handlePublish}
        onUnpublish={handleUnpublish}
      />
      {publishing ? <Caveat tone="context">Publishing your page…</Caveat> : null}
      {publishError ? <Caveat tone="wrong">{publishError}</Caveat> : null}
      {dirty ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Discard unsaved changes"
          testID="storefront-discard-draft"
          onPress={handleDiscardDraft}
          style={styles.discardButton}
        >
          <Text style={styles.discardButtonText}>Discard unsaved changes</Text>
        </Pressable>
      ) : null}

      <DesignStrip
        theme={working.theme}
        palette={working.palette}
        // firstPublishedAt (T3), not publishedAt: publishedAt goes back to
        // null the moment a shop unpublishes, which would resurface "Chosen
        // for you" for a shop that has already published once -- exactly
        // backwards from "once a shop has published, it has chosen".
        // firstPublishedAt is set once, by publish_storefront's own first
        // publish, and unpublish never touches it.
        neverPublished={working.firstPublishedAt === null}
        onThemeChange={(key) => patchDraft({ theme: key })}
        onPaletteChange={(key) => patchDraft({ palette: key })}
      />

      {isWide ? contentDrawer : (
        <BentoCard title="Content">
          <Text style={styles.drawerEntryHint}>Web address, headline, about, photo and WhatsApp number.</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit page content"
            testID="storefront-open-content-drawer"
            onPress={() => setDrawerOpen(true)}
            style={styles.drawerEntryButton}
          >
            <Text style={styles.drawerEntryButtonText}>Edit page content →</Text>
          </Pressable>
        </BentoCard>
      )}

      {/* Below the Content card, above Delivery: a flyer is part of what the
          page SAYS, and the shop's chosen layout (DesignStrip, above) is what
          decides whether flyers show at all -- which is the Counter notice
          this panel carries. Writes here go straight to storefront_flyers and
          each row's own `draft` column decides whether a customer sees it, so
          nothing about flyers travels through the storefront draft or the
          Publish button. */}
      <FlyerEditor
        flyers={flyers}
        theme={working.theme}
        // The picker only ever offers what the till would actually honour
        // right now, through the shared isPromotionLive -- an offer that has
        // ended is not attachable, which is a cheaper way of preventing a
        // page that contradicts the till than detecting it afterwards.
        promotions={promotions.filter((promotion) => isPromotionLive(promotion))}
        promotionsEnabled={promotionsEnabled}
        autoAdvance={working.autoAdvance}
        onAutoAdvanceChange={handleAutoAdvanceChange}
        onUploadImage={handleUploadFlyerImage}
        onCreate={handleCreateFlyer}
        onUpdate={handleUpdateFlyer}
        onDelete={handleDeleteFlyer}
        onReorder={handleReorderFlyers}
      />

      <DeliveryEditor
        offersDelivery={working.offersDelivery}
        areas={deliveryAreas}
        onToggle={(value) => patchDraft({ offersDelivery: value })}
        onSave={handleSaveArea}
        onDelete={handleDeleteArea}
      />
    </>
  );

  const preview = (
    <BentoCard title="Preview" style={styles.previewCard} bodyStyle={styles.previewBody}>
      <Caveat tone="context">
        This shows your unsaved changes. Customers keep seeing the page you last published, until you press Publish
        — except delivery areas, which save straight to your live page as soon as you add or edit them.
      </Caveat>
      <View style={styles.previewFrame}>
        <StorefrontView storefront={previewStorefront} products={previewProducts} />
      </View>
    </BentoCard>
  );

  return (
    <SafeAreaView style={styles.page} edges={['bottom', 'left', 'right']}>
      <ScreenHeader title="Storefront" />
      {isWide ? (
        <ScrollView ref={scrollRef} contentContainerStyle={styles.wideBody}>
          <View style={styles.wideColumn}>{strips}</View>
          <View style={[styles.wideColumn, styles.previewColumn]}>{preview}</View>
        </ScrollView>
      ) : (
        <ScrollView ref={scrollRef} contentContainerStyle={styles.narrowBody}>
          {strips}
          {preview}
        </ScrollView>
      )}

      {!isWide ? (
        <AppModal visible={drawerOpen} animationType="slide" onRequestClose={() => setDrawerOpen(false)}>
          <SafeAreaView style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Page content</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                testID="storefront-close-content-drawer"
                onPress={() => setDrawerOpen(false)}
              >
                <Text style={styles.sheetClose}>Done</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.sheetBody}>{contentDrawer}</ScrollView>
          </SafeAreaView>
        </AppModal>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.bentoPage },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  upgradeCard: { margin: 18, maxWidth: 420 },
  upgradeText: { fontSize: 13.5, lineHeight: 20, color: theme.bentoInk2 },

  narrowBody: { padding: 18, paddingBottom: 60, gap: 14 },
  wideBody: { padding: 18, paddingBottom: 60, flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  wideColumn: { flex: 1, gap: 14, minWidth: 0 },
  previewColumn: { flex: 1 },

  previewCard: { padding: 0 },
  previewBody: { paddingHorizontal: 18, paddingBottom: 18, paddingTop: 4 },
  previewFrame: {
    marginTop: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    overflow: 'hidden',
  },

  drawerEntryHint: { fontSize: 12.5, color: theme.bentoMuted2, marginBottom: 10 },
  drawerEntryButton: { alignSelf: 'flex-start' },
  drawerEntryButtonText: { fontSize: 13, fontWeight: '800', color: theme.bentoAccentInk },

  discardButton: { alignSelf: 'flex-start' },
  discardButtonText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoDownInk },

  sheet: { flex: 1, backgroundColor: theme.bentoPage },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.bentoLine,
  },
  sheetTitle: { fontSize: 16, fontWeight: '800', color: theme.bentoInk },
  sheetClose: { fontSize: 13.5, fontWeight: '800', color: theme.bentoAccentInk },
  sheetBody: { padding: 18, paddingBottom: 60 },
});
