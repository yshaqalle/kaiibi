import { useCallback, useRef } from 'react';

// REFUSES TO RUN A SECOND TIME UNTIL THE FIRST ONE HAS SETTLED.
//
// Every form in this app guards its submit with a piece of state -- `submitting`,
// `saving`, `busy` -- which the button reads to grey itself out. That guard is
// enough for a button, because a greyed-out button cannot be pressed again. It
// is NOT enough for the return key, which is what this hook exists for.
//
// Two reasons Enter defeats a state guard:
//
//   HELD KEYS REPEAT. Holding Enter on a form fires the handler again every few
//   dozen milliseconds. React has not necessarily re-rendered between two of
//   those, so the second call reads the same stale `false` the first one did.
//
//   IMPATIENCE. A slow connection shows nothing between pressing Enter and the
//   screen changing, so people press it again. The button they cannot press is
//   not the input they are using.
//
// A ref changes synchronously, at the moment of the call, with no render in
// between -- which is the only thing that can refuse a second call that arrives
// before the first has settled. The state guard stays where it is: it is what
// the button and the spinner read, and this hook does not replace it.
//
// Wrap the async work only. A step change or a field focus needs none of this:
// it is synchronous, it is visible immediately, and a second press is a genuine
// second intent against a screen that has already changed.
export function useSingleFlight<A extends unknown[]>(
  run: (...args: A) => Promise<void> | void,
): (...args: A) => Promise<void> {
  const inFlight = useRef(false);
  // `run` is a fresh closure on every render, so this callback is too -- which
  // is correct and costs nothing: the latch lives in the ref, which is not.
  return useCallback(
    async (...args: A) => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        await run(...args);
      } finally {
        inFlight.current = false;
      }
    },
    [run],
  );
}
