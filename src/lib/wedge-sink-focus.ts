/**
 * Which focused field is the scan sink, and therefore is nobody typing.
 *
 * `WedgeSink` is an invisible, permanently-focused `TextInput` -- that is the
 * whole trick, since keys only reach a binary that cannot capture them if
 * something holds the caret. But every "is anyone editing right now?" question
 * in the app is asked of the platform, and the platform cannot see that this
 * particular field is one pixel wide and transparent. It answers yes, forever.
 *
 * That answer is what put the till's keyboard on screen over the tab bar with no
 * way to dismiss it: the dock follows focus, the sink never lets focus go, and
 * blurring it only makes it take the caret back 150ms later. So the sink says
 * which field is its own, and the dock discounts it.
 *
 * A module-level register rather than context: the sink and the dock are
 * siblings mounted from different trees -- the dock lives at the app root, the
 * sink inside whichever screen is scanning.
 */
let sink: unknown = null;

export function markSinkInput(input: unknown): void {
  sink = input;
}

/** Only the field that claimed it may release it, so an unmount cannot clear a newer sink. */
export function clearSinkInput(input: unknown): void {
  if (sink === input) sink = null;
}

export function isSinkInput(input: unknown): boolean {
  return input != null && sink === input;
}

/** Testing only: no device forgets, but each test must start from silence. */
export function resetSinkInput(): void {
  sink = null;
}
