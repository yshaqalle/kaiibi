import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { withModuleWall } from '@/components/module-wall';
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
  isValidTradingSince,
  addGalleryImage,
  listGalleryImages,
  normalizeInstagram,
  setInstagram,
  listHighlights,
  removeGalleryImage,
  replaceHighlights,
  type ShopImage,
  setTradingSince,
  getStorefrontPreviewCategories,
  getStorefrontPreviewProducts,
  listAddressSuffixSuggestions,
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
import type {
  Promotion, PublicStorefront, StorefrontCategory, StorefrontFlyer, StorefrontHighlight,
  StorefrontProduct,
} from '@/types/models';

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

function StorefrontEditor() {
  const { shop, locations, hasModule } = useAuth();
  const router = useRouter();
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
  // Live-saving children, like the delivery areas: held here so the preview
  // renders exactly what the published page will.
  const [highlights, setHighlights] = useState<StorefrontHighlight[]>([]);
  // What is IN the three boxes, which is not the same as what is saved: a
  // half-typed card is a legitimate state and must not be written or dropped.
  const [draftHighlights, setDraftHighlights] = useState<{ title: string; body: string }[]>([]);
  const [gallery, setGallery] = useState<ShopImage[]>([]);
  // A string, not a number -- "20" on the way to "2014" must survive being
  // typed. Parsed on save, never on keystroke.
  const [tradingSinceText, setTradingSinceText] = useState('');
  const [instagramText, setInstagramText] = useState('');
  const pendingHandleRef = useRef<string | null | undefined>(undefined);
  const handleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tradingSinceError, setTradingSinceError] = useState<string | null>(null);
  const [highlightsError, setHighlightsError] = useState<string | null>(null);
  const pendingHighlightsRef = useRef<{ title: string; body: string }[] | null>(null);
  const highlightsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightsInFlightRef = useRef<Promise<void>>(Promise.resolve());
  const pendingYearRef = useRef<number | null | undefined>(undefined);
  const yearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [livePublished, setLivePublished] = useState<EditableFields | null>(null);

  // Patches not yet sent to saveDraft, and the timer that will flush them.
  // Refs, not state: queuing an autosave must never itself trigger a
  // re-render, and flushAutosave needs the latest pending patch synchronously
  // (from handlePublish, from unmount) rather than through a stale closure.
  const pendingDraftPatchRef = useRef<Partial<EditableFields>>({});
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [slugDraft, setSlugDraft] = useState('');
  const [slugState, setSlugState] = useState<SlugState>('idle');

  // The endings offered when a shop's derived address is already taken --
  // its own neighbourhood, then its city. Read here rather than from
  // useAuth().locations so it resolves the SAME primary location the rest of
  // the data layer does (primary first, then oldest), and so "the shop's
  // location" has one meaning across this app, not two.
  const [addressSuffixes, setAddressSuffixes] = useState<string[]>([]);

  const [deliveryAreas, setDeliveryAreas] = useState<DeliveryArea[]>([]);
  const [onlineProductCount, setOnlineProductCount] = useState(0);
  const [previewProducts, setPreviewProducts] = useState<StorefrontProduct[]>([]);
  const [previewCategories, setPreviewCategories] = useState<StorefrontCategory[]>([]);
  const [flyers, setFlyers] = useState<ShopFlyer[]>([]);
  // EVERY unarchived promotion, not only the running ones. The picker offers
  // only what is running (below), but the preview needs the whole list to
  // tell "this flyer's offer has ended" (drop the panel, exactly as
  // get_public_storefront does) apart from "this flyer never had one".
  const [promotions, setPromotions] = useState<Promotion[]>([]);

  const [publishing, setPublishing] = useState(false);
  // A write that did not land, and the thing that makes it again.
  //
  // The retry travels WITH the sentence because four operations report through
  // this one caveat -- publish, unpublish, discard, auto-advance -- and it is
  // drawn `tone="wrong"`, which on this project always carries an action that
  // removes its CAUSE (components/ui/caveat.tsx). The cause is the failed
  // write, so the only honest action is that same write again, and "Try again"
  // has to retry the one that actually failed: retrying a PUBLISH after a
  // failed unpublish would put the page back up, the opposite of what the shop
  // asked for. A dismiss would be worse than nothing -- it hides the fact that
  // the page is not in the state the shop just asked for.
  const [publishError, setPublishError] = useState<{ message: string; retry: () => void } | null>(null);

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
      if (existing?.tradingSince) setTradingSinceText(String(existing.tradingSince));
      if (existing?.instagram) setInstagramText(existing.instagram);
      // `.catch(() => [])` for the same reason the public route does it on
      // areas and categories: highlights are an optional block, and a blip on
      // this read must cost the block, not the whole editor.
      // Wrapped rather than chained off the call. `.then()` on the RESULT
      // assumes the call returned a promise, and the whole editor goes down
      // with a TypeError if it ever does not -- which is exactly what a
      // partial module mock does, and what a client running ahead of a
      // deployed lib would do too. Highlights are an optional block; a blip
      // here must cost the block, never the page.
      void (async () => {
        try {
          const images = await listGalleryImages(shopId);
          // Shape-checked, not just try/caught. `await undefined` resolves
          // rather than throwing, so a call that returns nothing -- a partial
          // module mock, a client ahead of its lib -- would sail past the catch
          // and store `undefined`, and the crash would land at render, far from
          // the cause. This is the same defect the highlights load had.
          setGallery(Array.isArray(images) ? images : []);
        } catch {
          setGallery([]);
        }
      })();
      void (async () => {
        try {
          const rows = await listHighlights(shopId);
          const safe = Array.isArray(rows) ? rows : [];
          setHighlights(safe);
          setDraftHighlights(safe.map((row) => ({ title: row.title, body: row.body })));
        } catch {
          setHighlights([]);
        }
      })();
      const row = existing ?? (await ensureStorefront(shopId));
      setLivePublished(editableFieldsOf(row));
      // Overlay: the live row, with any leftover draft from a previous,
      // interrupted session on top. This IS what "your unsaved changes"
      // means the moment the editor opens, with no edit required to surface
      // it (property 5).
      setWorking({ ...row, ...(row.draft ?? {}) });
      setSlugDraft(row.slug ?? '');

      const [areasResult, countResult, suffixResult, flyersResult, promotionsResult] = await Promise.allSettled([
        listDeliveryAreas(shopId),
        countOnlineProducts(shopId),
        listAddressSuffixSuggestions(shopId),
        listFlyers(shopId),
        // Not even attempted without the module -- a shop that does not have
        // Promotions has no offers to attach, and asking would only produce a
        // refusal to swallow. The picker says so on its own.
        promotionsEnabled ? listPromotions(shopId) : Promise.resolve([] as Promotion[]),
      ]);
      setDeliveryAreas(areasResult.status === 'fulfilled' ? areasResult.value ?? [] : []);
      setOnlineProductCount(countResult.status === 'fulfilled' ? countResult.value ?? 0 : 0);
      // Settled beside the others, and empty when it fails: a shop whose
      // location could not be read is offered no ending rather than a
      // number, which is the one thing this must never invent.
      setAddressSuffixes(suffixResult.status === 'fulfilled' ? suffixResult.value ?? [] : []);
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
    // The band, read the same admin-side way and for the same reason -- see
    // getStorefrontPreviewCategories. Its own catch: the band is a navigation
    // aid, so losing it must not blank the preview's catalogue alongside it.
    getStorefrontPreviewCategories(shopId)
      .then((categories) => {
        if (!cancelled) setPreviewCategories(categories ?? []);
      })
      .catch(() => {
        if (!cancelled) setPreviewCategories([]);
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
    // `cancelled`, not just clearTimeout. Once checkSlug is in flight the
    // timer is already spent, so clearing it stops nothing -- and a verdict
    // that lands after the shopkeeper has typed on is a verdict about a
    // string that is no longer in the field.
    //
    // That is not a cosmetic staleness. ContentDrawer freezes a collision
    // base off `value.slug` the moment it sees 'taken', so a late 'taken'
    // for "xamdi" arriving while the field reads "xamdi-electronics" would
    // freeze the LONGER value as the base and open a suffix field under it --
    // walking the shop into an address it was never told was taken.
    let cancelled = false;
    const handle = setTimeout(() => {
      checkSlug(trimmed)
        .then((result) => {
          if (!cancelled) setSlugState(result ?? 'idle');
        })
        .catch(() => {
          if (!cancelled) setSlugState('idle');
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
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

  // The two live-saving fields flush on unmount too, and for the identical
  // reason: cancelling instead would silently drop up to AUTOSAVE_DEBOUNCE_MS
  // of typing every time a shopkeeper closes the drawer mid-pause.
  //
  // Through a ref rather than a dependency array, and rather than a disable
  // comment: the flushers close over fresh state every render, so listing them
  // as deps would tear down and re-create the unmount effect on every
  // keystroke, and suppressing the warning would just hide that. The ref is
  // reassigned each render and read once, at unmount, when it holds the latest.
  const flushLiveFieldsRef = useRef<() => void>(() => {});
  flushLiveFieldsRef.current = () => {
    void flushHighlights();
    void flushYear();
    void flushHandle();
  };
  useEffect(() => () => flushLiveFieldsRef.current(), []);

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
  // Uploaded to the same bucket and the same per-shop prefix as the hero and
  // the flyers, timestamped because uploadImage passes `upsert: false`.
  async function handleAddGalleryImage(localUri: string): Promise<void> {
    if (!shopId) throw new Error('No shop to upload for.');
    const path = await uploadImage(`${shopId}/storefront-gallery-${Date.now()}`, localUri);
    await addGalleryImage(shopId, path);
    setGallery(await listGalleryImages(shopId));
  }

  async function handleRemoveGalleryImage(id: string) {
    if (!shopId) return;
    const image = gallery.find((item) => item.id === id);
    if (!image) return;
    await removeGalleryImage(shopId, image);
    setGallery(await listGalleryImages(shopId));
  }

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
      setPublishError({
        message: describePlanError(err) ?? messageOf(err, 'Could not save that setting. Try again.'),
        retry: () => handleAutoAdvanceChange(on),
      });
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
    // no_products has no field in this drawer to jump to: the fix is a product
    // marked to sell online, which is added in Inventory. Its caveat carries
    // its own "Go to Inventory" action (handleGoToInventory below) rather than
    // this one, because a press on Publish should not throw the shopkeeper off
    // the screen they are editing -- a press on the caveat that names the
    // destination should.
  }

  // Where the no_products blocker's fix actually lives. Pushed, not replaced,
  // so the back gesture returns to the half-finished page they were editing.
  //
  // To the FILTERED list, not the bare screen. Unfiltered Inventory says
  // nothing about selling online anywhere on it, so the old `/inventory` push
  // landed a shopkeeper who had just been told "Add at least one product marked
  // to sell online" on a screen with no visible trace of that idea -- the fix
  // was a toggle inside a product, below Expiry Date and Batch Number.
  // `notonline` is the actionable half of the pair: it is precisely the set of
  // products that still need marking, and the chip it activates names the
  // blocker's own word on arrival. Object form, matching the Dashboard's
  // `?filter=low` and `?filter=nocost` links into the same screen.
  function handleGoToInventory() {
    router.push({ pathname: '/inventory', params: { filter: 'notonline' } });
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
        setPublishError({ message: 'Could not save your last changes. Try again before publishing.', retry: handlePublish });
        return;
      }
      await publishDraft(shopId);
      const fresh = await getMyStorefront(shopId);
      if (fresh) {
        setLivePublished(editableFieldsOf(fresh));
        setWorking({ ...fresh, ...(fresh.draft ?? {}) });
      }
    } catch (err) {
      setPublishError({ message: describePlanError(err) ?? messageOf(err, 'Could not publish. Try again.'), retry: handlePublish });
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
      setPublishError({ message: describePlanError(err) ?? messageOf(err, 'Could not unpublish. Try again.'), retry: handleUnpublish });
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
      setPublishError({ message: messageOf(err, 'Could not discard your draft. Try again.'), retry: handleDiscardDraft });
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
  // Off the SAME row as primaryCity, on purpose: a preview whose town and
  // whose street address came from two different branches would be showing
  // the owner something the public page can never produce. Null for a shop
  // that has not filled the optional address field in, which is most of them
  // -- and null is what the live page gets in that case too, so the preview
  // is honest about the line being absent rather than inventing one.
  const primaryAddress = locations.find((location) => location.isPrimary)?.address ?? null;
  // And the neighbourhood off that same row, for the same reason. This is the
  // one of the two the owner is most likely to actually have -- it is written
  // for every shop at signup -- so a preview without it would show the owner a
  // pick-up line noticeably barer than the one their customers get.
  const primaryNeighborhood = locations.find((location) => location.isPrimary)?.neighborhood ?? null;
  // Off the SAME row again, for the same reason: the preview must show the
  // hours of the branch whose street it is already printing. `?? {}` because a
  // shop that has never opened Settings -> Locations has none, and the panel
  // renders nothing rather than "closed all week".
  const primaryHours = locations.find((location) => location.isPrimary)?.openingHours ?? {};

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
  // written from, and the WORDING is not done here at all -- the preview hands
  // FlyerCarousel the promotion's raw facts, exactly as get_public_storefront
  // now does (20260930000300), and the band words them through offerCopyFor.
  // One derivation for the preview, the public page and the printed poster,
  // rather than three opinions about one offer.
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
    .map(({ flyer, promotion }) => ({
      id: flyer.id,
      imageUrl: publicImageUrl(flyer.imagePath),
      headline: flyer.headline,
      subline: flyer.subline,
      linkKind: flyer.linkKind,
      linkValue: flyer.linkValue,
      offer: promotion ? {
        discountType: promotion.discountType,
        discountValue: promotion.discountValue,
        scope: promotion.scope,
        scopeValue: promotion.scopeValue,
        startsAt: promotion.startsAt,
        endsAt: promotion.endsAt,
      } : null,
    }));

  // WRITTEN THROUGH on change, because this drawer has no Save button -- every
  // other field in it stages into `draft` and is published later, and these two
  // cannot (see storefront-admin.ts). The alternative is a shop typing three
  // cards, closing the drawer, and losing them.
  // SERIALISED, because replaceHighlights deletes every row and re-inserts:
  // two of those overlapping is a delete landing between another call's delete
  // and insert, which is how a shop ends up with rows it did not ask for or
  // none at all. The ref holds the in-flight promise and each call waits for
  // it, so the writes queue rather than race.
  async function flushHighlights() {
    if (!shopId) return;
    const next = pendingHighlightsRef.current;
    if (!next) return;
    pendingHighlightsRef.current = null;
    const run = async () => {
      try {
        await replaceHighlights(shopId, next);
        const rows = await listHighlights(shopId);
        setHighlights(Array.isArray(rows) ? rows : []);
        setHighlightsError(null);
      } catch {
        // NAMED, not swallowed. The old empty catch meant a shop could type
        // three cards, see them in the preview, and have none of it on the live
        // page with nothing on screen saying so.
        setHighlightsError('Could not save that — check your connection and try again.');
      }
    };
    highlightsInFlightRef.current = highlightsInFlightRef.current.then(run, run);
    await highlightsInFlightRef.current;
  }

  // DEBOUNCED, and the write is OUT of the setState updater.
  //
  // This used to call commitHighlights from inside the updater, on every
  // keystroke. Three things were wrong with that and they compound: an updater
  // must be pure (StrictMode double-invokes it, so every keystroke fired the
  // write twice), replaceHighlights is a non-atomic DELETE-all + INSERT, and
  // nothing serialised the calls -- so overlapping requests raced, some hit the
  // `enforce_highlight_limit` trigger against rows another call had not yet
  // deleted, and the error went into an empty catch while the live page kept
  // older text.
  //
  // Now it queues the same way every other field in this editor does, on the
  // same 800ms pause, and commitHighlights itself serialises.
  function handleChangeHighlight(index: number, patch: { title?: string; body?: string }) {
    const next = [0, 1, 2].map((i) => draftHighlights[i] ?? { title: '', body: '' });
    next[index] = { ...next[index], ...patch };
    setDraftHighlights(next);
    queueHighlights(next);
  }

  function queueHighlights(next: { title: string; body: string }[]) {
    pendingHighlightsRef.current = next;
    if (highlightsTimerRef.current) clearTimeout(highlightsTimerRef.current);
    highlightsTimerRef.current = setTimeout(() => { void flushHighlights(); }, AUTOSAVE_DEBOUNCE_MS);
  }

  function handleChangeTradingSince(text: string) {
    // Digits only, so a stray letter never reaches the parse below.
    const digits = text.replace(/[^0-9]/g, '').slice(0, 4);
    setTradingSinceText(digits);
    if (digits.length === 0) {
      setTradingSinceError(null);
      queueYear(null);
      return;
    }
    // Only a complete four-digit year is worth validating: "20" is on its way
    // to "2014", and complaining about it mid-word is the editor arguing with
    // somebody who is still typing.
    if (digits.length < 4) { setTradingSinceError(null); return; }
    const year = Number(digits);
    if (!isValidTradingSince(year)) {
      setTradingSinceError('That year looks wrong — check it and try again.');
      return;
    }
    setTradingSinceError(null);
    queueYear(year);
  }

  // Normalised on SAVE, not on keystroke: stripping the @ as somebody types it
  // deletes the character under their cursor.
  function handleChangeInstagram(text: string) {
    setInstagramText(text);
    pendingHandleRef.current = normalizeInstagram(text);
    if (handleTimerRef.current) clearTimeout(handleTimerRef.current);
    handleTimerRef.current = setTimeout(() => { void flushHandle(); }, AUTOSAVE_DEBOUNCE_MS);
  }

  async function flushHandle() {
    const handle = pendingHandleRef.current;
    if (!shopId || handle === undefined) return;
    pendingHandleRef.current = undefined;
    try {
      await setInstagram(shopId, handle);
      setWorking((w) => (w ? { ...w, instagram: handle } : w));
    } catch {
      setTradingSinceError('Could not save that — check your connection and try again.');
    }
  }

  // Same debounce as the highlights and the draft: a four-digit year typed one
  // digit at a time is one save, not four.
  function queueYear(year: number | null) {
    pendingYearRef.current = year;
    if (yearTimerRef.current) clearTimeout(yearTimerRef.current);
    yearTimerRef.current = setTimeout(() => { void flushYear(); }, AUTOSAVE_DEBOUNCE_MS);
  }

  async function flushYear() {
    const year = pendingYearRef.current;
    if (!shopId || year === undefined) return;
    pendingYearRef.current = undefined;
    try {
      await setTradingSince(shopId, year);
      setWorking((w) => (w ? { ...w, tradingSince: year } : w));
    } catch {
      setTradingSinceError('Could not save that — check your connection and try again.');
    }
  }

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
    collectAddress: primaryAddress,
    collectNeighborhood: primaryNeighborhood,
    openingHours: primaryHours,
    // Both save LIVE rather than through `draft` (see the migration on why),
    // so the preview reads the same rows the published page will.
    // Off the same primary location the preview already reads its address and
    // hours from, so the preview and the published page name one branch.
    contactPhone: locations.find((location) => location.isPrimary)?.contactPhone ?? null,
    instagram: working?.instagram ?? null,
    tradingSince: working?.tradingSince ?? null,
    highlights,
    // Resolved for the preview the same way the public reader resolves them,
    // so the editor shows what a customer will see rather than a bucket path.
    images: gallery.map((image) => ({ id: image.id, url: publicImageUrl(image.imagePath) }))
      .filter((image) => image.url !== null),
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
      claimedSlug={working.slug}
      suffixSuggestions={addressSuffixes}
      onUploadHeroImage={handleUploadHeroImage}
      focusRequest={focusRequest}
        tradingSince={tradingSinceText}
        tradingSinceError={tradingSinceError ?? highlightsError}
        onChangeTradingSince={handleChangeTradingSince}
        highlights={draftHighlights}
        onChangeHighlight={handleChangeHighlight}
        instagram={instagramText}
        onChangeInstagram={handleChangeInstagram}
        gallery={gallery.map((image) => ({ id: image.id, url: publicImageUrl(image.imagePath) ?? '' }))}
        onAddGalleryImage={handleAddGalleryImage}
        onRemoveGalleryImage={handleRemoveGalleryImage}
    />
  );

  const strips = (
    <>
      <PublishBar
        status={status}
        // The bar renders Preview/Edit only on the stacked layout, where they
        // have somewhere to go -- see its own note on this prop.
        isWide={isWide}
        blockers={blockers}
        dirty={dirty}
        // The CLAIMED address, not the draft one being typed in the drawer:
        // this is the address that actually resolves, and it is only shown
        // once the page is live.
        slug={working.slug}
        shopName={shop?.name ?? ''}
        // WHY the page is a draft, when the shop did not choose that. Set by
        // the 20260930000500 trigger when a shop comes back out of a dark
        // state, cleared by publish_storefront -- so this goes null the moment
        // the shop publishes, and the sentence never outlives its cause.
        //
        // The CAUSE goes down, not a boolean: a lapse and a suspension both
        // land here and the editor says a different thing for each, because
        // telling a shop that paid on time that its plan lapsed is untrue.
        unpublishedBy={working.lapseUnpublishedReason}
        onEdit={handleEdit}
        onFocusBlocker={focusBlocker}
        onGoToInventory={handleGoToInventory}
        onTogglePreview={handleTogglePreview}
        onPublish={handlePublish}
        onUnpublish={handleUnpublish}
      />
      {publishing ? <Caveat tone="context">Publishing your page…</Caveat> : null}
      {publishError ? (
        <Caveat tone="wrong" action={{ label: 'Try again', onPress: publishError.retry }}>
          {publishError.message}
        </Caveat>
      ) : null}
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
        <StorefrontView
          storefront={previewStorefront}
          products={previewProducts}
          categories={previewCategories}
        />
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

// Same wall, and it brings a `ScreenHeader` because this screen is pushed over
// the admin shell rather than living inside it -- without one, a walled screen
// would have no Back and no Home. See components/module-wall.tsx.
export default withModuleWall('storefront', StorefrontEditor, { title: 'Storefront' });
