import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { formatE164ForDisplay, toE164 } from '@/lib/phone-e164';
import { pickPhotoFromLibrary } from '@/lib/photo-picker';
import { applySuffix, deriveSlugFromName, type SlugProblem } from '@/lib/storefront-slug';
import { APP_DOMAIN } from '@/lib/storefront-host';

// Pinned to the light palette -- no dark mode yet, same as every other bento
// screen.
const theme = Colors.light;

// Deliberately free of every data-layer import (no lib/storefront-admin, no
// lib/storage, no lib/supabase): the caller owns checking a slug, claiming
// it, and uploading a photo. This component only renders what those results
// mean to a shopkeeper and hands typed input back up through onChange.
export type ContentDrawerValue = {
  slug: string;
  headline: string;
  about: string;
  heroImageUrl: string | null;
  whatsappE164: string | null;
};

export type SlugState = 'idle' | 'checking' | 'available' | 'taken' | SlugProblem;

/** The two fields on this drawer a publish blocker can point at. */
export type ContentDrawerFocusTarget = 'slug' | 'whatsapp';

/**
 * Bumping `token` (even to the same `field` twice in a row) imperatively
 * focuses that field -- how the editor screen jumps a shopkeeper straight to
 * the field that clears the FIRST publish blocker, since PublishBar routes
 * every blocker's "Fix this" through one `onEdit` with no argument and
 * cannot say which one was meant.
 */
export type ContentDrawerFocusRequest = { field: ContentDrawerFocusTarget; token: number };

// Every state that needs a sentence gets one here, in words a shopkeeper
// typed nothing technical to earn. 'idle' has no entry -- nothing to say
// before they've typed anything. The tone follows the same rule the rest of
// bento does: 'wrong' always ships with an action that removes it, 'context'
// never implies one.
const SLUG_STATE_COPY: Partial<Record<SlugState, { tone: 'wrong' | 'context'; text: string }>> = {
  checking: { tone: 'context', text: 'Checking if that address is available…' },
  available: { tone: 'context', text: 'That address is available — tap Claim to make it yours.' },
  taken: { tone: 'wrong', text: 'That address is already taken — try a different one.' },
  too_short: { tone: 'wrong', text: "That's too short for a web address — use at least 3 characters." },
  too_long: { tone: 'wrong', text: "That's too long for a web address — keep it under 63 characters." },
  bad_characters: { tone: 'wrong', text: 'Web addresses can only use lowercase letters, numbers and hyphens.' },
  edge_hyphen: { tone: 'wrong', text: "A web address can't start or end with a hyphen." },
  // Never says "reserved" -- that word means nothing to a shopkeeper and
  // reads like an accusation. Just point them at another name.
  reserved: { tone: 'wrong', text: "That name isn't available — try something closer to your shop's name instead." },
};

// The SAME 'taken' state as above, said differently once the suffix field is
// open. It is not a second state machine (SlugState is still the only one) --
// it is the one state whose meaning depends on where the shop is standing:
// before a suffix, "taken" means start from something else; after one, it
// means this ENDING is gone, and telling them to try a different address
// again would undo the base they just kept.
const SUFFIX_TAKEN_COPY: { tone: 'wrong' | 'context'; text: string } = {
  tone: 'wrong',
  text: 'That ending is taken too — try another part of town, or a word your customers know you by.',
};

// Why the suffix field appeared at all. Stays on screen the whole time it is
// open, because "available" underneath it would otherwise leave a shop
// wondering what it did wrong. Names the base rather than the whole address:
// the base is the part it is being asked to keep.
function collisionText(base: string): string {
  return `${base} is already another shop's address. Add the part of town you trade in and customers will still recognise you.`;
}

