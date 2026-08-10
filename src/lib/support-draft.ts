import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import type { SupportDraft } from '@/lib/support';
import { isSupportCategory } from '@/lib/support-taxonomy';

// One key per user, never one per device. These run on shop tablets that a
// whole shift signs in and out of, and an unsent complaint about a manager is
// exactly the thing thread-scoped RLS exists to keep from that manager -- a
// shared key would hand it over in the browser instead of the database. Shop
// is not enough of a scope either: the cashier and the manager share one.
function keyFor(userId: string): string {
  return `kaiibi.support.draft.${userId}`;
}

/**
 * `thread` is the thread a part-finished send already opened. It rides with the
 * draft because opening one is not idempotent: without it, a send that filed
 * the report and then failed on an attachment would file a second copy the next
 * time the sheet is opened, leaving the first unanswerable.
 */
export type StoredDraft = {
  draft: SupportDraft;
  thread: { id: string; reference: string } | null;
};

// Retyping a bug report is how people stop reporting bugs, so the draft
// outlives the sheet AND the app. Attachments are deliberately not persisted:
// a picked file's URI points at a cache entry that does not survive a restart,
// so storing it would restore a list of broken references rather than files.
//
// Web reads localStorage directly for the same reason locale-storage.ts does --
// it is synchronous, so the sheet opens already filled rather than filling in
// a tick later.
function readSync(key: string): string | null {
  if (Platform.OS !== 'web') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readThread(parsed: unknown): StoredDraft['thread'] {
  if (!parsed || typeof parsed !== 'object') return null;
  const { id, reference } = parsed as { id?: unknown; reference?: unknown };
  if (typeof id !== 'string' || typeof reference !== 'string') return null;
  return { id, reference };
}

export async function readStoredDraft(userId: string): Promise<StoredDraft | null> {
  const key = keyFor(userId);
  let raw = readSync(key);
  if (raw === null && Platform.OS !== 'web') {
    try {
      raw = await AsyncStorage.getItem(key);
    } catch {
      return null;
    }
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // Validated rather than trusted: this string was last written by a
    // possibly-older build, and a stale category would throw in categoryMeta().
    // A `parsed` that is not an object at all throws on the property read and
    // lands in the catch below, which is the same answer.
    const draft = parsed.draft;
    if (draft.category !== null && !isSupportCategory(draft.category)) return null;
    return {
      draft: {
        category: draft.category ?? null,
        area: typeof draft.area === 'string' ? draft.area : null,
        areaOther: typeof draft.areaOther === 'string' ? draft.areaOther : '',
        subject: typeof draft.subject === 'string' ? draft.subject : '',
        details: typeof draft.details === 'string' ? draft.details : '',
        contactPreference: ['in_app', 'whatsapp', 'email'].includes(draft.contactPreference)
          ? draft.contactPreference
          : 'in_app',
      },
      thread: readThread(parsed.thread),
    };
  } catch {
    return null;
  }
}

// Fire-and-forget: a draft that fails to persist must never block typing.
export function writeStoredDraft(userId: string, draft: SupportDraft, thread: StoredDraft['thread']): void {
  const key = keyFor(userId);
  const raw = JSON.stringify({ draft, thread });
  if (Platform.OS === 'web') {
    try {
      window.localStorage.setItem(key, raw);
    } catch {
      // Private mode or storage disabled -- the draft just won't survive.
    }
    return;
  }
  void AsyncStorage.setItem(key, raw).catch(() => {});
}

export function clearStoredDraft(userId: string): void {
  const key = keyFor(userId);
  if (Platform.OS === 'web') {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Nothing to do.
    }
    return;
  }
  void AsyncStorage.removeItem(key).catch(() => {});
}
