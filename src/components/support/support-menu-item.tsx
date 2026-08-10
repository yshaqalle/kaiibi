import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { supabase } from '@/lib/supabase';
import { listMyThreads, unreadCount, type SupportThread } from '@/lib/support';

// One component for a row that exists in three shells -- admin-sidebar.tsx
// (wide), admin-tabs.web.tsx (mobile web) and admin-tabs.tsx (native phone).
// Pasting it three times is how the three menus drift.
//
// Deliberately NOT gated. The Settings row beside it is wrapped in
// canEditShop; this one must never be, because a cashier who cannot ring up a
// sale is the person most likely to need it -- and today their whole menu is
// one item: Sign out.
//
// `tone` mirrors LocationSwitcher's own prop (see location-switcher.tsx):
// this component is dropped into a menu sheet it does not own, and that
// sheet's palette is the host's call, not this component's. admin-tabs.tsx
// paints its sheet with Colors.dark and overrides every other row's text to
// `colors.text` for that reason; without the same override here this row
// rendered `bentoInk` (near-black) on that dark sheet -- text at ~1:1
// contrast on the shell where this row is often a cashier's entire menu.
// Defaulting to 'light' keeps the two light shells (admin-sidebar.tsx,
// admin-tabs.web.tsx) unchanged.
export function SupportMenuItem({ onPress, tone = 'light' }: { onPress: () => void; tone?: 'light' | 'dark' }) {
  const { count } = useSupportUnread();
  const theme = tone === 'dark' ? Colors.dark : Colors.light;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.item, { opacity: pressed ? 0.6 : 1 }]}
      accessibilityLabel={count > 0 ? `Help and support, ${count} unread message${count === 1 ? '' : 's'}` : 'Help and support'}
    >
      <Text style={[styles.icon, { color: theme.bentoInk }]}>✉</Text>
      <Text style={[styles.label, { color: theme.bentoInk }]}>Help &amp; support</Text>
      {count > 0 && (
        <View style={[styles.badge, { backgroundColor: theme.bentoAccentWash }]}>
          <Text style={[styles.badgeText, { color: theme.bentoAccentInk }]}>{count > 9 ? '9+' : String(count)}</Text>
        </View>
      )}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// One count and one subscription for every caller, held outside React.
//
// Two things force that rather than per-hook state. `useSupportUnread` now has
// two callers mounted at once in every shell -- this row and SupportBanner over
// the content -- so per-hook state would let the badge and the banner hold
// different numbers for as long as either refetch is in flight, the same drift
// Task 7 removed between the badge and the list's Unread pill. And supabase-js
// keys channels by topic: the second caller asking for 'support-unread' is
// handed the FIRST caller's channel object, so whichever unmounts first would
// remove the subscription out from under the one still on screen.
let unread = 0;
// Whose count `unread` is. Also the flag for "somebody is signed in": a count
// belongs to an account, not to the app.
let countingFor: string | null = null;
let channel: RealtimeChannel | null = null;
// Bumped for each channel opened, and part of its topic. removeChannel()
// unsubscribes before the client drops the channel from its own list, so a
// close followed by an open in the same tick -- which is what switching
// accounts on a shared tablet does -- would be handed the dying channel back
// under a fixed name.
let generation = 0;
let consumers = 0;
const listeners = new Set<() => void>();

function publish(next: number) {
  if (next === unread) return;
  unread = next;
  listeners.forEach((notify) => notify());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return unread;
}

function closeChannel() {
  if (!channel) return;
  const closing = channel;
  channel = null;
  void supabase.removeChannel(closing);
}

async function refresh(): Promise<void> {
  const forUser = countingFor;
  if (!forUser) {
    publish(0);
    return;
  }
  let next = 0;
  try {
    next = unreadCount(await listMyThreads());
  } catch {
    // A failed count must never break the menu it lives in. No badge is a
    // better outcome than no menu.
    next = 0;
  }
  // A count that lands after the account it was counted for changed is the
  // previous account's number, and signing out on a shared tablet is the
  // ordinary way to produce one.
  if (countingFor !== forUser) return;
  publish(next);
}

// Fed by SupportSheet, which has just fetched the very list this count is
// derived from. It costs no extra request, and it is the only thing that drops
// the badge and the banner when a thread is marked read -- reading inserts
// nothing, so realtime has nothing to report.
export function syncSupportUnread(threads: SupportThread[]): void {
  if (!countingFor) return;
  publish(unreadCount(threads));
}

export function useSupportUnread() {
  const { session } = useAuth();
  // The user id, not `session` itself -- Supabase hands out a new session
  // object on every silent token refresh (roughly hourly), not only on real
  // sign-in/sign-out, and that identity change would refire this effect and
  // refetch the count each time for no reason.
  const userId = session?.user.id ?? null;
  const count = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    consumers += 1;
    if (userId !== countingFor) {
      countingFor = userId;
      // The open channel authorises with the previous account's token and
      // carries the previous account's rows.
      closeChannel();
      publish(0);
    }
    void refresh();
    if (userId && !channel) {
      // No filter, and one channel for the table rather than one per thread:
      // realtime evaluates the subscriber's own RLS, so this is only ever told
      // about a message on a thread the reader's select policy already lets
      // them read (migration 20260825000000). The database is the filter.
      //
      // Best-effort by design. A tablet living on the POS all day sees a reply
      // arrive; a phone in a pocket does not. Real delivery needs the
      // infrastructure docs/backlog/2026-08-01-notification-delivery.md records
      // as not existing, and anything genuinely urgent still goes out over
      // WhatsApp by hand.
      channel = supabase
        .channel(`support-unread-${++generation}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'support_messages' }, () => {
          void refresh();
        })
        .subscribe();
    }
    return () => {
      consumers -= 1;
      if (consumers === 0) closeChannel();
    };
  }, [userId]);

  return { count, refresh };
}

// Colors live inline against `theme` at render time (see the component
// above), not here -- `tone` picks between Colors.light and Colors.dark, and
// a static StyleSheet can't hold two palettes at once.
const styles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 14 },
  icon: { fontSize: 15 },
  label: { fontSize: 14, fontWeight: '700', flex: 1 },
  badge: {
    minWidth: 20,
    paddingHorizontal: 6,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 11, fontWeight: '800' },
});
