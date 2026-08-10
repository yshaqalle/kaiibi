import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import type { SupportDraft } from '@/lib/support';
import { isSupportCategory } from '@/lib/support-taxonomy';

const KEY = 'kaiibi.support.draft';

// Retyping a bug report is how people stop reporting bugs, so the draft
// outlives the sheet AND the app. Attachments are deliberately not persisted:
// a picked file's URI points at a cache entry that does not survive a restart,
// so storing it would restore a list of broken references rather than files.
//
// Web reads localStorage directly for the same reason locale-storage.ts does --
// it is synchronous, so the sheet opens already filled rather than filling in
// a tick later.
function readSync(): string | null {
  if (Platform.OS !== 'web') return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export async function readStoredDraft(): Promise<SupportDraft | null> {
  let raw = readSync();
  if (raw === null && Platform.OS !== 'web') {
    try {
      raw = await AsyncStorage.getItem(KEY);
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
    if (parsed.category !== null && !isSupportCategory(parsed.category)) return null;
    return {
      category: parsed.category ?? null,
      area: typeof parsed.area === 'string' ? parsed.area : null,
      areaOther: typeof parsed.areaOther === 'string' ? parsed.areaOther : '',
      subject: typeof parsed.subject === 'string' ? parsed.subject : '',
      details: typeof parsed.details === 'string' ? parsed.details : '',
      contactPreference: ['in_app', 'whatsapp', 'email'].includes(parsed.contactPreference)
        ? parsed.contactPreference
        : 'in_app',
    };
  } catch {
    return null;
  }
}

// Fire-and-forget: a draft that fails to persist must never block typing.
export function writeStoredDraft(draft: SupportDraft): void {
  const raw = JSON.stringify(draft);
  if (Platform.OS === 'web') {
    try {
      window.localStorage.setItem(KEY, raw);
    } catch {
      // Private mode or storage disabled -- the draft just won't survive.
    }
    return;
  }
  void AsyncStorage.setItem(KEY, raw).catch(() => {});
}

export function clearStoredDraft(): void {
  if (Platform.OS === 'web') {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // Nothing to do.
    }
    return;
  }
  void AsyncStorage.removeItem(KEY).catch(() => {});
}
