import { segmentForCustomer } from '@/lib/customer-segments';
import { whatsappLink } from '@/lib/whatsapp';
import type { AudienceFilter, Customer } from '@/types/models';

// Re-exported from here (rather than defined here) because this file already
// imports `Customer` from models.ts — defining AudienceFilter here and
// importing it back from models.ts would make the dependency two-way. See
// the comment on AudienceFilter in models.ts.
export type { AudienceFilter };

// Whether a chat can be opened at all, asked of the one function that already
// decides this for the WhatsApp button (src/lib/whatsapp.ts). A second opinion
// about what a phone number is would eventually disagree with the button, and
// the count on screen would stop matching what the buttons can do.
export function isReachable(customer: Customer): boolean {
  return whatsappLink(customer.phone) !== null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Deliberately independent of isReachable: someone with no usable number is
// still IN the audience. They show as unreachable and they join the send queue
// the moment their number is fixed.
export function matchesAudience(
  customer: Customer,
  filter: AudienceFilter,
  lastPurchaseAt: string | null,
  now: number = Date.now()
): boolean {
  if (filter.segments.length > 0 && !filter.segments.includes(segmentForCustomer(customer))) {
    return false;
  }

  // Every chosen tag, not any: picking "wholesale" and "credit" means the
  // customers who are both, which is what a person selecting two labels means.
  if (filter.tags.length > 0) {
    const owned = customer.tags.map((t) => t.toLowerCase());
    if (!filter.tags.every((t) => owned.includes(t.toLowerCase()))) return false;
  }

  if (filter.inactiveDays !== null) {
    // Never having bought is the strongest form of "has not bought lately",
    // so a null last purchase passes rather than being excluded for lack of
    // data -- these are exactly the people a win-back campaign is for.
    //
    // An unparseable date is treated the same way, deliberately. `Date.parse`
    // returns NaN for junk and every comparison against NaN is false, so
    // without this the customer would fall through to "matched" anyway -- but
    // by accident rather than by decision. Saying it out loud means the next
    // reader knows it was considered, and that the safe direction is to
    // include someone we cannot date rather than silently drop them from a
    // win-back campaign.
    const lastPurchase = lastPurchaseAt === null ? NaN : Date.parse(lastPurchaseAt);
    // Strictly less-than: a purchase exactly N days ago counts as "has not
    // bought in N days". N full days have elapsed, which is what an owner
    // choosing 60 means.
    if (!Number.isNaN(lastPurchase) && now - lastPurchase < filter.inactiveDays * DAY_MS) {
      return false;
    }
  }

  return true;
}

export function audienceSummary(
  customers: readonly Customer[],
  filter: AudienceFilter,
  lastPurchaseByCustomer: ReadonlyMap<string, string>,
  now: number = Date.now()
): { matched: number; reachable: number; unreachable: number } {
  let matched = 0;
  let reachable = 0;
  for (const customer of customers) {
    if (!matchesAudience(customer, filter, lastPurchaseByCustomer.get(customer.id) ?? null, now)) continue;
    matched++;
    if (isReachable(customer)) reachable++;
  }
  return { matched, reachable, unreachable: matched - reachable };
}
