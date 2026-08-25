import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { formatE164ForDisplay, toE164 } from '@/lib/phone-e164';
import { pickPhotoFromLibrary } from '@/lib/photo-picker';
import { normalizeSlug, type SlugProblem } from '@/lib/storefront-slug';

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

export function ContentDrawer({
  value,
  onChange,
  onClaimSlug,
  slugState,
  shopName = '',
  onUploadHeroImage,
  focusRequest,
}: {
  value: ContentDrawerValue;
  onChange: (patch: Partial<ContentDrawerValue>) => void;
  onClaimSlug: (slug: string) => void;
  slugState: SlugState;
  /** Used only to SUGGEST a slug -- see the property this file exists to satisfy: never written into the field for them. */
  shopName?: string;
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
  const phoneInputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.field === 'slug') slugInputRef.current?.focus();
    else phoneInputRef.current?.focus();
    // Only the token needs to be a dependency -- it changes on every request,
    // including a second press that names the same field, which is exactly
    // when a re-focus (not a no-op) is the useful behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.token]);

  const suggestion = normalizeSlug(shopName);
  const showSuggestion = suggestion.length > 0 && suggestion !== value.slug.trim();
  const slugNote = SLUG_STATE_COPY[slugState];
  const claimDisabled = !value.slug.trim() || slugState === 'checking';

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
      <View style={styles.slugRow}>
        <Text style={styles.slugPrefix}>kaiibi.com/</Text>
        <TextInput
          ref={slugInputRef}
          testID="content-drawer-slug-input"
          style={styles.slugInput}
          value={value.slug}
          onChangeText={(text) => onChange({ slug: text })}
          placeholder="your-shop-name"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {showSuggestion ? (
        <Pressable
          testID="content-drawer-slug-suggestion-accept"
          onPress={() => onChange({ slug: suggestion })}
          style={styles.suggestionRow}
        >
          <Text style={styles.suggestionText}>Suggested: {suggestion}</Text>
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
            slugNote.tone === 'wrong' ? { label: 'Clear and try again', onPress: () => onChange({ slug: '' }) } : undefined
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
  slugPrefix: { fontSize: 13.5, fontWeight: '700', color: theme.bentoMuted2 },
  slugInput: { flex: 1, fontSize: 13.5, fontWeight: '700', color: theme.bentoInk, paddingVertical: 11 },

  suggestionRow: { alignSelf: 'flex-start', marginTop: 8 },
  suggestionText: { fontSize: 12, fontWeight: '700', color: theme.bentoAccentInk },

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
