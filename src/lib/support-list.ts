// What a row in "Your messages" says, kept out of the component that draws it.
//
// The list used to show a subject and a reference, which answers none of the
// questions someone actually has in front of it -- has anyone replied, is it
// still open, which of my three threads is this. Every function here answers one
// of those from data the list already holds.

import { isUnread, type SupportThread } from '@/lib/support';
import { FILTER_CATEGORIES, SUPPORT_CATEGORIES, isSupportCategory } from '@/lib/support-taxonomy';

// Ordered the way they are rendered, and by whose move it is -- the same
// question the operator's queue is organised around, so both ends of a
// conversation are sorted by the same idea.
export type ThreadGroup = 'waiting' | 'open' | 'closed';

export const GROUP_ORDER: readonly ThreadGroup[] = ['waiting', 'open', 'closed'];

export const GROUP_LABEL: Record<ThreadGroup, string> = {
  waiting: 'Waiting on you',
  open: 'Open',
  closed: 'Closed',
};

// Unread beats closed on purpose: an operator who answers and closes in the same
// breath leaves a thread that is both, and filing it under "Closed" hides the
// answer the person is waiting for behind the one heading nobody opens.
export function threadGroup(thread: SupportThread): ThreadGroup {
  if (isUnread(thread)) return 'waiting';
  return thread.status === 'closed' ? 'closed' : 'open';
}

// Empty groups are dropped rather than rendered as a heading with nothing under
// it. Order within a group is the order handed in, which is last_message_at
// descending (listMyThreads).
export function groupThreads(
  threads: SupportThread[]
): { group: ThreadGroup; label: string; threads: SupportThread[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABEL[group],
    threads: threads.filter((thread) => threadGroup(thread) === group),
  })).filter((section) => section.threads.length > 0);
}

// 'accent' is the one loud thing a row may carry, and only ever for something
// waiting on the reader. Everything else is quiet by design: a list where three
// chips compete says no more than a list with none.
export type StatusChip = { label: string; tone: 'accent' | 'plain' };

export function statusChip(thread: SupportThread): StatusChip {
  if (isUnread(thread)) {
    // "Reply" would be a lie on a thread we opened -- the first message on those
    // is not answering anything.
    return { label: thread.openedBy === 'shop' ? 'New reply' : 'New message', tone: 'accent' };
  }
  if (thread.status === 'closed') return { label: 'Resolved', tone: 'plain' };
  // Null on a thread whose database has not had 20260825000800 applied, or
  // whose only message predates its backfill. "Open" is the honest answer when
  // we do not know who spoke last -- better than guessing at whose move it is.
  if (thread.lastAuthorKind === 'shop') return { label: 'Waiting for us', tone: 'plain' };
  if (thread.lastAuthorKind === 'platform') return { label: 'Answered', tone: 'plain' };
  return { label: 'Open', tone: 'plain' };
}

// Who wrote the last message, in the same words the thread itself uses for the
// two ends (support-thread-view.tsx: 'Kaiibi support' / 'You'). Shortened here
// because it prefixes a line that also has to hold the message.
export function previewLine(thread: SupportThread): { who: string; body: string } | null {
  if (!thread.lastMessagePreview || !thread.lastAuthorKind) return null;
  return {
    who: thread.lastAuthorKind === 'platform' ? 'Kaiibi' : 'You',
    body: thread.lastMessagePreview,
  };
}

// "Broken · POS & checkout" -- what it is, then where. The area is the store's
// own free text when they picked "Something else", which is the whole reason
// that box exists: it is the only description of the thread nobody had to
// choose from a list.
export function categoryLine(thread: SupportThread): string {
  const category = FILTER_CATEGORIES.find((entry) => entry.key === thread.category);
  // An unknown category is a stored value no list here knows about -- possible
  // the day one is added to the database ahead of this file. The area alone is
  // still worth showing.
  const parts = [category?.label, areaLabel(thread)].filter((part): part is string => Boolean(part));
  return parts.join(' · ');
}

function areaLabel(thread: SupportThread): string | null {
  if (thread.areaOther?.trim()) return thread.areaOther.trim();
  if (!thread.area || !isSupportCategory(thread.category)) return null;
  const meta = SUPPORT_CATEGORIES.find((entry) => entry.key === thread.category);
  return meta?.areas.find((area) => area.key === thread.area)?.label ?? null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago, in the width of a row's right-hand corner: `now`, `20m`, `2h`,
 * `Sat`, `12 Jul`, `Jul 2025`.
 *
 * Fixed English names rather than Intl: these are shared tablets whose locale is
 * whatever the last person set, and a row that says "Sáb" on one device and
 * "Sat" on the next -- in a sheet that is English throughout -- is a worse
 * answer than one spelling everywhere. A wrong device clock only shifts this
 * label; nothing here decides read state (see markThreadRead).
 */
export function shortWhen(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = now.getTime() - then;
  // A message stamped in the future is a clock that disagrees, not a message
  // from tomorrow. "in 3h" would be the only unexplainable string on the screen.
  if (diff < MINUTE) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  const date = new Date(then);
  if (diff < 7 * DAY) return WEEKDAYS[date.getDay()];
  if (date.getFullYear() === now.getFullYear()) return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}
