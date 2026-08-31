import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { copyText } from '@/lib/copy-text';
import { storefrontAddress } from '@/lib/storefront-host';
import type { LapseReason, PublishBlocker } from '@/lib/storefront-admin';
import { shareOnWhatsApp } from '@/lib/whatsapp';

// Pinned to the light palette -- no dark mode yet, same as every other bento
// screen.
const theme = Colors.light;

// Free of every data-layer import (no lib/storefront-admin at runtime, only
// its `PublishBlocker` type): the caller already ran publishBlockers() and
// hands the result down. This component only turns that result into
// sentences and buttons.

// Plain words a shopkeeper can act on -- never the raw enum. Each entry names
// what to add, not what is missing in the abstract, so it reads the same as
// the fix a tap on it leads to.
const BLOCKER_COPY: Record<PublishBlocker, string> = {
  no_slug: 'Set a web address so customers have somewhere to find your page.',
  no_whatsapp: 'Add a WhatsApp number so customers can reach you from the page.',
  no_products: 'Add at least one product marked to sell online.',
};

// WHERE each blocker's fix actually is, which is not the same place for all
// three -- and the label has to say so.
//
// Every blocker renders as a `wrong` caveat, and caveat.tsx's header is
// explicit that a `wrong` caveat must always carry an action that can remove
// its cause: one that cannot trains people to ignore the whole family. Two of
// these are fixed by a field in this very drawer, so "Fix this" is the honest
// word for them. `no_products` is not: a product marked to sell online is
// added in Inventory, a different screen, so its action names that
// destination rather than promising an edit right here.
//
// Per-blocker rather than a branch inside one shared handler, so the label and
// the thing it does are decided in one place and cannot drift apart.
const BLOCKER_ACTION: Record<PublishBlocker, { label: string; goes: 'here' | 'inventory' }> = {
  no_slug: { label: 'Fix this', goes: 'here' },
  no_whatsapp: { label: 'Fix this', goes: 'here' },
  no_products: { label: 'Go to Inventory', goes: 'inventory' },
};

// WHY the page came down, in the shop's own words, ONE SENTENCE PER CAUSE.
//
// The trigger that takes the page down (20260930000500) fires on two different
// dark states, and they are not the same news. Collapsing them onto one line
// would mean telling a shop that was current on its bill, and was suspended by
// us, that its plan had lapsed -- which is false, and which sends it hunting
// for a payment problem it does not have instead of getting in touch with us.
// A false WHY is worse than no WHY; that is the whole reason this text exists.
//
// Both entries end the same way, because the ACTION is the same in both cases
// and it is the thing worth doing before publishing: a page that has been off
// for a month may be advertising last month's prices to a customer who then
// orders at them. The suspension line adds who to talk to, in the same register
// the billing panel already uses for a paused account ("Please get in touch
// with us").
const LAPSE_COPY: Record<LapseReason, string> = {
  lapsed:
    'Your page came down while your plan had lapsed. Check your prices and offers are still right, then publish it again.',
  suspended:
    'Your page came down while your account was paused by us. Get in touch with us if you do not know why. Check your prices and offers are still right, then publish it again.',
};

// The message a shop sends its customers, written to be forwarded: it names
// the shop (a message passed on has no other context), says what the link is
// for in the plain register the rest of this app uses, and ends on the
// address so it is the last thing read and the easy thing to tap.
//
// The address is passed in, never rebuilt here -- it is assembled once, by
// storefrontAddress, and the same value is rendered on screen and copied.
function sharePageMessage(shopName: string, address: string): string {
  const who = shopName.trim();
  return `${who || 'Our shop'} is now online — see what we sell and order from your phone: ${address}`;
}

