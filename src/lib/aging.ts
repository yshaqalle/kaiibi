/**
 * How old a debt is, in the four buckets every set of books uses.
 *
 * One function for both directions, which is the whole reason it is here rather
 * than in either screen: money owed TO the shop and money owed BY the shop are
 * the same question asked twice, and two implementations of "is this over
 * sixty days" is how the two screens end up disagreeing about the same
 * fortnight.
 *
 * WHAT IS BEING AGED. The age is measured from the day the debt AROSE -- the
 * sale for a receivable, the issue date for a bill -- not from a due date.
 * That is the classical meaning of an aging schedule, and here it is also the
 * only one available: a kaiibi sale has no due date at all, so ageing
 * receivables "past due" would need a term nobody has entered. Bills do carry a
 * due date, and being overdue is a real and different fact -- the Bills tab
 * already flags it, and it stays a separate signal rather than being folded in
 * here. A bill can sit in the 60-89 bucket and not be overdue; that is not a
 * contradiction, it is the two facts saying different things.
 */

export type AgingBucket = 'current' | 'd30' | 'd60' | 'd90';

/**
 * The four buckets, in the order they are shown. `hint` is what the tile says
 * under the figure -- the boundaries are conventional but not obvious, and a
 * reader who assumes "Current" means "not overdue" would misread the strip.
 */
export const AGING_BUCKETS: { key: AgingBucket; label: string; hint: string }[] = [
  { key: 'current', label: 'Current', hint: 'under 30 days old' },
  { key: 'd30', label: '30 – 59 days', hint: 'a month behind' },
  { key: 'd60', label: '60 – 89 days', hint: 'two months behind' },
  // No upper bound on purpose: the oldest bucket has to be open-ended or the
  // total stops reconciling the day something turns 120.
  { key: 'd90', label: '90+ days', hint: 'three months or more' },
];

/** Which bucket an age in whole days falls in. */
export function bucketForDays(days: number): AgingBucket {
  // Negative ages are clamped rather than rejected: a clock skew or a
  // back-dated bill should land in the newest bucket, not crash a report.
  if (days < 30) return 'current';
  if (days < 60) return 'd30';
  if (days < 90) return 'd60';
  return 'd90';
}

export type AgingTotal = { key: AgingBucket; label: string; hint: string; cents: number; count: number };

/**
 * The strip: one total and one count per bucket, always all four.
 *
 * Empty buckets are KEPT rather than dropped. A strip that renders three tiles
 * this week and four next week is a strip whose shape carries no meaning, and
 * "90+ is zero" is one of the more useful things this screen can say -- it is
 * the reassurance, not the absence of news.
 */
export function agingTotals<T>(
  items: T[],
  read: { days: (item: T) => number; cents: (item: T) => number }
): AgingTotal[] {
  const empty = new Map<AgingBucket, { cents: number; count: number }>(
    AGING_BUCKETS.map((b) => [b.key, { cents: 0, count: 0 }])
  );
  for (const item of items) {
    const slot = empty.get(bucketForDays(read.days(item)));
    if (!slot) continue;
    slot.cents += read.cents(item);
    slot.count += 1;
  }
  return AGING_BUCKETS.map((b) => ({ ...b, ...empty.get(b.key)! }));
}

/**
 * The rows in one bucket, for the table under the strip.
 *
 * Null means "no bucket chosen", which returns everything -- the tab's ordinary
 * state. The strip is a filter over the list, not a different list, which is
 * the point of putting it on the tab instead of building a second screen.
 */
export function inBucket<T>(items: T[], bucket: AgingBucket | null, days: (item: T) => number): T[] {
  if (bucket === null) return items;
  return items.filter((item) => bucketForDays(days(item)) === bucket);
}

/**
 * Whole days between an ISO timestamp and now, floored and clamped at zero.
 *
 * The same arithmetic `daysOwed` does for receivables, lifted here so payables
 * do not grow a second copy of it that rounds differently.
 */
export function daysSince(at: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(at).getTime()) / 86_400_000));
}