export function ContentDrawer({
  value,
  onChange,
  onClaimSlug,
  slugState,
  shopName = '',
  claimedSlug = null,
  suffixSuggestions = [],
  onUploadHeroImage,
  focusRequest,
}: {
  value: ContentDrawerValue;
  onChange: (patch: Partial<ContentDrawerValue>) => void;
  onClaimSlug: (slug: string) => void;
  slugState: SlugState;
  /**
   * The address a shop is about to give customers IS its name, so while
   * nothing is claimed this derives the field rather than offering a row to
   * tap. Two shops called "Xamdi Electronics" landing on unrelated addresses
   * is the failure this closes.
   */
  shopName?: string;
  /**
   * The slug already claimed on the row, or null while the shop has none.
   * The ONE thing that stops deriving: once an address is claimed, renaming
   * the shop must not move it, because it is printed on cards.
   */
  claimedSlug?: string | null;
  /**
   * Endings to offer when the derived address is taken -- the shop's own
   * neighbourhood, then its city (listAddressSuffixSuggestions,
   * storefront-admin.ts). Never a number: see that function's comment.
   */
  suffixSuggestions?: string[];
  /**
   * Wired by the caller to uploadImage(path, localUri) (src/lib/storage.ts) --
   * the same helper uploadShopLogo uses. This component picks the local photo
   * (expo-image-picker, not a data-layer concern) but never uploads it itself,
   * so there is exactly one upload path in the app, not two.
   */
  onUploadHeroImage?: (localUri: string) => Promise<string>;
  /** See `ContentDrawerFocusRequest`. Omitted by a caller with no blocker to jump to. */
  focusRequest?: ContentDrawerFocusRequest | null;
}) {
  const [phoneDraft, setPhoneDraft] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [heroUploading, setHeroUploading] = useState(false);
  const [heroError, setHeroError] = useState<string | null>(null);
  const slugInputRef = useRef<TextInput>(null);
  const suffixInputRef = useRef<TextInput>(null);
  const phoneInputRef = useRef<TextInput>(null);

  // Has the shop typed its OWN address? A ref, and set from exactly one
  // place -- the address field's own onChangeText -- because it must never be
  // INFERRED by comparing the field against the derived value: a shop that
  // deliberately types the name the derivation would have produced would then
  // lose that edit on the very next keystroke of the shop name.
  const slugTouchedRef = useRef(false);

  // The address the shop keeps when its derived one turns out to be taken.
  // Captured ONCE, on the collision, and frozen: recomputing it from
  // value.slug would swallow the suffix into the base the moment the
  // assembled address was itself refused.
  const [collisionBase, setCollisionBase] = useState<string | null>(null);
  // The ending the shop typed, or null while it is still the one it was
  // offered. Null is the whole answer to "has the shop touched this?" for the
  // suffix -- the same explicit question the address field answers with
  // slugTouchedRef, and for the same reason: typing the ending you were
  // already offered is still typing it, and it must survive a later location
  // read landing.
  const [typedSuffix, setTypedSuffix] = useState<string | null>(null);
  const inSuffixMode = collisionBase !== null;

  useEffect(() => {
    if (!focusRequest) return;
    // In suffix mode the address field IS the suffix field -- the base is
    // frozen text with nothing to focus, so a "fix your address" jump that
    // focused the missing input would land nowhere.
    if (focusRequest.field === 'slug') (inSuffixMode ? suffixInputRef : slugInputRef).current?.focus();
    else phoneInputRef.current?.focus();
    // Only the token needs to be a dependency -- it changes on every request,
    // including a second press that names the same field, which is exactly
    // when a re-focus (not a no-op) is the useful behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.token]);

  const derived = deriveSlugFromName(shopName);
  const offeredSuffix = suffixSuggestions[0] ?? '';

  // While nothing is claimed, the address IS the shop's name, and follows it.
  // Four things stop it, in this order: a claimed address (never re-derived
  // -- a rename must not move a printed link), an address the shop typed
  // itself, a name that normalizes to nothing, and a collision base held for
  // suffix mode. That last guard matters even though the suffix field's own
  // effect (below) reassembles `collisionBase + suffixDraft` on every render
  // where either changes -- a renamed shop changes NEITHER of those, so
  // without this guard this effect would overwrite `value.slug` with the
  // freshly derived (unsuffixed) name while the row still shows the frozen
  // base, and the address on screen and the address Claim submits would
  // silently diverge.
  useEffect(() => {
    if (claimedSlug) return;
    if (slugTouchedRef.current) return;
    if (collisionBase !== null) return;
    if (!derived) return;
    if (derived === value.slug.trim()) return; // already there; writing again would loop
    onChange({ slug: derived });
    // value.slug and onChange are deliberately out: this effect reacts to the
    // NAME changing (and to the address being claimed or a collision
    // starting/ending), and re-running it on every keystroke of the address
    // is precisely what it must not do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, claimedSlug, collisionBase]);

  // The collision itself: freeze what the shop has so a field can be opened
  // to append to it. Adjusted DURING RENDER rather than from an effect --
  // React's own answer to "state has to move when a prop changes", and it
  // avoids the frame in which the drawer would render the old field for a
  // verdict it has already been given. Guarded to run once: `collisionBase
  // !== null` short-circuits every later 'taken', which is what keeps a
  // refused SUFFIX out of the base and the shop from being walked backwards.
  if (slugState === 'taken' && collisionBase === null && value.slug.trim()) {
    setCollisionBase(value.slug.trim());
  }

  // The way OUT of suffix mode: a shop that decides to use a different name
  // entirely, not just a different ending, has otherwise no way back to a
  // plain, editable address field short of reloading the app. Clears both
  // pieces of frozen state -- the base and the typed ending -- and nothing
  // else: `value.slug` is left exactly as assembled, because it becomes the
  // plain input's value the moment `inSuffixMode` goes false, and a shop who
  // hasn't typed since is free to have it re-derive on the next rename (the
  // ordinary rule above), while a shop who DOES type into it immediately
  // marks it touched through that input's own `onChangeText`, same as ever.
  function exitSuffixMode() {
    setCollisionBase(null);
    setTypedSuffix(null);
  }

  // The ending on screen: the shop's own if it has typed one, otherwise the
  // one its location offers. Derived, not stored, so a suggestion arriving
  // late (it is a network read) still lands, and so nothing has to decide
  // when to overwrite a field the shop may already own.
  const suffixDraft = typedSuffix ?? offeredSuffix;

  // The one place the address is assembled. It is here rather than in the
  // input's own handler because the suffix has two sources -- typed, and
  // offered -- and both have to reach the editor screen, which is what
  // checks availability and what Claim reads.
  useEffect(() => {
    if (collisionBase === null) return;
    const assembled = applySuffix(collisionBase, suffixDraft);
    if (assembled === value.slug.trim()) return;
    onChange({ slug: assembled });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collisionBase, suffixDraft]);

  useEffect(() => {
    if (collisionBase === null) return;
    suffixInputRef.current?.focus();
  }, [collisionBase]);

  // The way back to the derived name after the shop has typed its own -- the
  // only thing left of the old "Suggested:" row. Hidden in suffix mode, where
  // tapping it would hand back the base that is already taken.
  const showSuggestion = !inSuffixMode && derived.length > 0 && derived !== value.slug.trim();
  // 'taken' is the one state that reads differently inside suffix mode, and
  // only once a suffix is actually on the end: with an empty suffix the
  // address on trial IS the base, which the collision note already explains.
  const suffixApplied = inSuffixMode && value.slug.trim() !== collisionBase;
  const slugNote =
    inSuffixMode && slugState === 'taken'
      ? suffixApplied
        ? SUFFIX_TAKEN_COPY
        : undefined
      : SLUG_STATE_COPY[slugState];
  const claimDisabled = !value.slug.trim() || slugState === 'checking';
  const fullAddress = `${value.slug.trim()}.${APP_DOMAIN}`;

  function commitPhone() {
    const draft = phoneDraft.trim();
    if (!draft) {
      // Nothing typed -- blurring an untouched field is not a rejection.
      setPhoneError(null);
      return;
    }
    const e164 = toE164(draft);
    if (!e164) {
      setPhoneError("That's not a valid number — check it and try again.");
      return; // Never stored raw -- the draft stays on screen, onChange is not called.
    }
    setPhoneError(null);
    setPhoneDraft('');
    onChange({ whatsappE164: e164 });
  }

  async function handlePickHero() {
    setHeroError(null);
    const result = await pickPhotoFromLibrary();
    if (result.status === 'canceled') return;
    if (result.status === 'failed') {
      setHeroError(result.message);
      return;
    }
    if (!onUploadHeroImage) {
      // A caller that forgot to wire the uploader -- fail loudly rather than
      // pretend the photo was saved.
      setHeroError('Photo upload is not available right now.');
      return;
    }
    setHeroUploading(true);
    try {
      const url = await onUploadHeroImage(result.uri);
      onChange({ heroImageUrl: url });
    } catch {
      setHeroError('Could not upload that photo — try again.');
    } finally {
      setHeroUploading(false);
    }
  }

  return (
    <BentoCard title="Content">
      <Text style={styles.eyebrow}>Web address</Text>
      {/* The slug is a SUBDOMAIN, not a path. slugFromHostname only ever
          resolves `<slug>.kaiibi.com` (src/lib/storefront-host.ts), so showing
          `kaiibi.com/<slug>` here would hand a shopkeeper an address that does
          not work -- and it is exactly the address they print on a card. The
          test asserts the rendered address round-trips through the real router
          function, so the two can never drift apart again. */}
      <View style={styles.slugRow}>
        {inSuffixMode ? (
          <>
            {/* Frozen, and rendered with the joining hyphen so the row reads
                as one address rather than two fields. */}
            <Text testID="content-drawer-slug-base" style={styles.slugBase}>{`${collisionBase}-`}</Text>
            <TextInput
              ref={suffixInputRef}
              testID="content-drawer-suffix-input"
              style={styles.slugInput}
              value={suffixDraft}
              onChangeText={setTypedSuffix}
              placeholder="the part of town you trade in"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </>
        ) : (
          <TextInput
            ref={slugInputRef}
            testID="content-drawer-slug-input"
            style={styles.slugInput}
            value={value.slug}
            onChangeText={(text) => {
              slugTouchedRef.current = true;
              onChange({ slug: text });
            }}
            placeholder="your-shop-name"
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
        <Text style={styles.slugSuffix}>{`.${APP_DOMAIN}`}</Text>
      </View>

      {inSuffixMode ? (
        <>
          {/* The assembled address, in full and in one piece, built from
              APP_DOMAIN like every other address on this screen -- a shop
              reading a base, a box and a domain separately should not have to
              do the joining in its head before printing it on a card. */}
          <Text testID="content-drawer-full-address" style={styles.fullAddress}>{fullAddress}</Text>
          {suffixSuggestions.length > 0 ? (
            <>
              <View style={styles.chipRow}>
                {suffixSuggestions.map((suffix) => {
                  const selected = suffix === suffixDraft;
                  return (
                    <Pressable
                      key={suffix}
                      testID={`content-drawer-suffix-chip-${suffix}`}
                      onPress={() => setTypedSuffix(suffix)}
                      style={[styles.chip, selected && styles.chipSelected]}
                    >
                      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{suffix}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.chipHint}>From your shop&apos;s location. Type anything you like instead.</Text>
            </>
          ) : null}
        </>
      ) : null}

      {/* 'context', not 'wrong', on purpose: by the time this shows, the fix
          IS the field above it, already open with the shop's own
          neighbourhood in it. A 'wrong' caveat promises an action that
          removes it (see Caveat's own header) and there is none left to give
          -- the mockup's amber banner is the one place its palette and
          bento's caveat vocabulary disagree. */}
      {inSuffixMode ? <Caveat tone="context">{collisionText(collisionBase)}</Caveat> : null}

      {/* The way out. Quiet on purpose -- the suffix field is the path most
          shops want, and this is only for the one who has decided the whole
          name should change, not just the ending. */}
      {inSuffixMode ? (
        <Pressable testID="content-drawer-suffix-exit" onPress={exitSuffixMode} style={styles.suffixExitRow}>
          <Text style={styles.suffixExitText}>Use a different name instead</Text>
        </Pressable>
      ) : null}

      {showSuggestion ? (
        <Pressable
          testID="content-drawer-slug-suggestion-accept"
          onPress={() => onChange({ slug: derived })}
          style={styles.suggestionRow}
        >
          <Text style={styles.suggestionText}>Suggested: {derived}</Text>
        </Pressable>
      ) : null}

      {value.slug ? (
        <Caveat tone="context">
          Changing your address here means the old one stops working immediately — anything already shared or printed
          breaks.
        </Caveat>
      ) : null}

      {slugNote ? (
        <Caveat
          tone={slugNote.tone}
          action={
            slugNote.tone !== 'wrong'
              ? undefined
              : inSuffixMode
                // NEVER the whole address here. Clearing the field a shop was
                // just told to keep is the exact backwards step the suffix
                // exists to avoid -- the ending is the only part it is being
                // asked to change.
                ? { label: 'Clear the ending', onPress: () => setTypedSuffix('') }
                : { label: 'Clear and try again', onPress: () => onChange({ slug: '' }) }
          }
        >
          {slugNote.text}
        </Caveat>
      ) : null}

      <Pressable
        testID="content-drawer-claim-button"
        disabled={claimDisabled}
        onPress={() => onClaimSlug(value.slug)}
        style={[styles.claimButton, claimDisabled && styles.claimButtonDisabled]}
      >
        <Text style={styles.claimButtonText}>{value.slug ? 'Update address' : 'Claim this address'}</Text>
      </Pressable>

      <Text style={[styles.eyebrow, styles.spaced]}>Headline</Text>
      <TextInput
        style={styles.textInput}
        value={value.headline}
        onChangeText={(text) => onChange({ headline: text })}
        placeholder="What should a customer see first?"
      />

      <Text style={[styles.eyebrow, styles.spaced]}>About</Text>
      <TextInput
        style={[styles.textInput, styles.multiline]}
        value={value.about}
        onChangeText={(text) => onChange({ about: text })}
        placeholder="Tell customers what you sell and why they should visit."
        multiline
        numberOfLines={3}
      />

      <Text style={[styles.eyebrow, styles.spaced]}>Opening photo</Text>
      <Caveat tone="context">Only the Window layout shows this photo — a shop on Market won&apos;t display it here.</Caveat>
      <View style={styles.heroRow}>
        {value.heroImageUrl ? <Image source={{ uri: value.heroImageUrl }} style={styles.heroPreview} /> : null}
        <Pressable
          testID="content-drawer-hero-pick"
          onPress={handlePickHero}
          disabled={heroUploading}
          style={[styles.heroButton, heroUploading && styles.heroButtonDisabled]}
        >
          <Text style={styles.heroButtonText}>
            {heroUploading ? 'Uploading…' : value.heroImageUrl ? 'Replace photo' : 'Add photo'}
          </Text>
        </Pressable>
      </View>
      {heroError ? (
        <Caveat tone="wrong" action={{ label: 'Try again', onPress: handlePickHero }}>
          {heroError}
        </Caveat>
      ) : null}

      <Text style={[styles.eyebrow, styles.spaced]}>WhatsApp number</Text>
      {value.whatsappE164 ? <Text style={styles.currentPhone}>{formatE164ForDisplay(value.whatsappE164)}</Text> : null}
      <TextInput
        ref={phoneInputRef}
        testID="content-drawer-phone-input"
        style={styles.textInput}
        value={phoneDraft}
        onChangeText={(text) => {
          setPhoneDraft(text);
          if (phoneError) setPhoneError(null);
        }}
        onBlur={commitPhone}
        placeholder="e.g. 0634 456 789"
        keyboardType="phone-pad"
      />
      {phoneError ? (
        <Caveat
          tone="wrong"
          action={{
            label: 'Clear number',
            onPress: () => {
              setPhoneDraft('');
              setPhoneError(null);
            },
          }}
        >
          {phoneError}
        </Caveat>
      ) : null}
    </BentoCard>
  );
}

const styles = StyleSheet.create({
  eyebrow: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted,
    marginBottom: 8,
  },
  spaced: { marginTop: 16 },

  slugRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSoft,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  slugSuffix: { fontSize: 13.5, fontWeight: '700', color: theme.bentoMuted2 },
  slugInput: { flex: 1, fontSize: 13.5, fontWeight: '700', color: theme.bentoInk, paddingVertical: 11 },
  // Muted, like the domain on the other end of the row: both are parts of the
  // address the shop is not editing right now.
  slugBase: { fontSize: 13.5, fontWeight: '700', color: theme.bentoMuted2, paddingVertical: 11 },

  fullAddress: { marginTop: 8, fontSize: 12.5, fontWeight: '700', color: theme.bentoInk },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 9 },
  chip: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    backgroundColor: theme.bentoSurface,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipSelected: { backgroundColor: theme.bentoAccentWash, borderColor: theme.bentoAccentWash },
  chipText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk2 },
  chipTextSelected: { color: theme.bentoAccentInk },
  chipHint: { marginTop: 7, fontSize: 12, color: theme.bentoMuted },

  suggestionRow: { alignSelf: 'flex-start', marginTop: 8 },
  suggestionText: { fontSize: 12, fontWeight: '700', color: theme.bentoAccentInk },

  // Deliberately NOT accent-coloured, unlike suggestionText above -- this is
  // the quiet way out, not the path most shops should take.
  suffixExitRow: { alignSelf: 'flex-start', marginTop: 8 },
  suffixExitText: { fontSize: 12, fontWeight: '600', color: theme.bentoMuted },

  claimButton: {
    marginTop: 12,
    alignSelf: 'flex-start',
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  claimButtonDisabled: { opacity: 0.4 },
  claimButtonText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoSurface },

  textInput: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSoft,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 13.5,
    color: theme.bentoInk,
  },
  multiline: { minHeight: 72, textAlignVertical: 'top' },

  heroRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  heroPreview: { width: 48, height: 48, borderRadius: 10, backgroundColor: theme.bentoSoft },
  heroButton: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  heroButtonDisabled: { opacity: 0.5 },
  heroButtonText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk },

  currentPhone: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk, marginBottom: 8 },
});
