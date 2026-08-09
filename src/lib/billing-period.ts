// How many months one billing period covers. Its own module rather than a
// local in shop-drawer.tsx because the period defaults are read at three call
// sites there and the rule is worth testing on its own.
export function periodMonths(interval: 'month' | 'year' | null): number {
  return interval === 'year' ? 12 : 1;
}
