import { useState } from 'react';
import { Image, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { pickPhotoFromLibrary } from '@/lib/photo-picker';
import { discountLabel, scopeLabel } from '@/lib/promotions';
import type { StorefrontTheme } from '@/lib/storefront-catalog';
import { FLYER_LIMIT, flyerErrorMessage, type ShopFlyer } from '@/lib/storefront-admin';
import type { Promotion, StorefrontFlyerLinkKind } from '@/types/models';

// Pinned to the light palette -- no dark mode yet, same as every other bento
// admin screen. Every colour below comes from this object; there is no hex
// literal in this file.
const theme = Colors.light;

// THE ONE DECISION THIS PANEL RESTS ON: only the headline is free text.
//
// Attaching an offer PICKS from the shop's running promotions -- it is not a
// text box, and there is deliberately no field a shop could type "50% off"
// into. src/lib/poster.ts already derives every word a printed poster carries
// from the promotion row so the paper cannot contradict the till, and
// 20260930000100 makes the same argument, stronger, for the page: a shop can
// take paper off the door, and a page advertising a discount the till refuses
// does it around the clock, to strangers, at the address on the shop's card.
//
// The headline stays typed because "Ciid wanaagsan" is not derivable from a
// discount row. Leaving the offer empty makes the flyer a plain announcement
// -- new stock, changed hours, a photograph -- which is exactly the null case
// `campaigns` already names.
//
// The only data-layer import is flyerErrorMessage + FLYER_LIMIT, both pure:
// the DATABASE decides five-per-shop (a trigger, 20260930000000), and the one
// sentence that refusal reads as has to live next to orderErrorMessage rather
// than being re-typed here where it could drift. Every WRITE still belongs to
// the caller, the same seam ContentDrawer and DeliveryEditor use.

/** Everything about a flyer except its id and its place in the order. */
export type FlyerFields = {
  imagePath: string;
  headline: string | null;
  subline: string | null;
  linkKind: StorefrontFlyerLinkKind;
  linkValue: string | null;
  promotionId: string | null;
  draft: boolean;
};

const LINK_CHOICES: { kind: StorefrontFlyerLinkKind; label: string; hint: string }[] = [
  { kind: 'none', label: 'Nothing', hint: 'The flyer is just something to look at.' },
  { kind: 'category', label: 'Show a category', hint: 'Takes the customer to the items in that category.' },
  { kind: 'whatsapp', label: 'Ask on WhatsApp', hint: 'Opens a chat with your shop about this flyer.' },
];

function blankFields(): FlyerFields {
  return {
    imagePath: '',
    headline: '',
    subline: '',
    linkKind: 'none',
    linkValue: '',
    promotionId: null,
    // A new flyer is born a draft, matching the column's own default
    // (20260930000000) -- nothing a shop half-built reaches a customer by
    // accident. The switch below is how it goes live.
    draft: true,
  } as FlyerFields;
}

function fieldsOf(flyer: ShopFlyer): FlyerFields {
  return {
    imagePath: flyer.imagePath,
    headline: flyer.headline ?? '',
    subline: flyer.subline ?? '',
    linkKind: flyer.linkKind,
    linkValue: flyer.linkValue ?? '',
    promotionId: flyer.promotionId,
    draft: flyer.draft,
  };
}

// Empty text is stored as NULL, never as ''. The public read treats null as
// "this flyer has no headline" and renders no copy block at all (Task 3); an
// empty string would render an empty line instead.
function orNull(text: string | null): string | null {
  const trimmed = (text ?? '').trim();
  return trimmed ? trimmed : null;
}

// What a row says about where it goes, in the shop's words rather than the
// column's -- the mockup's "Links to · Solar".
function linkSummary(flyer: ShopFlyer): string {
  if (flyer.linkKind === 'category') return `Links to · ${flyer.linkValue ?? 'a category'}`;
  if (flyer.linkKind === 'whatsapp') return 'Links to · Ask on WhatsApp';
  return 'Links to · nothing';
}

export function FlyerEditor({
  flyers,
  theme: layout,
  promotions,
  promotionsEnabled,
  autoAdvance,
  onAutoAdvanceChange,
  onUploadImage,
  onCreate,
  onUpdate,
  onDelete,
  onReorder,
}: {
  flyers: ShopFlyer[];
  /** The shop's chosen layout. 'counter' shows no flyers at all, by design. */
  theme: StorefrontTheme;
  /**
   * The shop's RUNNING promotions -- already narrowed by the caller through
   * isPromotionLive (src/lib/discounts.ts, "the one place 'is this offer
   * running right now' is decided"). Never filtered again here: a second copy
   * of that rule is a second thing to drift.
   */
  promotions: Promotion[];
  /**
   * hasModule('promotions') from the caller. False must not make the offer
   * picker merely absent -- it says so, and announcement flyers keep working.
   */
  promotionsEnabled: boolean;
  autoAdvance: boolean;
  onAutoAdvanceChange: (on: boolean) => void;
  /**
   * Wired by the caller to uploadImage(path, localUri) (src/lib/storage.ts) --
   * the same helper the hero photo, product photos and the shop logo already
   * use, so there is exactly one upload path in the app. This component picks
   * the local photo (expo-image-picker is not a data-layer concern) but never
   * uploads it itself.
   */
  onUploadImage: (localUri: string) => Promise<string>;
  /** Rejections are caught and shown here, never dropped -- see B4 on DeliveryEditor. */
  onCreate: (fields: FlyerFields) => Promise<void>;
  onUpdate: (id: string, fields: FlyerFields) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** The WHOLE new order, not the id that moved -- see reorderFlyers. */
  onReorder: (orderedIds: string[]) => Promise<void>;
}) {
  // Sorted here, not trusted from the prop: the row order on screen is what
  // the move buttons compute the new order from, so a list that arrived out
  // of order would move the wrong row.
  const sorted = [...flyers].sort((a, b) => a.position - b.position);

  // null = the list. 'new' = the add form. Any other string = editing that id.
  const [editing, setEditing] = useState<string | null>(null);
  const [fields, setFields] = useState<FlyerFields>(blankFields);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set alongside `error` when the refusal was the five-per-shop trigger:
  // "Try again" is the wrong action for a cap ("try again" will fail again),
  // and a `wrong` caveat must always carry an action that actually removes
  // it. The action for a full shop is getting back to the list, where the
  // Remove buttons are.
  const [errorIsLimit, setErrorIsLimit] = useState(false);

  const atLimit = sorted.length >= FLYER_LIMIT;
  const isCounter = layout === 'counter';

  function openNew() {
    setFields(blankFields());
    setError(null);
    setErrorIsLimit(false);
    setEditing('new');
  }

  function openEdit(flyer: ShopFlyer) {
    setFields(fieldsOf(flyer));
    setError(null);
    setErrorIsLimit(false);
    setEditing(flyer.id);
  }

  function closeForm() {
    setEditing(null);
    setError(null);
    setErrorIsLimit(false);
  }

  function patch(next: Partial<FlyerFields>) {
    setFields((current) => ({ ...current, ...next }));
  }

  async function handlePickImage() {
    setError(null);
    setErrorIsLimit(false);
    const picked = await pickPhotoFromLibrary();
    if (picked.status === 'canceled') return;
    if (picked.status === 'failed') {
      setError(picked.message);
      return;
    }
    setUploading(true);
    try {
      const stored = await onUploadImage(picked.uri);
      patch({ imagePath: stored });
    } catch {
      setError('Could not upload that photo — try again.');
    } finally {
      setUploading(false);
    }
  }

  // A flyer IS the picture: image_path is `text not null` (20260930000000)
  // and a flyer with no image would be a panel of words on a page whose whole
  // point is the poster. Refused here rather than left to the NOT NULL, so
  // the shop is told before the round trip.
  const canSave = Boolean(fields.imagePath) && !saving && !uploading;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setErrorIsLimit(false);
    const payload: FlyerFields = {
      imagePath: fields.imagePath,
      headline: orNull(fields.headline),
      subline: orNull(fields.subline),
      linkKind: fields.linkKind,
      // A category link with no category named goes nowhere, so the value is
      // dropped for every other kind rather than left behind from a previous
      // choice -- the same reason link_kind 'none' exists as a value at all.
      linkValue: fields.linkKind === 'category' ? orNull(fields.linkValue) : null,
      // A shop that lost the promotions module between opening the form and
      // saving cannot attach an offer, and must not silently keep one it can
      // no longer see.
      promotionId: promotionsEnabled ? fields.promotionId : null,
      draft: fields.draft,
    };
    try {
      if (editing === 'new') await onCreate(payload);
      else if (editing) await onUpdate(editing, payload);
      // Only a save that actually landed closes the form. A failure leaves
      // the shopkeeper looking at exactly what they typed, with a reason.
      setEditing(null);
    } catch (err) {
      const limit = flyerErrorMessage(err);
      setErrorIsLimit(Boolean(limit));
      setError(limit ?? 'Could not save this flyer. Try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    setErrorIsLimit(false);
    try {
      await onDelete(id);
      if (editing === id) setEditing(null);
    } catch {
      setError('Could not remove this flyer. Try again.');
    }
  }

  async function move(index: number, by: -1 | 1) {
    const next = [...sorted];
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved);
    setError(null);
    setErrorIsLimit(false);
    try {
      await onReorder(next.map((flyer) => flyer.id));
    } catch {
      setError('Could not save the new order. Try again.');
    }
  }

  return (
    <BentoCard title="Flyers">
      <Text style={styles.sub}>Posters and offers that show at the top of your page.</Text>

      {/* Property 5 / the honesty half of Task 3's decision: Counter shows no
          flyers at all, so a shop on Counter is TOLD, rather than left
          uploading three posters into the void. `context`, not `wrong` --
          nothing here is broken and the fix is the Design strip above, not
          this panel, so there is no action of ours to offer. */}
      {isCounter ? (
        <Caveat tone="context">
          Your page uses the Counter design, which shows a price list and no flyers — anything you add here stays saved,
          but customers won&apos;t see it until you switch to Market or Window.
        </Caveat>
      ) : null}

      {error ? (
        <Caveat
          tone="wrong"
          action={
            errorIsLimit
              ? { label: 'Back to your flyers', onPress: closeForm }
              : { label: 'Try again', onPress: () => setError(null) }
          }
        >
          {error}
        </Caveat>
      ) : null}

      {sorted.length === 0 ? (
        <Text style={styles.empty}>No flyers yet. A flyer is a poster, an offer, or a photo of new stock.</Text>
      ) : (
        <View style={styles.list}>
          {sorted.map((flyer, index) => (
            <View key={flyer.id} testID={`flyer-editor-row-${flyer.id}`} style={styles.row}>
              <Image source={{ uri: flyer.imagePath }} style={styles.thumb} />
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {flyer.headline ?? 'Untitled flyer'}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {linkSummary(flyer)}
                </Text>
              </View>
              <Text style={[styles.pill, flyer.draft ? styles.pillDraft : styles.pillLive]}>
                {flyer.draft ? 'Draft' : 'Live'}
              </Text>
              <View style={styles.rowActions}>
                {/* Move up/down rather than a drag handle: this repo carries
                    no draggable-list dependency, and buttons are the version
                    a keyboard and a screen reader can actually reach. The
                    first row has no "up" and the last no "down" -- an arrow
                    that renders and refuses is the same lie a dot on a single
                    flyer would be. */}
                {index > 0 ? (
                  <Pressable
                    testID={`flyer-editor-up-${flyer.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${flyer.headline ?? 'this flyer'} earlier`}
                    onPress={() => move(index, -1)}
                    style={styles.ghost}
                  >
                    <Text style={styles.ghostText}>↑</Text>
                  </Pressable>
                ) : null}
                {index < sorted.length - 1 ? (
                  <Pressable
                    testID={`flyer-editor-down-${flyer.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${flyer.headline ?? 'this flyer'} later`}
                    onPress={() => move(index, 1)}
                    style={styles.ghost}
                  >
                    <Text style={styles.ghostText}>↓</Text>
                  </Pressable>
                ) : null}
                <Pressable testID={`flyer-editor-edit-${flyer.id}`} accessibilityRole="button" onPress={() => openEdit(flyer)} style={styles.ghost}>
                  <Text style={styles.ghostText}>Edit</Text>
                </Pressable>
                <Pressable
                  testID={`flyer-editor-delete-${flyer.id}`}
                  accessibilityRole="button"
                  onPress={() => handleDelete(flyer.id)}
                  style={styles.ghost}
                >
                  <Text style={styles.ghostText}>Remove</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}

      <Text style={styles.count}>{`${sorted.length} of ${FLYER_LIMIT}`}</Text>

      {/* The UI stops offering Add at five and says why; the DATABASE is what
          actually enforces it (a trigger, so two devices adding the sixth at
          once cannot both pass), and flyerErrorMessage is what that refusal
          reads as if the two ever disagree. */}
      {atLimit ? (
        <Caveat tone="context">
          {`Your page can show ${FLYER_LIMIT} flyers, and you already have ${FLYER_LIMIT}. Remove one before adding another.`}
        </Caveat>
      ) : editing === null ? (
        <Pressable testID="flyer-editor-add" accessibilityRole="button" onPress={openNew} style={styles.addButton}>
          <Text style={styles.addButtonText}>+ Add a flyer</Text>
        </Pressable>
      ) : null}

      {editing !== null ? (
        <View style={styles.form}>
          <Text style={[styles.eyebrow, styles.spaced]}>Image</Text>
          {fields.imagePath ? <Image source={{ uri: fields.imagePath }} style={styles.formPreview} /> : null}
          <Pressable
            testID="flyer-editor-image-pick"
            accessibilityRole="button"
            disabled={uploading}
            onPress={handlePickImage}
            style={[styles.ghost, styles.ghostWide, uploading && styles.disabled]}
          >
            <Text style={styles.ghostText}>
              {uploading ? 'Uploading…' : fields.imagePath ? 'Replace photo' : 'Add photo'}
            </Text>
          </Pressable>
          <Text style={styles.hint}>Wide images look best — about twice as wide as tall.</Text>

          <Text style={[styles.eyebrow, styles.spaced]}>Headline</Text>
          <TextInput
            testID="flyer-editor-headline"
            style={styles.input}
            value={fields.headline ?? ''}
            onChangeText={(text) => patch({ headline: text })}
            placeholder="e.g. Ciid wanaagsan"
          />

          <Text style={[styles.eyebrow, styles.spaced]}>Line underneath (optional)</Text>
          <TextInput
            testID="flyer-editor-subline"
            style={styles.input}
            value={fields.subline ?? ''}
            onChangeText={(text) => patch({ subline: text })}
            placeholder="e.g. Eid stock has landed."
          />

          <Text style={[styles.eyebrow, styles.spaced]}>When it&apos;s tapped</Text>
          <View style={styles.chips}>
            {LINK_CHOICES.map((choice) => {
              const on = fields.linkKind === choice.kind;
              return (
                <Pressable
                  key={choice.kind}
                  testID={`flyer-editor-link-${choice.kind}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => patch({ linkKind: choice.kind })}
                  style={[styles.chip, on && styles.chipOn]}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{choice.label}</Text>
                </Pressable>
              );
            })}
          </View>
          {fields.linkKind === 'category' ? (
            <TextInput
              testID="flyer-editor-link-value"
              style={[styles.input, styles.spacedSmall]}
              value={fields.linkValue ?? ''}
              onChangeText={(text) => patch({ linkValue: text })}
              placeholder="e.g. Solar"
            />
          ) : null}
          <Text style={styles.hint}>{LINK_CHOICES.find((c) => c.kind === fields.linkKind)?.hint}</Text>

          <Text style={[styles.eyebrow, styles.spaced]}>Offer behind it (optional)</Text>
          {!promotionsEnabled ? (
            // Property 6: the shop is told the picker is unavailable and WHY,
            // rather than the section being silently absent (which reads as
            // broken) or present-but-dead. Announcement flyers are unaffected
            // -- everything above this line still works. `context`: there is
            // nothing to do in this panel about a module, and the upgrade
            // lives in Settings, so implying an action here would be a lie.
            <Caveat tone="context">
              Attaching an offer needs Promotions, which isn&apos;t included in your plan. You can still add announcement
              flyers here — new stock, changed hours, a photograph.
            </Caveat>
          ) : promotions.length === 0 ? (
            <Caveat tone="context">
              No offers are running right now, so there is nothing to attach. This flyer will go up as an announcement.
            </Caveat>
          ) : (
            <>
              <View style={styles.offers}>
                <Pressable
                  testID="flyer-editor-offer-none"
                  accessibilityRole="button"
                  accessibilityState={{ selected: fields.promotionId === null }}
                  onPress={() => patch({ promotionId: null })}
                  style={[styles.offer, fields.promotionId === null && styles.offerOn]}
                >
                  <Text style={[styles.offerName, fields.promotionId === null && styles.offerNameOn]}>No offer</Text>
                  <Text style={styles.offerMeta}>An announcement — new stock, new hours, a photograph.</Text>
                </Pressable>
                {promotions.map((promotion) => {
                  const on = fields.promotionId === promotion.id;
                  return (
                    <Pressable
                      key={promotion.id}
                      testID={`flyer-editor-offer-${promotion.id}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      onPress={() => patch({ promotionId: promotion.id })}
                      style={[styles.offer, on && styles.offerOn]}
                    >
                      <Text style={[styles.offerName, on && styles.offerNameOn]}>{promotion.name}</Text>
                      <Text style={styles.offerMeta}>{`${discountLabel(promotion)} · ${scopeLabel(promotion)}`}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.hint}>
                Chosen from your running offers, never typed. The page shows what the till will give, so the two cannot
                disagree.
              </Text>
            </>
          )}

          <View style={[styles.switchRow, styles.spaced]}>
            <View style={styles.switchText}>
              <Text style={styles.switchLabel}>Keep as a draft</Text>
              <Text style={styles.hint}>
                {fields.draft ? "Only you can see this one." : 'Customers see this one on your page.'}
              </Text>
            </View>
            <Switch
              testID="flyer-editor-draft-toggle"
              value={fields.draft}
              onValueChange={(value) => patch({ draft: value })}
              trackColor={{ false: theme.bentoLine, true: theme.bentoInk }}
              thumbColor={theme.bentoSurface}
              ios_backgroundColor={theme.bentoLine}
            />
          </View>

          {!fields.imagePath ? (
            <Caveat tone="wrong" action={{ label: 'Add a photo', onPress: handlePickImage }}>
              A flyer needs a picture — that picture is what a customer actually sees.
            </Caveat>
          ) : null}

          <View style={styles.formButtons}>
            <Pressable
              testID="flyer-editor-save"
              accessibilityRole="button"
              disabled={!canSave}
              onPress={handleSave}
              style={[styles.primary, !canSave && styles.disabled]}
            >
              <Text style={styles.primaryText}>{saving ? 'Saving…' : 'Save flyer'}</Text>
            </Pressable>
            <Pressable testID="flyer-editor-cancel" accessibilityRole="button" onPress={closeForm} style={styles.ghost}>
              <Text style={styles.ghostText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Task 4 built the motion and left the control here. One checkbox, off
          by default. The hint says the two things that make it honest: it
          needs two flyers to have anywhere to go, and the customer's own
          reduced-motion setting overrides it regardless -- their preference
          is not advisory. */}
      <View style={[styles.switchRow, styles.spaced]}>
        <View style={styles.switchText}>
          <Text style={styles.switchLabel}>Move through the flyers on its own</Text>
          <Text style={styles.hint}>
            Only with two or more flyers, and never on a phone that asks for less motion — the customer&apos;s setting
            wins.
          </Text>
        </View>
        <Switch
          testID="flyer-editor-auto-advance"
          value={autoAdvance}
          onValueChange={onAutoAdvanceChange}
          trackColor={{ false: theme.bentoLine, true: theme.bentoInk }}
          thumbColor={theme.bentoSurface}
          ios_backgroundColor={theme.bentoLine}
        />
      </View>
    </BentoCard>
  );
}

const styles = StyleSheet.create({
  sub: { fontSize: 12.5, color: theme.bentoMuted2, marginBottom: 4 },
  empty: { fontSize: 12.5, color: theme.bentoMuted2, marginTop: 10 },
  count: { fontSize: 11.5, fontWeight: '700', color: theme.bentoMuted, marginTop: 12 },

  eyebrow: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted,
    marginBottom: 8,
  },
  spaced: { marginTop: 16 },
  spacedSmall: { marginTop: 9 },
  hint: { fontSize: 11.5, color: theme.bentoMuted2, marginTop: 6, lineHeight: 17 },

  list: { marginTop: 12, gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSoft,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexWrap: 'wrap',
  },
  thumb: { width: 54, height: 34, borderRadius: 8, backgroundColor: theme.bentoLine },
  rowText: { flex: 1, minWidth: 90 },
  rowTitle: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  rowMeta: { fontSize: 11.5, color: theme.bentoMuted2, marginTop: 2 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  pill: {
    fontSize: 10.5,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    overflow: 'hidden',
  },
  // The same washed-pill pair the delta badge uses (bentoUpWash/bentoUpInk is
  // solved for contrast against its own wash). "Draft" gets the neutral
  // surface rather than bentoSoft, which is the ROW's own fill -- a soft pill
  // on a soft row disappears, the exact trap bentoAccentWash's own comment
  // warns about.
  pillLive: { backgroundColor: theme.bentoUpWash, color: theme.bentoUpInk },
  pillDraft: { backgroundColor: theme.bentoSurface, color: theme.bentoMuted },

  ghost: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 6,
    backgroundColor: theme.bentoSurface,
  },
  ghostWide: { alignSelf: 'flex-start' },
  ghostText: { fontSize: 12, fontWeight: '700', color: theme.bentoInk },
  disabled: { opacity: 0.4 },

  addButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  addButtonText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoSurface },

  primary: {
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  primaryText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoSurface },

  form: {
    marginTop: 14,
    borderTopWidth: 1,
    borderTopColor: theme.bentoLine,
    paddingTop: 4,
  },
  formPreview: { width: '100%', height: 112, borderRadius: 12, backgroundColor: theme.bentoSoft, marginBottom: 9 },
  formButtons: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },

  input: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSoft,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 13.5,
    color: theme.bentoInk,
  },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: theme.bentoSurface,
  },
  chipOn: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  chipText: { fontSize: 12, fontWeight: '700', color: theme.bentoInk },
  chipTextOn: { color: theme.bentoSurface },

  offers: { gap: 7 },
  offer: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: theme.bentoSurface,
  },
  offerOn: { borderColor: theme.bentoInk, backgroundColor: theme.bentoSoft },
  offerName: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  offerNameOn: { color: theme.bentoInk },
  offerMeta: { fontSize: 11.5, color: theme.bentoMuted2, marginTop: 2 },

  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  switchText: { flex: 1 },
  switchLabel: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
});