// THE PROPERTY THIS FILE EXISTS FOR: Publish is never disabled. A greyed-out
// button with no explanation is precisely the failure this screen prevents --
// pressing it always calls onPublish, blockers or not. What a blocker means
// is said in the Caveat below, in words, not by taking the button away.
export function PublishBar({
  status,
  blockers,
  dirty,
  slug,
  shopName = '',
  unpublishedBy = null,
  onEdit,
  isWide,
  onFocusBlocker,
  onGoToInventory,
  onTogglePreview,
  onPublish,
  onUnpublish,
}: {
  status: 'draft' | 'live';
  blockers: PublishBlocker[];
  dirty: boolean;
  /**
   * The address the page is reachable at, or null while the shop has claimed
   * none. Only ever rendered (and only ever shareable) while `status` is
   * 'live' -- see the share block below.
   */
  slug: string | null;
  /** Named in the WhatsApp message, which gets forwarded away from any context. */
  shopName?: string;
  /**
   * WHY this page is a draft when the shop did not choose that -- the cause
   * that took it down, or null when no such cause was recorded (never
   * published, or the shop unpublished it itself).
   *
   * `'lapsed'` is a missed payment; `'suspended'` is an operator suspending
   * the shop. Read from storefronts.lapse_unpublished_reason, which the
   * 20260930000500 trigger stamps and publish_storefront clears, so this goes
   * null again the moment the shop publishes.
   *
   * The cause is passed through rather than reduced to a boolean here,
   * because the two get DIFFERENT sentences: telling a shop that was current
   * on its bill that its plan lapsed is simply untrue, and it hides the one
   * fact a suspended shop needs -- that a person did this and it is us to ask.
   *
   * Only ever meaningful while `status` is 'draft'; the render below checks
   * both rather than trusting the caller, because a live page carrying either
   * sentence would be flatly wrong on screen.
   */
  unpublishedBy?: LapseReason | null;
  /** The Edit button. Opens the editor; knows nothing about blockers. */
  onEdit: () => void;
  /**
   * Whether the editor is showing its two-column layout. On a wide screen the
   * content drawer and the preview are both permanently on screen, so Preview
   * and Edit have nothing to navigate to -- their handlers on the screen are
   * `if (!isWide)` no-ops. Passed down so the BUTTONS can be absent rather than
   * present and inert: the same rule theme-shared.tsx states for the
   * customer-facing Ask button.
   *
   * Optional, defaulting to the narrow layout, so a caller that predates this
   * still renders the full row rather than silently losing two controls.
   */
  isWide?: boolean;
  /**
   * Jumps to the field that fixes this blocker, on this screen. Called only
   * for the blockers BLOCKER_ACTION marks `here` -- which is why it takes the
   * blocker rather than being one shared "open the editor": "Fix this" has to
   * land on the slug box or the WhatsApp box, not merely nearby.
   */
  onFocusBlocker: (blocker: PublishBlocker) => void;
  /**
   * Leaves this screen for Inventory, which is where the only fix for
   * `no_products` lives. Separate on purpose -- see BLOCKER_ACTION above.
   */
  onGoToInventory: () => void;
  onTogglePreview: () => void;
  onPublish: () => void;
  /** Ignored while `status` is 'draft' -- there is nothing live to unpublish. */
  onUnpublish: () => void;
}) {
  const [confirmingUnpublish, setConfirmingUnpublish] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // The address, from storefrontAddress and nowhere else -- never assembled
  // here. This screen shipped its own copy once, and that copy said
  // `<slug>.kaiibi.com`, a form no DNS record has ever resolved: a shop
  // pressed Copy link, sent it, and the customer got a DNS failure. WHICH form
  // that function returns is its business (and the backlog doc's), not this
  // component's; what matters here is that the string shown, the string
  // copied, and the string in the WhatsApp message are all this one value.
  const claimedSlug = slug?.trim() ?? '';
  // ONLY when live. A draft page's address does not resolve, so offering to
  // send it would hand a shopkeeper a link that 404s -- and they would only
  // find out from the customer who tried it.
  const shareable = status === 'live' && claimedSlug.length > 0;
  const address = storefrontAddress(claimedSlug);

  const statusLabel = status === 'draft' ? 'Draft' : dirty ? 'Unsaved changes' : 'Live';
  const statusStyle =
    status === 'draft' ? styles.statusDraft : dirty ? styles.statusUnsaved : styles.statusLive;
  const statusTextStyle =
    status === 'draft' ? styles.statusTextDraft : dirty ? styles.statusTextUnsaved : styles.statusTextLive;

  function confirmUnpublish() {
    setConfirmingUnpublish(false);
    onUnpublish();
  }

  // HOW the text gets out is copyText's business (clipboard on the web, the
  // share sheet on a phone, no new dependency) -- the same one function the
  // content drawer's Copy link goes through. This is only what it means here.
  async function handleCopyLink() {
    setCopyFailed(false);
    if (await copyText(address)) {
      setCopied(true);
      return;
    }
    setCopied(false);
    setCopyFailed(true);
  }

  return (
    <BentoCard
      title="Storefront"
      actions={
        <View style={[styles.statusPill, statusStyle]}>
          <Text style={[styles.statusText, statusTextStyle]}>{statusLabel}</Text>
        </View>
      }
    >
      <View style={styles.actionsRow}>
        {/* Only where they can act -- see the `isWide` prop's own note. On the
            two-column layout the drawer and the preview are already on screen,
            so these two would be buttons that shrug. */}
        {isWide ? null : (
          <>
            <Pressable testID="publish-bar-preview" onPress={onTogglePreview} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Preview</Text>
            </Pressable>
            <Pressable testID="publish-bar-edit" onPress={onEdit} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Edit</Text>
            </Pressable>
          </>
        )}
        {status === 'live' ? (
          <Pressable
            testID="publish-bar-unpublish"
            onPress={() => setConfirmingUnpublish(true)}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Unpublish</Text>
          </Pressable>
        ) : null}
        {/* No `disabled`, no `accessibilityState`, in any blocker state -- that
            is the property this component exists to hold. */}
        <Pressable testID="publish-bar-publish" onPress={onPublish} style={styles.publishButton}>
          <Text style={styles.publishButtonText}>Publish</Text>
        </Pressable>
      </View>

      {/* A page nobody has the link to is a page nobody visits. This sits ON
          the publish bar rather than behind "Edit page content →", because a
          shop that has just pressed Publish is standing right here and is
          never in that drawer. */}
      {shareable ? (
        <View style={styles.shareBlock}>
          <Text style={styles.shareEyebrow}>Your page is at</Text>
          <Text testID="publish-bar-address" style={styles.shareAddress}>
            {address}
          </Text>
          <View style={styles.shareRow}>
            {/* WhatsApp first: it is how these shops reach customers, and it
                is the action that actually sends the link to someone rather
                than only putting it somewhere. */}
            <Pressable
              testID="publish-bar-share-whatsapp"
              onPress={() => shareOnWhatsApp(sharePageMessage(shopName, address))}
              style={styles.shareButton}
            >
              <Text style={styles.shareButtonText}>Share on WhatsApp</Text>
            </Pressable>
            <Pressable
              testID="publish-bar-copy-link"
              onPress={handleCopyLink}
              style={[styles.secondaryButton, styles.shareSecondary]}
            >
              <Text style={styles.secondaryButtonText}>{copied ? 'Copied' : 'Copy link'}</Text>
            </Pressable>
          </View>
          {/* 'context', not 'wrong': nothing about the page is broken, and the
              address it failed to copy is on screen directly above -- there is
              no cause left for an action to remove. */}
          {copyFailed ? <Caveat tone="context">Could not copy your address — write it down instead.</Caveat> : null}
        </View>
      ) : null}

      {/* WHY the pill above says Draft, when the shop never chose that.
          Without this the shop opens the editor after paying, finds its page
          offline, and has nothing to go on -- the state is correct and
          completely unexplained.

          `wrong`, not `context`: caveat.tsx is explicit that `context` means
          "no action is required and none should be implied", and here action
          is exactly what is required -- the page stays offline until the shop
          publishes. So it carries the action that removes its own cause,
          which is the rule that tone comes with. Pressing it runs the same
          handler as the Publish button, blockers and all.

          The sentence names the cause and the thing worth doing before
          publishing, because that is the whole reason this is deliberate: a
          page that quietly came back after a month away could be advertising
          last month's prices to a customer who then orders at them. WHICH
          sentence is LAPSE_COPY's business -- a lapse and a suspension are
          different news and must not share a line. */}
      {status === 'draft' && unpublishedBy ? (
        <Caveat tone="wrong" action={{ label: 'Publish again', onPress: onPublish }}>
          {LAPSE_COPY[unpublishedBy]}
        </Caveat>
      ) : null}

      {blockers.map((blocker) => {
        const { label, goes } = BLOCKER_ACTION[blocker];
        return (
          <Caveat
            key={blocker}
            tone="wrong"
            action={{ label, onPress: goes === 'inventory' ? onGoToInventory : () => onFocusBlocker(blocker) }}
          >
            {BLOCKER_COPY[blocker]}
          </Caveat>
        );
      })}

      {confirmingUnpublish ? (
        <>
          {/* A QUESTION, not a status line. This used to read "Customers
              won't be able to reach your page until you publish it again",
              which describes a settled fact -- so a shop that had only ARMED
              the confirm read it as already unpublished, with a red
              "Unpublish now" underneath that then made no sense. Nothing has
              changed at this point: the page is still live until that button
              is pressed. */}
          <Caveat tone="context" onDismiss={() => setConfirmingUnpublish(false)}>
            Unpublish this page? Customers won&apos;t be able to reach it until you publish again — which you can do
            any time.
          </Caveat>
          <Pressable testID="publish-bar-unpublish-confirm" onPress={confirmUnpublish} style={styles.confirmButton}>
            <Text style={styles.confirmButtonText}>Unpublish now</Text>
          </Pressable>
        </>
      ) : null}
    </BentoCard>
  );
}

