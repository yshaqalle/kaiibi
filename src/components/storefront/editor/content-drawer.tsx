import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { copyText } from '@/lib/copy-text';
import { formatE164ForDisplay, toE164 } from '@/lib/phone-e164';
import { pickPhotoFromLibrary } from '@/lib/photo-picker';
import { applySuffix, deriveSlugFromName, type SlugProblem } from '@/lib/storefront-slug';
import { STOREFRONT_ADDRESS_PREFIX, storefrontAddress } from '@/lib/storefront-host';

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

// The sentence a shop gets when its address has stopped matching its name --
// which is exactly what renaming the shop does to it.
//
// Saying NOTHING here is the failure mode. A shopkeeper who renamed the shop
// and expected the address to follow reads an unchanged address as a rename
// that half-failed, and goes looking for what else broke. This is the only
// place the app can tell them it was deliberate.
//
// Phrased to be true of every shop that sees it, not just a renamed one: a
// shop that claimed `xamdi` while its name derives `xamdi-electronics` never
// renamed anything, and "you renamed your shop" would be a lie to it. What IS
// true of both is that the address did not follow the name, has not changed,
// and still works everywhere it has already been given out.
//
// 'context', not 'wrong': nothing is broken and there is nothing to remove. A
// 'wrong' caveat promises an action that clears it (see Caveat's own header),
// and the only action on offer here -- changing the address -- is the exact
// thing this note exists to stop a shop doing by reflex.
const RENAME_KEPT_ADDRESS_COPY =
  'Your web address has not changed with your shop’s name — every link you have already shared or printed still works. ' +
  'You can change it below, but the old one stops working straight away.';

