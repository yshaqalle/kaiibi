import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { LOCALE_STORAGE_KEY, type Locale } from '@/lib/i18n';

// Where the chosen language is remembered. Split out of ./index.ts so that
// module stays testable without a platform runtime.
//
// Web reads `window.localStorage` DIRECTLY rather than going through
// AsyncStorage, and that is the whole point of this file. AsyncStorage.getItem
// returns a promise even on web, so a provider awaiting it paints English and
// flips to Somali a tick later -- a visible flash, on the marketing page, in
// front of the visitor whose language we just got wrong. localStorage is
// synchronous, so the very first render is already correct.
//
// Native has no such option and no such need: nothing under (admin) is
// translated yet, so a one-frame settle there costs nothing.

/** Web only. Returns null off-web, and null rather than throwing if storage is unavailable (private mode, disabled cookies). */
export function readStoredLocaleSync(): string | null {
  if (Platform.OS !== 'web') return null;
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Native only. Resolves null on web, where `readStoredLocaleSync` already answered. */
export async function readStoredLocaleAsync(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  try {
    return await AsyncStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

// Fire-and-forget, like setActiveLocation in hooks/use-auth.tsx: a preference
// that fails to persist should never block the UI from switching language.
export function writeStoredLocale(locale: Locale): void {
  if (Platform.OS === 'web') {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Storage unavailable -- the choice still applies for this session.
    }
    return;
  }
  AsyncStorage.setItem(LOCALE_STORAGE_KEY, locale).catch(() => {});
}