const styles = StyleSheet.create({
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },

  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderWidth: 1,
  },
  statusDraft: { backgroundColor: theme.bentoSoft, borderColor: theme.bentoLine },
  statusLive: { backgroundColor: theme.bentoUpWash, borderColor: 'transparent' },
  statusUnsaved: { backgroundColor: theme.bentoSoft, borderColor: theme.bentoWarn },
  statusText: { fontSize: 12, fontWeight: '700' },
  statusTextDraft: { color: theme.bentoMuted2 },
  statusTextLive: { color: theme.bentoUpInk },
  statusTextUnsaved: { color: theme.bentoWarn },

  // Set apart from the Preview/Edit/Publish row above it: those act on the
  // page, this one is about getting the page to somebody. The soft ground and
  // the rule are the same pair every other grouped bento panel uses.
  shareBlock: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSoft,
  },
  shareEyebrow: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted,
  },
  shareAddress: { marginTop: 6, fontSize: 14.5, fontWeight: '800', color: theme.bentoInk },
  shareRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 },
  // The accent pair, not a green "WhatsApp brand" one: this is an admin
  // screen and its palette is bento's, not another company's.
  shareButton: {
    backgroundColor: theme.bentoAccentWash,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  shareButtonText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoAccentInk },
  // The outlined button sits on `bentoSoft` here, not on the card, so it needs
  // its own ground to still read as a button rather than a hairline box.
  shareSecondary: { backgroundColor: theme.bentoSurface },

  secondaryButton: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  secondaryButtonText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk },

  publishButton: {
    marginLeft: 'auto',
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 9,
  },
  publishButtonText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoSurface },

  confirmButton: {
    marginTop: 10,
    alignSelf: 'flex-start',
    backgroundColor: theme.bentoDownWash,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  confirmButtonText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoDownInk },
});
