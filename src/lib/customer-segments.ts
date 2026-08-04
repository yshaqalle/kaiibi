import type { Customer } from '@/types/models';

export type CustomerSegment = 'vip' | 'at-risk' | 'new' | 'regular';

const NEW_CUSTOMER_WINDOW_DAYS = 30;

// Pure client-side derivation -- no schema field for "status"/"segment"
// exists (Global Constraint #1). VIP/at-risk come from the existing
// free-text tags field; New/Regular fall out of account age. Shared by the
// Customers filter chips and each row's Badge (Task 11).
export function segmentForCustomer(customer: Pick<Customer, 'tags' | 'createdAt'>): CustomerSegment {
  const tags = customer.tags.map((t) => t.toLowerCase());
  if (tags.includes('vip')) return 'vip';
  if (tags.includes('at risk') || tags.includes('at-risk')) return 'at-risk';
  const ageMs = Date.now() - new Date(customer.createdAt).getTime();
  if (ageMs < NEW_CUSTOMER_WINDOW_DAYS * 24 * 60 * 60 * 1000) return 'new';
  return 'regular';
}

export const CUSTOMER_SEGMENT_LABELS: Record<CustomerSegment, string> = {
  vip: 'VIP',
  regular: 'Regular',
  new: 'New',
  'at-risk': 'At risk',
};

// Which store a customer actually shops at, from their purchase history.
//
// Counted by SALE, not by line item: someone buying six things in one visit
// shopped once, and counting lines would let a single large basket outvote
// several separate visits to another store.
//
// Returns null when there is no clear answer — no purchases, or a tie. A tie is
// deliberately not broken: with three visits to each of two stores, naming
// either as "where they shop" is a claim the data doesn't support, and the UI
// showing nothing is more honest than showing a coin flip.
export function usualStore(
  purchases: readonly { saleId: string; locationId: string }[]
): { locationId: string; visits: number; totalVisits: number } | null {
  const storeBySale = new Map<string, string>();
  for (const purchase of purchases) storeBySale.set(purchase.saleId, purchase.locationId);
  if (storeBySale.size === 0) return null;

  const counts = new Map<string, number>();
  for (const locationId of storeBySale.values()) {
    counts.set(locationId, (counts.get(locationId) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return { locationId: ranked[0][0], visits: ranked[0][1], totalVisits: storeBySale.size };
}
