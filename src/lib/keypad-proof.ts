import { useSyncExternalStore } from 'react';

/**
 * Has the till's own keyboard actually appeared on THIS device?
 *
 * The universal dock replaces the old per-screen `SearchKeypad`, and two
 * keyboards must never render at once -- so something has to decide which one
 * is live. Asking the binary whether it CAN type is not the same question as
 * whether it does: a wrong yes does not cost an improvement, it costs the
 * typing a till already had, and staff cannot type at all.
 *
 * So nothing is assumed and no platform is named. The legacy keypad stays until
 * the dock has been seen serving a focused field, and then steps aside. On a
 * device where the dock works that is the first tap into any field; on one where
 * it never does, the old keyboard simply keeps working, which is exactly the
 * behaviour that device has today.
 *
 * An external store rather than context: the screens that need the answer are
 * siblings of the dock, not its children.
 */
let proven = false;
const listeners = new Set<() => void>();

export function markKeypadProven(): void {
  if (proven) return;
  proven = true;
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}

export function isKeypadProven(): boolean {
  return proven;
}

/** Testing only: no device forgets, but each test must start from silence. */
export function resetKeypadProof(): void {
  proven = false;
  listeners.clear();
}

export function useKeypadProven(): boolean {
  return useSyncExternalStore(subscribe, isKeypadProven, isKeypadProven);
}
