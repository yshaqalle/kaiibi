import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

// Remembers which caveats a reader has closed.
//
// The Caveat component has always drawn a ✕ when given `onDismiss`; nothing
// ever gave it one, because "dismissed" is a decision only the caller can make
// safely. This is that decision, made once, in the way caveat.tsx asks for it.
//
// A dismissal is stored as `id -> signature`, NOT as a boolean. The signature
// describes the CAUSE the reader was looking at when they closed it, so:
//
//   'wrong'   signature is the state that makes the figure wrong (the uncosted
//             item count and the revenue behind it). When more items go
//             uncosted the signature changes, the caveat is a new fact, and it
//             comes back. Without this the app would quietly go on showing a
//             number it knows is bad.
//   'context' the sentence never changes, so a constant signature is right —
//             "I've read it" means read forever.
//
// Device-scoped rather than per-user: two people sharing a till are looking at
// the same screen, and a dismissal is about this display, not this login.

const STORAGE_KEY = 'kaiibi.dismissed-caveats';

type Dismissals = Record<string, string>;

function parse(raw: string | null): Dismissals {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Dismissals;
  } catch {
    return {};
  }
}

// Web reads synchronously so the first paint is already correct, for the same
// reason lib/i18n/locale-storage.ts does: a banner that paints and then
// vanishes is worse than one that was never there. Native hydrates a tick
// later, which lands long before any caveat has data to render.
function readSync(): Dismissals {
  if (Platform.OS !== 'web') return {};
  try {
    return parse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

let cache: Dismissals = readSync();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

if (Platform.OS !== 'web') {
  AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      cache = { ...parse(raw), ...cache };
      emit();
    })
    .catch(() => {});
}

// Fire-and-forget: a dismissal that fails to persist still applies for this
// session, and blocking the UI on storage would be worse than forgetting.
function persist(): void {
  const serialised = JSON.stringify(cache);
  if (Platform.OS === 'web') {
    try {
      window.localStorage.setItem(STORAGE_KEY, serialised);
    } catch {
      // Private mode or storage disabled — the close still worked.
    }
    return;
  }
  AsyncStorage.setItem(STORAGE_KEY, serialised).catch(() => {});
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * @param id        Stable key for this caveat. Namespace it by screen, e.g.
 *                  `dashboard.uncosted-cogs`.
 * @param signature What the reader was told. Change it and the caveat returns.
 *                  Use a constant for an explanation, the causing state for a
 *                  `wrong` one.
 */
export function useCaveatDismissal(id: string, signature: string): { dismissed: boolean; dismiss: () => void } {
  const dismissed = useSyncExternalStore(
    subscribe,
    () => cache[id] === signature,
    // Server render: show it. A caveat missing from the HTML and appearing on
    // hydration is a layout jump; the other way round is not.
    () => false,
  );

  const dismiss = useCallback(() => {
    cache = { ...cache, [id]: signature };
    persist();
    emit();
  }, [id, signature]);

  return { dismissed, dismiss };
}
