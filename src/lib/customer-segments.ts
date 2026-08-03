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
