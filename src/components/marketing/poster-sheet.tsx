import { useEffect, useMemo, useRef, useState } from 'react';
import { PixelRatio, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { ColorPicker } from '@/components/color-picker';
import { PosterCanvas, POSTER_SHAPES, type PosterShape, type PosterTemplate, type PosterWeekOffer } from '@/components/marketing/poster-canvas';
import { capturePosterPng, POSTER_EXPORT_SUPPORTED, posterPdfFromPngDataUri, posterPngDataUri, sharePoster } from '@/components/marketing/poster-export';
import { AppModal } from '@/components/ui/app-modal';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { isPromotionLive } from '@/lib/discounts';
import { posterCopyFor, type PosterCopy } from '@/lib/poster';
import { formatTodayHours } from '@/lib/receipt';
import { updateShop } from '@/lib/shops';
import type { Promotion, ShopLocation } from '@/types/models';

// Pinned to the light palette for now -- no dark-mode switching yet, same as
// promotions-tab.tsx.
const theme = Colors.light;

// Falls back to the mockup's own default swatch when a shop hasn't set a
// brand colour yet -- the poster still needs SOME starting colour to preview,
// and this is the same purple the mockup opens on
// (docs/design/promotion-poster-mockup.html).
const DEFAULT_BRAND_COLOR = '#5b31b5';

const TEMPLATES: { key: PosterTemplate; label: string }[] = [
  { key: 'bold', label: 'Bold' },
  { key: 'market', label: 'Market' },
  { key: 'quiet', label: 'Quiet' },
  { key: 'week', label: 'This week' },
];

// Export target widths in PHYSICAL pixels, matching the numbers poster-
// canvas.tsx's own header comment names ("1080px, 1240px, whatever the shape
// needs"): 1080 is the standard feed/story export width, 1240 is A4 at
// 150dpi (210mm), enough to read crisp when printed.
const EXPORT_WIDTH_PX: Record<PosterShape, number> = { square: 1080, story: 1080, sheet: 1240 };

const HEADLINE_MAX = 28;

// Supabase rpc()/query errors are plain {code, details, hint, message}
// objects, never instanceof Error -- see the identical comment in
// promotions-tab.tsx.
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

// The location's own address block, joined the same way location-switcher.tsx
// and the locations panel already do -- "123 Main · Sooq Bakaaro · Hargeisa",
// dropping whichever parts are unset, null when there is nothing at all.
function addressFor(location: ShopLocation | null): string | null {
  if (!location) return null;
  const parts = [location.address, location.neighborhood, location.city].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(' · ') : null;
}

// A promotion becomes a poster: pick a template, a shape and a colour, see it
// live, then save or share it. Opened from promotions-tab.tsx's detail pane
// for an existing promotion -- mounted only while open, like
// CloseRegisterSheet, so every field below initialises fresh each time.
export function PosterSheet({
  promotion,
  promotions,
  onClose,
}: {
  promotion: Promotion;
  // Every promotion the shop has, not just this one -- the `week` template
  // needs to look past the promotion it was opened from at whatever else is
  // currently live. promotions-tab.tsx already holds this list; fetching it
  // again here would be a second round trip for data the parent already has.
  promotions: Promotion[];
  onClose: () => void;
}) {
  const { shop, activeLocation, hasModule, refreshShop } = useAuth();

  const [template, setTemplate] = useState<PosterTemplate>('bold');
  const [shape, setShape] = useState<PosterShape>('square');
  const [color, setColor] = useState(shop?.brandColor ?? DEFAULT_BRAND_COLOR);
  const [headline, setHeadline] = useState('');
  const [showDates, setShowDates] = useState(true);
  const [showBranch, setShowBranch] = useState(true);
  const [showHours, setShowHours] = useState(true);
  const [showPhone, setShowPhone] = useState(true);

  // The mark toggle only EXISTS on a plan that grants branding removal --
  // otherwise the mark is on and there is no control for it at all, exactly
  // how receipts already treat `receipt_branding_removal` (see pos.tsx's
  // `showKaiibiBranding`). `markOff` is only ever read while that module is
  // granted; on every other plan `showMark` below is unconditionally true.
  const canToggleMark = hasModule('receipt_branding_removal');
  const [markOff, setMarkOff] = useState(false);
  const showMark = !(canToggleMark && markOff);

  const [previewWidth, setPreviewWidth] = useState(280);
  const captureRef = useRef<View>(null);

  const [busy, setBusy] = useState<'png' | 'pdf' | 'share' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [colorError, setColorError] = useState<string | null>(null);

  // A snapshot, not a clock -- taken once, on mount, rather than read live
  // inside the memo below, which would call an impure function from a render
  // path. Same pattern as `now` in promotions-tab.tsx; good enough here too,
  // since this sheet isn't a countdown and a promotion's window crossing a
  // boundary while it sits open is not a case worth a ticking clock for.
  const [now] = useState(() => Date.now());

  // Persists the shop's brand colour once picking settles, not on every pixel
  // of a slider drag -- a drag can call onChange dozens of times a second, and
  // a write per frame would be both wasteful and a losing race against itself.
  // Debounced rather than tied to a Save button: the brief asks for the choice
  // to "stick" on its own, the same way the picker has no separate confirm
  // step either.
  //
  // The pending write is stashed in a ref, not just a local `setTimeout`
  // handle, so the mount-only effect below can flush it. That split matters:
  // this effect's own cleanup runs on every `color` change (that is what
  // makes it a debounce -- each keystroke cancels the last timer and starts a
  // new one), so flushing HERE would fire a write per drag step, defeating
  // the debounce entirely. Only a cleanup that runs exactly once, on unmount,
  // may safely commit whatever is still outstanding.
  const pendingColorWrite = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!shop) return;
    const saved = shop.brandColor ?? DEFAULT_BRAND_COLOR;
    if (color === saved) {
      pendingColorWrite.current = null;
      return;
    }
    const commit = () => {
      pendingColorWrite.current = null;
      updateShop(shop.id, { brandColor: color })
        .then(() => refreshShop())
        .catch((err) => setColorError(extractErrorMessage(err, "Couldn't save that colour.")));
    };
    pendingColorWrite.current = commit;
    const handle = setTimeout(commit, 500);
    return () => clearTimeout(handle);
  }, [color, shop, refreshShop]);

  // Flushes a still-pending colour write on unmount. The sheet unmounts the
  // instant it closes (see the header comment on PosterSheet), and without
  // this an owner who drags to their exact shade and immediately taps Close
  // would have that debounced write silently cancelled -- no Save button, no
  // error, the colour just never lands. Deliberately its own effect with an
  // empty dependency array: its cleanup fires exactly once, on unmount,
  // which is the one moment a flush (rather than a cancel) is correct.
  useEffect(() => {
    return () => {
      pendingColorWrite.current?.();
    };
  }, []);

  // The full copy, before the on/off toggles below strip anything out --
  // still used to show each toggle what it is hiding (e.g. "Until Saturday"
  // next to the Dates switch), so a toggle that is off doesn't also erase the
  // preview text beside it.
  const rawCopy = useMemo(
    () =>
      posterCopyFor({
        promotion,
        shopName: shop?.name ?? '',
        headline,
        branch: activeLocation?.name ?? null,
        address: addressFor(activeLocation),
        hours: activeLocation ? formatTodayHours(activeLocation.openingHours, new Date()) : null,
        phone: activeLocation?.contactPhone ?? null,
        logoUrl: shop?.logoUrl ?? null,
      }),
    [promotion, shop, headline, activeLocation]
  );

  // What actually reaches the poster: each toggle nulls its field rather than
  // leaving an empty string, so PosterCanvas's own "nothing optional prints
  // when absent" rule (see its header comment) does the hiding -- never a
  // second copy of that rule here.
  const copy: PosterCopy = {
    ...rawCopy,
    when: showDates ? rawCopy.when : null,
    branch: showBranch ? rawCopy.branch : null,
    address: showBranch ? rawCopy.address : null,
    hours: showHours ? rawCopy.hours : null,
    phone: showPhone ? rawCopy.phone : null,
  };

  // Every offer that will actually come off a sale on its own, reusing
  // posterCopyFor per-offer rather than re-deriving "20%" / "Everything in
  // store" a second way here.
  //
  // `autoApply` matters as much as the window here: an offer that only applies
  // when a cashier picks it is live by every other measure, and putting it on a
  // sheet in the shop window promises a customer a discount they will not be
  // given unless they know to ask. isPromotionLive deliberately does not check
  // that flag -- bestPromotionForProduct does, and so must anything that speaks
  // to a customer.
  const weekOffers: PosterWeekOffer[] | undefined = useMemo(() => {
    if (template !== 'week') return undefined;
    return promotions
      .filter((p) => isPromotionLive(p, now) && p.autoApply)
      .map((p) => {
        const offerCopy = posterCopyFor({ promotion: p, shopName: shop?.name ?? '' });
        // Same rule the Dates toggle already applies to `copy.when` above --
        // without this, `showDates` had no effect on the week template at
        // all, since these rows never went through `copy`.
        return { value: offerCopy.value, scope: offerCopy.scope, when: showDates ? offerCopy.when : null };
      });
  }, [template, promotions, shop, now, showDates]);

  const exportWidthPx = EXPORT_WIDTH_PX[shape];
  // captureRef sizes in LOGICAL pixels (see poster-export.ts's own comment on
  // capturePosterPng) -- rendering the OFF-SCREEN copy at this same logical
  // width is what makes the capture crisp rather than an upscale. Render it
  // any smaller and the capture step would be enlarging a low-detail bitmap,
  // which is the exact "looks fine on screen, unusable printed" failure this
  // task exists to avoid; render it larger and every device just does more
  // work for a PNG that gets resized right back down.
  const offscreenWidth = exportWidthPx / PixelRatio.get();

  const runExport = async (kind: 'png' | 'pdf' | 'share') => {
    setError(null);
    setBusy(kind);
    try {
      // Always a real tmpfile, even for the PDF path below -- the PNG-share
      // branch at the bottom of this function needs an actual file URI to
      // hand to Sharing.shareAsync, and capturing once and reading it back
      // (posterPngDataUri) rather than capturing twice is what keeps the
      // saved PNG and the printed PDF pixel-identical.
      const pngUri = await capturePosterPng(captureRef);
      if (kind === 'pdf') {
        const pdfUri = await posterPdfFromPngDataUri(await posterPngDataUri(pngUri), shape);
        await sharePoster(pdfUri, 'application/pdf');
      } else if (kind === 'share' && shape === 'sheet') {
        // "Share" follows whatever is on screen: the Sheet shape exists for
        // print and for sending as a WhatsApp document, so sharing it hands
        // out the PDF, not a picture of a page. Every other shape hands out
        // the PNG a feed or a status actually wants.
        const pdfUri = await posterPdfFromPngDataUri(await posterPngDataUri(pngUri), shape);
        await sharePoster(pdfUri, 'application/pdf');
      } else {
        await sharePoster(pngUri, 'image/png');
      }
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not export this poster.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppModal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.headTitle}>Poster · {promotion.name}</Text>
            <Pressable onPress={onClose} style={styles.headBtn}>
              <Text style={styles.headBtnText}>Close</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {error && <Text style={styles.error}>{error}</Text>}

            <View
              style={styles.previewCard}
              onLayout={(e) => setPreviewWidth(Math.min(e.nativeEvent.layout.width - 32, 380))}
            >
              <PosterCanvas copy={copy} width={previewWidth} shape={shape} template={template} color={color} showMark={showMark} weekOffers={weekOffers} />
            </View>

            <Text style={styles.fieldLabel}>TEMPLATE</Text>
            <View style={styles.chipRow}>
              {TEMPLATES.map((t) => (
                <CategoryChip key={t.key} variant="bento" label={t.label} active={template === t.key} onPress={() => setTemplate(t.key)} />
              ))}
            </View>

            <Text style={styles.fieldLabel}>SHAPE</Text>
            <View style={styles.chipRow}>
              {(Object.keys(POSTER_SHAPES) as PosterShape[]).map((key) => (
                <CategoryChip key={key} variant="bento" label={POSTER_SHAPES[key].label} active={shape === key} onPress={() => setShape(key)} />
              ))}
            </View>

            <Text style={styles.fieldLabel}>HEADLINE</Text>
            <TextInput
              value={headline}
              onChangeText={setHeadline}
              placeholder="e.g. Ciid wanaagsan"
              placeholderTextColor={theme.bentoMuted2}
              maxLength={HEADLINE_MAX}
              style={styles.input}
            />

            <Text style={styles.fieldLabel}>COLOUR</Text>
            <ColorPicker value={color} onChange={setColor} />
            {colorError && <Text style={styles.error}>{colorError}</Text>}

            <Text style={styles.fieldLabel}>SHOW ON THE POSTER</Text>
            <ToggleRow label="Dates" hint={rawCopy.when ?? 'No window set on this offer'} value={showDates} onValueChange={setShowDates} />
            <ToggleRow
              label="Branch and address"
              hint={[rawCopy.branch, rawCopy.address].filter(Boolean).join(' · ') || 'Nothing on file for this branch'}
              value={showBranch}
              onValueChange={setShowBranch}
            />
            <ToggleRow label="Opening hours" hint={rawCopy.hours ?? 'Not set for today'} value={showHours} onValueChange={setShowHours} />
            <ToggleRow label="Phone number" hint={rawCopy.phone ?? 'Nothing on file for this branch'} value={showPhone} onValueChange={setShowPhone} />
            {canToggleMark && (
              <ToggleRow label="Made with Kaiibi" hint="Removed on plans that include it" value={!markOff} onValueChange={(on) => setMarkOff(!on)} />
            )}

            {POSTER_EXPORT_SUPPORTED ? (
              <View style={styles.actions}>
                <Pressable onPress={() => runExport('png')} disabled={busy !== null} style={[styles.primary, busy !== null && styles.actionOff]}>
                  <Text style={styles.primaryText}>{busy === 'png' ? 'Saving…' : 'Save image'}</Text>
                </Pressable>
                <Pressable onPress={() => runExport('pdf')} disabled={busy !== null} style={[styles.secondary, busy !== null && styles.actionOff]}>
                  <Text style={styles.secondaryText}>{busy === 'pdf' ? 'Saving…' : 'Save sheet (PDF)'}</Text>
                </Pressable>
                <Pressable onPress={() => runExport('share')} disabled={busy !== null} style={[styles.secondary, busy !== null && styles.actionOff]}>
                  <Text style={styles.secondaryText}>{busy === 'share' ? 'Sharing…' : 'Share'}</Text>
                </Pressable>
              </View>
            ) : (
              <Text style={styles.webHint}>Saving and sharing a poster happens in the app on a phone.</Text>
            )}
          </ScrollView>
        </View>

        {POSTER_EXPORT_SUPPORTED && (
          // The export-resolution copy. Captured instead of the preview above
          // -- capturing that one would rasterise it at its on-screen size
          // (a few hundred points), producing a PNG that looks fine on a
          // phone screen and is unusable printed.
          //
          // Positioned far outside the viewport rather than hidden with
          // display:none or opacity:0: on ANDROID, captureRef snapshots the
          // target view's own native layer directly (`View.draw(Canvas)`),
          // not a screen grab, so an off-screen view still rasterises fully.
          // On IOS that is only true because capturePosterPng passes
          // `useRenderInContext: true` -- left at its default, RNViewShot.mm
          // takes a render-server screenshot
          // (`drawViewHierarchyInRect:afterScreenUpdates:`) whose own inline
          // comment admits it "doesn't work for large views and reports
          // incorrect success even though the image is blank", which is
          // exactly what an off-screen view like this one triggers. See
          // poster-export.ts's capturePosterPng for the option that forces
          // iOS onto the same layer-drawing path Android already takes.
          // A display:none view can be pruned from the native
          // layout/compositing pass entirely and come back blank, and a
          // zero-opacity one risks the same on some renderers -- moving it
          // off-screen instead of hiding it is what keeps it real.
          // `collapsable={false}` keeps Android from stripping this wrapper
          // out of the native view tree, since nothing on screen ever points
          // a pixel at it and it would otherwise look prunable.
          <View style={styles.offscreen} pointerEvents="none">
            <View ref={captureRef} collapsable={false}>
              <PosterCanvas copy={copy} width={offscreenWidth} shape={shape} template={template} color={color} showMark={showMark} weekOffers={weekOffers} />
            </View>
          </View>
        )}
      </View>
    </AppModal>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onValueChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: value }} onPress={() => onValueChange(!value)} style={styles.toggleRow}>
      <View style={styles.toggleLabel}>
        <Text style={styles.toggleTitle}>{label}</Text>
        <Text style={styles.toggleHint} numberOfLines={1}>
          {hint}
        </Text>
      </View>
      <Switch value={value} onValueChange={onValueChange} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: theme.bentoPage, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '92%' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 16, paddingTop: 16 },
  headTitle: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '800', letterSpacing: -0.4, color: theme.bentoInk },
  headBtn: { borderWidth: 1, borderColor: theme.bentoLine, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  headBtnText: { fontSize: 11.5, fontWeight: '700', color: theme.bentoInk2 },
  body: { padding: 16, paddingTop: 12 },
  previewCard: { backgroundColor: theme.bentoSurface, borderRadius: 18, borderWidth: 1, borderColor: theme.bentoLine, padding: 16, alignItems: 'center', marginBottom: 8 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: theme.bentoMuted, marginBottom: 6, marginTop: 14 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  input: { backgroundColor: theme.bentoSoft, borderRadius: 10, height: 42, paddingHorizontal: 12, color: theme.bentoInk },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12 },
  toggleLabel: { flex: 1, minWidth: 0 },
  toggleTitle: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk },
  toggleHint: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 2 },
  actions: { gap: 8, marginTop: 18 },
  primary: { backgroundColor: theme.bentoInk, borderRadius: 14, height: 48, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: theme.bentoSurface, fontSize: 14, fontWeight: '800' },
  secondary: { borderWidth: 1, borderColor: theme.bentoLine, backgroundColor: theme.bentoSurface, borderRadius: 14, height: 48, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: theme.bentoInk2, fontSize: 14, fontWeight: '700' },
  actionOff: { opacity: 0.5 },
  webHint: { fontSize: 12.5, color: theme.bentoMuted, marginTop: 18, textAlign: 'center' },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 8 },
  offscreen: { position: 'absolute', left: -100000, top: -100000 },
});
