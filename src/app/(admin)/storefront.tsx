import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { ContentDrawer, type ContentDrawerFocusRequest, type ContentDrawerValue, type SlugState } from '@/components/storefront/editor/content-drawer';
import { DeliveryEditor, type SavedArea } from '@/components/storefront/editor/delivery-editor';
import { DesignStrip } from '@/components/storefront/editor/design-strip';
import { PublishBar } from '@/components/storefront/editor/publish-bar';
import { StorefrontView } from '@/components/storefront/storefront-view';
import { AppModal } from '@/components/ui/app-modal';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { describePlanError } from '@/lib/entitlements';
import { getPublicStorefrontProducts } from '@/lib/storefront';
import { uploadImage } from '@/lib/storage';
import {
  checkSlug,
  claimSlug,
  countOnlineProducts,
  deleteDeliveryArea,
  ensureStorefront,
  getMyStorefront,
  listDeliveryAreas,
  publishBlockers,
  saveDeliveryArea,
  saveStorefront,
  setPublished,
  type DeliveryArea,
  type PublishBlocker,
  type ShopStorefront,
} from '@/lib/storefront-admin';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

// Pinned to the light palette -- no dark mode yet, same as every other bento
// admin screen. The PREVIEW below is exempt: it renders the shop's own
// palette, whatever that is.
const theme = Colors.light;

// The fields a shopkeeper can edit before Publish. Everything here is staged
// entirely in memory and only reaches `saveStorefront` as part of a publish
// attempt -- see the comment on `handlePublish` for why: `storefronts` has
// no separate draft/live copy, so a write-on-every-keystroke would leak an
// unsaved edit onto a page customers are already looking at.
type EditableFields = Pick<
  ShopStorefront,
  'theme' | 'palette' | 'headline' | 'about' | 'heroImageUrl' | 'offersDelivery' | 'whatsappE164'
>;

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
  const { shop } = useAuth();
  const shopId = shop?.id ?? null;
  const { width } = useWindowDimensions();
  const isWide = width >= TABLET_BREAKPOINT;

  const [loading, setLoading] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // `draft` is what's on screen, edited freely. `saved` is the last state
  // actually written to the database (on load, and again after every
  // successful publish) -- comparing the two is the only source `dirty`
  // needs, and it is never anything saveStorefront itself computes.
  const [draft, setDraft] = useState<ShopStorefront | null>(null);
  const [saved, setSaved] = useState<EditableFields | null>(null);

  const [slugDraft, setSlugDraft] = useState('');
  const [slugState, setSlugState] = useState<SlugState>('idle');

  const [deliveryAreas, setDeliveryAreas] = useState<DeliveryArea[]>([]);
  const [onlineProductCount, setOnlineProductCount] = useState(0);
  const [previewProducts, setPreviewProducts] = useState<StorefrontProduct[]>([]);

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState<ContentDrawerFocusRequest | null>(null);
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
      setDraft(row);
      setSaved(editableFieldsOf(row));
      setSlugDraft(row.slug ?? '');

      const [areasResult, countResult] = await Promise.allSettled([
        listDeliveryAreas(shopId),
        countOnlineProducts(shopId),
      ]);
      setDeliveryAreas(areasResult.status === 'fulfilled' ? areasResult.value ?? [] : []);
      setOnlineProductCount(countResult.status === 'fulfilled' ? countResult.value ?? 0 : 0);
    } catch (err) {
      const plan = describePlanError(err);
      if (plan) setPlanError(plan);
      else setLoadError(messageOf(err, 'Could not load your storefront. Try again.'));
    } finally {
      setLoading(false);
    }
  }, [shopId]);

  useEffect(() => {
    load();
  }, [load]);

  // The preview's products, straight from the same RPC a customer's browser
  // calls -- see storefront.ts. No second products query exists in this
  // file: this is the only place the editor asks what a customer would see.
  useEffect(() => {
    const slug = draft?.slug;
    if (!slug) {
      setPreviewProducts([]);
      return;
    }
    let cancelled = false;
    getPublicStorefrontProducts(slug)
      .then((products) => {
        if (!cancelled) setPreviewProducts(products ?? []);
      })
      .catch(() => {
        if (!cancelled) setPreviewProducts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [draft?.slug]);

  // Debounced slug availability check as a shopkeeper types -- never fired
  // for the slug already on the row, which is trivially available to them.
  useEffect(() => {
    const trimmed = slugDraft.trim();
    if (!trimmed || trimmed === draft?.slug) {
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
  }, [slugDraft, draft?.slug]);

  function patchDraft(patch: Partial<EditableFields>) {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }

  async function handleClaimSlug(rawSlug: string) {
    if (!shopId) return;
    try {
      const claimed = await claimSlug(shopId, rawSlug);
      setDraft((d) => (d ? { ...d, slug: claimed } : d));
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

  const blockers: PublishBlocker[] = draft
    ? publishBlockers({ slug: draft.slug, whatsappE164: draft.whatsappE164, onlineProductCount }) ?? []
    : [];

  function focusBlocker(first: PublishBlocker) {
    if (!isWide) setDrawerOpen(true);
    if (first === 'no_slug') setFocusRequest({ field: 'slug', token: Date.now() });
    else if (first === 'no_whatsapp') setFocusRequest({ field: 'whatsapp', token: Date.now() });
    // no_products has no field in this drawer to jump to -- PublishBar's own
    // caveat already names the fix (add a product marked to sell online),
    // which lives in Inventory, not here.
  }

  // THE PROPERTY THIS FUNCTION EXISTS FOR: Publish is never disabled
  // (PublishBar's own doc comment), so pressing it with blockers present
  // must not silently no-op -- it opens the drawer and focuses the first
  // one, in the fixed order publishBlockers reports them.
  async function handlePublish() {
    if (!shopId || !draft) return;
    if (blockers.length > 0) {
      focusBlocker(blockers[0]);
      return;
    }
    setPublishing(true);
    setPublishError(null);
    try {
      const patch = editableFieldsOf(draft);
      await saveStorefront(shopId, patch);
      await setPublished(shopId, true);
      setSaved(patch);
      setDraft((d) => (d ? { ...d, publishedAt: new Date().toISOString() } : d));
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
      await setPublished(shopId, false);
      setDraft((d) => (d ? { ...d, publishedAt: null } : d));
    } catch (err) {
      setPublishError(describePlanError(err) ?? messageOf(err, 'Could not unpublish. Try again.'));
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

  if (loadError || !draft) {
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

  const dirty = saved ? !sameEditableFields(editableFieldsOf(draft), saved) : false;
  const status: 'draft' | 'live' = draft.publishedAt === null ? 'draft' : 'live';

  const contentValue: ContentDrawerValue = {
    slug: slugDraft,
    headline: draft.headline ?? '',
    about: draft.about ?? '',
    heroImageUrl: draft.heroImageUrl,
    whatsappE164: draft.whatsappE164,
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

  const previewStorefront: PublicStorefront = {
    shopName: shop?.name ?? '',
    city: null,
    slug: draft.slug ?? '',
    whatsappE164: draft.whatsappE164,
    theme: draft.theme,
    palette: draft.palette,
    headline: draft.headline,
    about: draft.about,
    heroImageUrl: draft.heroImageUrl,
    offersDelivery: draft.offersDelivery,
    paymentMode: 'on_collection',
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

      <DesignStrip
        theme={draft.theme}
        palette={draft.palette}
        neverPublished={draft.publishedAt === null}
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

      <DeliveryEditor
        offersDelivery={draft.offersDelivery}
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
        This shows your unsaved changes. Customers keep seeing the page you last published, until you press Publish.
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
