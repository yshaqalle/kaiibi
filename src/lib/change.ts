/**
 * Period-on-period change, as a percentage.
 *
 * Divided by the ABSOLUTE value of the baseline, which is the whole reason
 * this is a function rather than three characters inline. With a plain
 * `(current - previous) / previous`, a loss that deepens from -$100 to -$200
 * comes out at +100% — the arithmetic is right and the meaning is inverted,
 * so the badge points up on the worst week of the year.
 *
 * Null when there is nothing to measure against: no prior window fetched, or
 * a baseline of zero, where the percentage is either undefined or infinite.
 * Callers render nothing rather than a comparison nobody can act on.
 */
export function percentChange(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined) return null;
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/**
 * Whether a change is good news — which is not the same as whether it went up.
 *
 * Expenses climbing is an unfavourable move while the arrow still points up:
 * direction and desirability are separate facts, and a badge that colours by
 * direction alone tells a shop its costs rising is a win.
 */
export function isFavourable(current: number, previous: number, lowerIsBetter = false): boolean {
  const rose = current - previous >= 0;
  return lowerIsBetter ? !rose : rose;
}
