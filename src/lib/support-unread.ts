import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect, useSyncExternalStore } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { listMyThreads, unreadCount, type SupportThread } from '@/lib/support';
import { supabase } from '@/lib/supabase';

// One count and one realtime subscription for every caller, held outside React.
//
// Two things force that rather than per-hook state. `useSupportUnread` has two
// callers mounted at once in every shell -- the ☰ row (support-menu-item.tsx)
// and the banner over the content (support-banner.tsx) -- so per-hook state
// would let the badge and the banner hold different numbers for as long as
// either refetch is in flight, the same drift Task 7 removed between the badge
// and the list's Unread pill. And supabase-js keys channels by topic: the
// second caller asking for 'support-unread' is handed the FIRST caller's
// channel object, so whichever unmounts first would remove the subscription out
// from under the one still on screen.
//
// The hook lives here with the store rather than in src/hooks/ because
// `subscribe`/`getSnapshot` exist only to be handed to useSyncExternalStore --
// splitting them would put one module's two halves either side of an import.
let unread = 0;
// Whose count `unread` is. Also the flag for "somebody is signed in": a count
// belongs to an account, not to the app.
let countingFor: string | null = null;
let channel: RealtimeChannel | null = null;
// Set when a channel reports anything other than SUBSCRIBED. Without it the
// `channel` reference below stays truthy after a subscribe that never
// succeeded, and every later mount is turned away by that check -- the badge
// then stops updating for the rest of the session, silently.
let channelFailed = false;
// Bumped for each channel opened, and part of its topic. removeChannel()
// unsubscribes before the client drops the channel from its own list, so a
// close followed by an open in the same tick -- which is what switching
// accounts on a shared tablet does -- would be handed the dying channel back
// under a fixed name.
let generation = 0;
// How many hooks are mounted. Closing on the first unmount would cut the banner
// off every time the ☰ menu closes, since the menu row and the banner share the
// one channel.
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
  channelFailed = false;
  void supabase.removeChannel(closing);
}

function openChannel() {
  // No filter, and one channel for the table rather than one per thread:
  // realtime evaluates the subscriber's own RLS, so this is only ever told
  // about a message on a thread the reader's select policy already lets them
  // read (migration 20260825000000). The database is the filter.
  //
  // Best-effort by design. A tablet living on the POS all day sees a reply
  // arrive; a phone in a pocket does not. Real delivery needs the
  // infrastructure docs/backlog/2026-08-01-notification-delivery.md records as
  // not existing, and anything genuinely urgent still goes out over WhatsApp by
  // hand.
  const opened = supabase
    .channel(`support-unread-${++generation}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'support_messages' }, () => {
      void refresh();
    });
  channel = opened;
  channelFailed = false;
  // Assigned before subscribing, because the status callback can fire in the
  // same tick and has to be able to tell this channel from a later one.
  opened.subscribe((status) => {
    if (status === 'SUBSCRIBED' || channel !== opened) return;
    // Marked rather than removed: realtime-js keeps its own rejoin timer on the
    // object and re-joins when the socket comes back, and removeChannel() here
    // would cancel the only recovery available to a shell that never remounts.
    // The next mount replaces it.
    channelFailed = true;
  });
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

// Tests only. Module state outlives every component by design, so without this
// one test's account, channel and refcount are the next test's starting point.
export function resetSupportUnread(): void {
  closeChannel();
  listeners.clear();
  unread = 0;
  countingFor = null;
  generation = 0;
  consumers = 0;
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
    if (userId && (!channel || channelFailed)) {
      closeChannel();
      openChannel();
    }
    return () => {
      consumers -= 1;
      if (consumers === 0) {
        closeChannel();
        // Cleared with the channel, not left for the next sign-in to overwrite:
        // on a shared tablet the next person's first render reads this snapshot
        // before any effect runs, and would be shown the previous account's
        // number for that frame. Through publish() rather than by assignment,
        // because the last consumer is not always unmounting -- when it is a
        // sign-out that took the count to zero, the same component re-runs this
        // effect and has to be told.
        publish(0);
        countingFor = null;
      }
    };
  }, [userId]);

  return { count, refresh };
}
