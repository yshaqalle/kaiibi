import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import type { PublishBlocker } from '@/lib/storefront-admin';

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

// THE PROPERTY THIS FILE EXISTS FOR: Publish is never disabled. A greyed-out
// button with no explanation is precisely the failure this screen prevents --
// pressing it always calls onPublish, blockers or not. What a blocker means
// is said in the Caveat below, in words, not by taking the button away.
export function PublishBar({
  status,
  blockers,
  dirty,
  onEdit,
  onFocusBlocker,
  onGoToInventory,
  onTogglePreview,
  onPublish,
  onUnpublish,
}: {
  status: 'draft' | 'live';
  blockers: PublishBlocker[];
  dirty: boolean;
  /** The Edit button. Opens the editor; knows nothing about blockers. */
  onEdit: () => void;
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

  const statusLabel = status === 'draft' ? 'Draft' : dirty ? 'Unsaved changes' : 'Live';
  const statusStyle =
    status === 'draft' ? styles.statusDraft : dirty ? styles.statusUnsaved : styles.statusLive;
  const statusTextStyle =
    status === 'draft' ? styles.statusTextDraft : dirty ? styles.statusTextUnsaved : styles.statusTextLive;

  function confirmUnpublish() {
    setConfirmingUnpublish(false);
    onUnpublish();
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
        <Pressable testID="publish-bar-preview" onPress={onTogglePreview} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Preview</Text>
        </Pressable>
        <Pressable testID="publish-bar-edit" onPress={onEdit} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Edit</Text>
        </Pressable>
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
          <Caveat tone="context" onDismiss={() => setConfirmingUnpublish(false)}>
            Customers won&apos;t be able to reach your page until you publish it again. You can publish it again any
            time.
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