// Said BEFORE the press rather than discovered after it. `no_whatsapp` is a
// publish blocker (publishBlockers, storefront-admin.ts), so clearing the
// number puts a shop into a state where its NEXT publish is refused -- the
// live page stays up until then, and the publish bar says so with a "Fix this"
// that lands back on this very field.
//
// 'context', not 'wrong': while the number is still there nothing is broken
// and there is nothing to fix. This states a consequence a shop is about to
// choose, which is what that tone is for. The mild overlap with the publish
// bar's own blocker copy is the point -- one is a warning, the other is a
// report, and only the warning arrives in time to change the decision.
const PHONE_REMOVE_COPY =
  'Removing it takes the WhatsApp button off your page, and you’ll need a number again before you can publish.';

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
  // Optional with inert defaults, the same posture `shopName` and
  // `claimedSlug` already take: a caller that has not wired these yet renders
  // the fields read-only rather than failing to compile.
  tradingSince = '',
  tradingSinceError = null,
  onChangeTradingSince = () => {},
  highlights = [],
  onChangeHighlight = () => {},
  instagram = '',
  onChangeInstagram = () => {},
  highlightsError = null,
  onRetryHighlights,
  instagramError = null,
  onRetryInstagram,
  gallery = [],
  onAddGalleryImage,
  onRemoveGalleryImage,
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
  /**
   * The year the shop opened, as typed. A STRING and not a number: a
   * half-typed "20" is a legitimate intermediate state, and parsing on every
   * keystroke would delete the second character as it was entered.
   *
   * This and the highlights below save LIVE, like the delivery areas and
   * auto-advance -- publish_storefront copies a fixed list of keys out of
   * `draft` and neither is on it, so staging them would silently never
   * publish. The Caveats on both say so on screen.
   */
  tradingSince?: string;
  /**
   * ONE FIELD'S ERROR, and only that field's.
   *
   * This prop used to be handed `tradingSinceError ?? highlightsError` while
   * the Instagram save's own catch wrote to it too -- so three unrelated
   * failures all surfaced as one caveat under Trading since. A shop whose
   * handle failed to save was told "could not save that" beside a year it had
   * never touched, while the Instagram box sat there looking healthy.
   *
   * Each save now reports under the field that owns it. That is also what lets
   * the two below carry an action: a shared caveat could not offer a retry
   * because it did not know which of three writes had failed.
   */
  tradingSinceError?: string | null;
  onChangeTradingSince?: (text: string) => void;
  highlights?: { title: string; body: string }[];
  onChangeHighlight?: (index: number, patch: { title?: string; body?: string }) => void;
  /** A failed highlights write, shown under the three cards. */
  highlightsError?: string | null;
  /** Re-runs that write. Required for the caveat's `wrong` tone to be honest. */
  onRetryHighlights?: () => void;
  /**
   * Photographs of the shop, already resolved to URLs. Live rows again, like
   * the highlights -- and unlike the hero, which is a single staged field.
   */
  /** Instagram handle as typed. Normalised on save, not on keystroke. */
  instagram?: string;
  onChangeInstagram?: (text: string) => void;
  /** A failed handle write, shown under the handle. */
  instagramError?: string | null;
  onRetryInstagram?: () => void;
  gallery?: { id: string; url: string }[];
  onAddGalleryImage?: (localUri: string) => Promise<void>;
  onRemoveGalleryImage?: (id: string) => Promise<void>;
}) {
  const [phoneDraft, setPhoneDraft] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  // Has the shop deliberately asked to change an address it already claimed?
  // Local, and deliberately NOT persisted: a reload puts a claimed address
  // back behind its button, which is where an address printed on a card
  // belongs. Nothing else sets this -- there is exactly one way in, the
  // "Change address…" button, which is what makes the change deliberate.
  const [changingAddress, setChangingAddress] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [heroUploading, setHeroUploading] = useState(false);
  const [heroError, setHeroError] = useState<string | null>(null);
  const [galleryBusy, setGalleryBusy] = useState(false);
  const [galleryError, setGalleryError] = useState<string | null>(null);
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

  const claimed = claimedSlug?.trim() ?? '';
  // THE FREEZE. A claimed address is not an editable field that happens to
  // hold the right value -- it is a fact, rendered read-only, with a button
  // next to it. That distinction is the whole guarantee: an editable field
  // can be overwritten by a stray tap, an autofill, or the next effect
  // somebody adds to this file, and the shop would never see it happen.
  const frozen = claimed.length > 0 && !changingAddress;

  // Does the claimed address still follow the shop's name? A SUFFIXED address
  // still does -- `xamdi-electronics-koodbuur` under "Xamdi Electronics" is
  // the ordinary outcome of a collision, not a shop whose address drifted --
  // which is why this is a prefix test and not an equality one. An empty
  // derived name (a shop with no name yet) has nothing to disagree with.
  const addressFollowsName = derived.length === 0 || claimed === derived || claimed.startsWith(`${derived}-`);

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
    if (claimed) return;
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
  }, [derived, claimed, collisionBase]);

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

  // ...and the collision is OVER the moment the shop wins one. Without this,
  // claiming through the suffix field leaves the drawer in both states at
  // once: the frozen base and its assembled address above, the claimed
  // read-only row below, and between them a banner still saying the name
  // belongs to another shop -- about the address the shop has just been
  // granted. Browser verification caught this; no unit test did, because each
  // state was only ever asserted on its own.
  if (claimed && collisionBase !== null && claimed === value.slug.trim()) {
    setCollisionBase(null);
    setTypedSuffix(null);
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

  // The one way out of the freeze, and it is a deliberate press. Nothing
  // automatic reaches this -- not a rename, not a remount, not an effect.
  function startChangingAddress() {
    setChangingAddress(true);
    setCopied(false);
    setCopyError(null);
  }

  // Backing out. Puts the draft back to the claimed address BYTE FOR BYTE,
  // because the read-only row renders `value.slug` -- leaving a half-typed
  // edit behind would have the shop reading an address it never claimed, off
  // the very row it is meant to be able to trust. Clears `slugTouchedRef`
  // too: an abandoned edit is not the shop choosing its own address, and
  // leaving that flag set would mean the freeze afterwards was being held by
  // the wrong guard.
  function keepClaimedAddress() {
    setChangingAddress(false);
    setCollisionBase(null);
    setTypedSuffix(null);
    slugTouchedRef.current = false;
    if (value.slug !== claimed) onChange({ slug: claimed });
  }

  // A shop's address is worth nothing in an app it cannot get out of. HOW the
  // text gets out (clipboard on the web, the share sheet on a phone, and no
  // new dependency for either) lives in copyText -- shared with the publish
  // bar, which offers the same copy on a live page. This function is only
  // what it MEANS here: the word on the button, and the sentence when it did
  // not work.
  async function handleCopyAddress() {
    setCopyError(null);
    if (await copyText(fullAddress)) {
      setCopied(true);
      return;
    }
    setCopied(false);
    setCopyError('Could not copy your address — write it down instead.');
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
  // Hidden while frozen as well as in suffix mode: there is no field to
  // accept it into, and offering the new name next to a read-only address is
  // the exact nudge this task exists to remove. It comes back the moment the
  // shop asks to change the address, which is when it is a real offer again.
  const showSuggestion = !inSuffixMode && !frozen && derived.length > 0 && derived !== value.slug.trim();
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
  const fullAddress = storefrontAddress(value.slug.trim());

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

  // THE WAY BACK OUT, and until now there wasn't one.
  //
  // `commitPhone` deliberately ignores an empty field on blur -- an accidental
  // blur must not wipe a number a shop has printed on a card -- which is right,
  // and which left clearing a saved number impossible by any route. This is
  // that route: pressed on purpose, which is the same standard "Change
  // address…" holds the slug to.
  //
  // The draft and the error go with it. Pressing Remove while a half-typed
  // replacement sits in the box would otherwise leave that draft on screen, and
  // the field's own onBlur -- which fires on the way to this button -- would
  // commit the very number the shop just asked to be rid of.
  function removePhone() {
    setPhoneDraft('');
    setPhoneError(null);
    onChange({ whatsappE164: null });
  }

  async function handleAddGallery() {
    setGalleryError(null);
    const result = await pickPhotoFromLibrary();
    if (result.status === 'canceled') return;
    if (result.status === 'failed') { setGalleryError(result.message); return; }
    if (!onAddGalleryImage) {
      setGalleryError('Photo upload is not available right now.');
      return;
    }
    setGalleryBusy(true);
    try {
      await onAddGalleryImage(result.uri);
    } catch {
      setGalleryError('Could not upload that photo — try again.');
    } finally {
      setGalleryBusy(false);
    }
  }

  async function handleRemoveGallery(id: string) {
    if (!onRemoveGalleryImage) return;
    setGalleryError(null);
    setGalleryBusy(true);
    try {
      await onRemoveGalleryImage(id);
    } catch {
      // Named rather than silent: the object may already be gone from storage
      // while the row remains, and "try again" is the correct next move.
      setGalleryError('Could not remove that photo — try again.');
    } finally {
      setGalleryBusy(false);
    }
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
      {/* The field shows the WHOLE address, not just the part being typed --
          a shop should never have to join a box and a domain in its head
          before printing the result on a card. The fixed part comes from
          STOREFRONT_ADDRESS_PREFIX (src/lib/storefront-host.ts), the same
          source every other address on this screen is built from, so the box
          cannot teach one form while Copy link hands over another. That is
          precisely what happened: this row taught `<slug>.kaiibi.com`, which
          no DNS record resolves. */}
      <View style={styles.slugRow}>
        <Text style={styles.slugPrefix}>{STOREFRONT_ADDRESS_PREFIX}</Text>
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
            style={[styles.slugInput, frozen && styles.slugInputFrozen]}
            value={value.slug}
            // The freeze, at the one place a keystroke could reach it.
            editable={!frozen}
            onChangeText={(text) => {
              slugTouchedRef.current = true;
              onChange({ slug: text });
            }}
            placeholder="your-shop-name"
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
      </View>

      {/* A claimed address, in one piece and ready to be copied. Built by
          storefrontAddress -- the same call Copy link below hands to the
          clipboard, so what is read off the screen and what is pasted into
          WhatsApp are one string and not two that happen to agree today. */}
      {frozen ? (
        <>
          <Text testID="content-drawer-claimed-address" style={styles.fullAddress}>
            {storefrontAddress(claimed)}
          </Text>
          <View style={styles.claimedActions}>
            <Pressable testID="content-drawer-copy-address" onPress={handleCopyAddress} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>{copied ? 'Copied' : 'Copy link'}</Text>
            </Pressable>
            {/* The only way into an editable address. One door, pressed on
                purpose, is what makes changing it deliberate rather than
                something a shop discovers it has done. */}
            <Pressable testID="content-drawer-change-address" onPress={startChangingAddress} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Change address…</Text>
            </Pressable>
          </View>
          {copyError ? <Caveat tone="context">{copyError}</Caveat> : null}
        </>
      ) : null}

      {/* Property 4, and the one that gets skipped. A shopkeeper who renamed
          the shop and expected the address to follow reads an unchanged
          address as a rename that half-failed. Only shown once the address has
          actually stopped following the name -- telling a shop its address
          "did not change with your name" when it still matches would be noise,
          and telling a suffixed shop it renamed something it never renamed
          would be a lie. */}
      {claimed.length > 0 && !addressFollowsName ? (
        <Caveat tone="context">{RENAME_KEPT_ADDRESS_COPY}</Caveat>
      ) : null}

      {inSuffixMode ? (
        <>
          {/* The assembled address, in full and in one piece, built by
              storefrontAddress like every other address on this screen -- a
              shop reading a prefix, a base and a box separately should not
              have to do the joining in its head before printing it on a
              card. */}
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

      {/* The warning arrives WITH the editable field, not before it. While the
          address is frozen there is nothing to warn about -- and a standing
          warning on a screen where nothing can go wrong is how a shop learns
          to read past the ones that matter. */}
      {value.slug && !frozen ? (
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

      {/* No claim button while the address is frozen. The button IS the edit
          affordance -- leaving it under a read-only field invites the tap this
          whole task exists to prevent. */}
      {frozen ? null : (
        <Pressable
          testID="content-drawer-claim-button"
          disabled={claimDisabled}
          onPress={() => onClaimSlug(value.slug)}
          style={[styles.claimButton, claimDisabled && styles.claimButtonDisabled]}
        >
          <Text style={styles.claimButtonText}>{value.slug ? 'Update address' : 'Claim this address'}</Text>
        </Pressable>
      )}

      {/* Backing out has to restore the CLAIMED value, not merely stop
          editing: a half-typed edit left in the draft is what the read-only
          row would then go on showing, and the shop would read an address it
          never claimed. Clearing the touched flag matters just as much -- a
          stale one would leave the address protected only by accident, and the
          next rename would find nothing standing in its way. */}
      {changingAddress ? (
        <Pressable testID="content-drawer-change-cancel" onPress={keepClaimedAddress} style={styles.suffixExitRow}>
          <Text style={styles.suffixExitText}>Keep my current address</Text>
        </Pressable>
      ) : null}

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

      <Text style={[styles.eyebrow, styles.spaced]}>Trading since</Text>
      <Caveat tone="context">Saves straight to your live page, like your delivery areas — it isn&apos;t held until you publish.</Caveat>
      <TextInput
        testID="content-drawer-trading-since"
        style={styles.textInput}
        value={tradingSince}
        onChangeText={onChangeTradingSince}
        placeholder="2014"
        keyboardType="number-pad"
        maxLength={4}
      />
      {tradingSinceError ? <Caveat tone="wrong">{tradingSinceError}</Caveat> : null}

      <Text style={[styles.eyebrow, styles.spaced]}>Why shop here</Text>
      <Caveat tone="context">
        Up to three things you want customers to know. Both lines are needed for a card to show — and these
        save straight to your live page.
      </Caveat>
      {[0, 1, 2].map((index) => (
        <View key={index} style={styles.highlightBlock}>
          <TextInput
            testID={`content-drawer-highlight-title-${index}`}
            style={styles.textInput}
            value={highlights[index]?.title ?? ''}
            onChangeText={(text) => onChangeHighlight(index, { title: text })}
            placeholder={HIGHLIGHT_PLACEHOLDERS[index].title}
            maxLength={60}
          />
          <TextInput
            testID={`content-drawer-highlight-body-${index}`}
            style={[styles.textInput, styles.multiline, styles.highlightBody]}
            value={highlights[index]?.body ?? ''}
            onChangeText={(text) => onChangeHighlight(index, { body: text })}
            placeholder={HIGHLIGHT_PLACEHOLDERS[index].body}
            multiline
            numberOfLines={2}
            maxLength={240}
          />
        </View>
      ))}
      {highlightsError ? (
        <Caveat
          tone="wrong"
          action={onRetryHighlights ? { label: 'Try again', onPress: onRetryHighlights } : undefined}
        >
          {highlightsError}
        </Caveat>
      ) : null}

      <Text style={[styles.eyebrow, styles.spaced]}>Instagram</Text>
      <Caveat tone="context">
        Shown on your Visit tab. Paste a link or type the handle — saves straight to your live page.
      </Caveat>
      <TextInput
        testID="content-drawer-instagram"
        style={styles.textInput}
        value={instagram}
        onChangeText={onChangeInstagram}
        placeholder="@yourshop"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {instagramError ? (
        <Caveat
          tone="wrong"
          action={onRetryInstagram ? { label: 'Try again', onPress: onRetryInstagram } : undefined}
        >
          {instagramError}
        </Caveat>
      ) : null}

      <Text style={[styles.eyebrow, styles.spaced]}>Photos of the shop</Text>
      <Caveat tone="context">
        Up to six, shown on your About tab. These save straight to your live page.
      </Caveat>
      <View style={styles.galleryRow}>
        {gallery.map((image) => (
          <View key={image.id} style={styles.galleryItem}>
            <Image source={{ uri: image.url }} style={styles.galleryThumb} />
            <Pressable
              testID={`content-drawer-gallery-remove-${image.id}`}
              accessibilityRole="button"
              accessibilityLabel="Remove this photo"
              onPress={() => handleRemoveGallery(image.id)}
              style={styles.galleryRemove}
            >
              <Text style={styles.galleryRemoveText}>✕</Text>
            </Pressable>
          </View>
        ))}
        {gallery.length < GALLERY_MAX ? (
          <Pressable
            testID="content-drawer-gallery-add"
            onPress={handleAddGallery}
            disabled={galleryBusy}
            style={[styles.galleryAdd, galleryBusy && styles.ghostButtonDisabled]}
          >
            <Text style={styles.galleryAddText}>{galleryBusy ? '…' : '+'}</Text>
          </Pressable>
        ) : null}
      </View>
      {galleryError ? <Caveat tone="wrong">{galleryError}</Caveat> : null}

      <Text style={[styles.eyebrow, styles.spaced]}>Opening photo</Text>
      <Caveat tone="context">Only the Window layout shows this photo — a shop on Market won&apos;t display it here.</Caveat>
      <View style={styles.heroRow}>
        {value.heroImageUrl ? <Image source={{ uri: value.heroImageUrl }} style={styles.heroPreview} /> : null}
        <Pressable
          testID="content-drawer-hero-pick"
          onPress={handlePickHero}
          disabled={heroUploading}
          style={[styles.ghostButton, heroUploading && styles.ghostButtonDisabled]}
        >
          <Text style={styles.ghostButtonText}>
            {heroUploading ? 'Uploading…' : value.heroImageUrl ? 'Replace photo' : 'Add photo'}
          </Text>
        </Pressable>
        {/* Replace was the only exit this field had, so a shop that changed
            its mind about having an opening photo at all had to upload a
            different one instead. Every COLLECTION in this drawer already
            removes -- each gallery thumbnail, and the flyers and delivery
            areas in their own cards -- and the two singletons, this and the
            number below, were the two that did not.

            No confirm, matching those. The Window layout simply falls back to
            no photo, which is the state every shop that never added one is
            already in. The uploaded object stays in the bucket, which is what
            replacing a photo does today too. */}
        {value.heroImageUrl ? (
          <Pressable
            testID="content-drawer-hero-remove"
            accessibilityRole="button"
            accessibilityLabel="Remove the opening photo"
            onPress={() => onChange({ heroImageUrl: null })}
            disabled={heroUploading}
            style={[styles.ghostButton, heroUploading && styles.ghostButtonDisabled]}
          >
            <Text style={styles.ghostButtonText}>Remove</Text>
          </Pressable>
        ) : null}
      </View>
      {heroError ? (
        <Caveat tone="wrong" action={{ label: 'Try again', onPress: handlePickHero }}>
          {heroError}
        </Caveat>
      ) : null}

      <Text style={[styles.eyebrow, styles.spaced]}>WhatsApp number</Text>
      {value.whatsappE164 ? (
        <>
          <View style={styles.currentPhoneRow}>
            <Text style={styles.currentPhone}>{formatE164ForDisplay(value.whatsappE164)}</Text>
            <Pressable
              testID="content-drawer-phone-remove"
              accessibilityRole="button"
              accessibilityLabel="Remove your WhatsApp number"
              onPress={removePhone}
              style={styles.ghostButton}
            >
              <Text style={styles.ghostButtonText}>Remove</Text>
            </Pressable>
          </View>
          <Caveat tone="context">{PHONE_REMOVE_COPY}</Caveat>
        </>
      ) : null}
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

// Placeholders that do real work: an empty field must read as "this is what a
// good one looks like", not as a blank box. Three different shapes on purpose --
// a promise, a standard, a service -- so a shop does not write the same
// sentence three times.
// Mirrors GALLERY_LIMIT in storefront-admin.ts. Not imported, because this
// component takes no data layer -- the caller owns that, and a drawer that
// reached into it would be harder to render in a test than it is worth.
const GALLERY_MAX = 6;

const HIGHLIGHT_PLACEHOLDERS = [
  { title: 'We fix what we sell', body: 'Anything bought here that stops working inside a year, bring it back.' },
  { title: 'Weighed in front of you', body: 'One scale, on the counter, facing the customer.' },
  { title: 'Same-day delivery', body: 'Order before 16:00 and it reaches you the same evening.' },
];

const styles = StyleSheet.create({
  galleryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  galleryItem: { position: 'relative' },
  galleryThumb: { width: 78, height: 78, borderRadius: 12 },
  galleryRemove: {
    position: 'absolute', top: -6, right: -6, width: 24, height: 24, borderRadius: 12,
    backgroundColor: '#111111', alignItems: 'center', justifyContent: 'center',
  },
  galleryRemoveText: { color: '#ffffff', fontSize: 12, fontWeight: '800' },
  galleryAdd: {
    width: 78, height: 78, borderRadius: 12, borderWidth: 1.5, borderStyle: 'dashed',
    borderColor: '#c9c9d2', alignItems: 'center', justifyContent: 'center',
  },
  galleryAddText: { fontSize: 22, color: '#5e5d65', fontWeight: '700' },
  highlightBlock: { gap: 8, marginTop: 10 },
  highlightBody: { minHeight: 60 },
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
  // Muted, like the domain at the head of the row: both are parts of the
  // address the shop is not editing right now.
  slugBase: { fontSize: 13.5, fontWeight: '700', color: theme.bentoMuted2, paddingVertical: 11 },
  // A claimed address should not LOOK like a box waiting for a keystroke. The
  // freeze is enforced by `editable`, but a field that still reads as editable
  // invites the tap and then swallows it, which is its own kind of broken.
  slugInputFrozen: { color: theme.bentoMuted2 },

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
  claimedActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  secondaryButton: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    paddingVertical: 9,
    paddingHorizontal: 14,
    backgroundColor: theme.bentoSurface,
  },
  secondaryButtonText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk2 },

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
  ghostButton: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  ghostButtonDisabled: { opacity: 0.5 },
  ghostButtonText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk },

  // Wraps, because a long number and the button do not always fit a narrow
  // phone side by side -- and a Remove pushed off the edge is the same missing
  // exit this change exists to close.
  currentPhoneRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  // No marginBottom of its own any more: the Caveat that now always follows it
  // brings its own marginTop, and two would double the gap.
  currentPhone: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk },
});
