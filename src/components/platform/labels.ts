import { LIMIT_RESOURCES, type LimitResource } from '@/lib/entitlements';
import type { PlatformShopRow } from '@/lib/platform';

// One word, two meanings — resolved here rather than left to collide.
//
// In the shop-side app a STORE is a branch, and `LIMIT_RESOURCES` labels
// `locations` "Stores" to match. In this console a store is the CUSTOMER: the
// whole business, the row in `shops`. Both words appear in the same card —
// "Usage across all stores" counting customers, with a "Stores" tile inside it
// counting branches — and the reader has no way to tell which is which.
//
// So the console renames the branch, not the customer. "Branch" is already the
// product's own word for it: the multi-store module's description reads "Open
// more than one branch and move stock between them." Nothing shop-facing moves.
const CONSOLE_LABELS: Partial<Record<LimitResource, string>> = {
  locations: 'Branches',
};

/** The label for a limit, as this console says it. */
export function limitLabel(key: LimitResource): string {
  return CONSOLE_LABELS[key] ?? LIMIT_RESOURCES.find((r) => r.key === key)?.label ?? key;
}

// "2 Aug 2026" rather than 2026-08-04: an operator scanning a column reads a
// month name faster than a numeric one, and it removes the day/month ambiguity
// entirely.
export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// What their cover runs to, and what kind of date that is. A trialing shop's
// clock is trial_ends_at; a paying one's is the period they bought. Saying
// which avoids reading "2 Nov" as a renewal when it is actually the day they
// lose access.
//
// Here rather than in shops-tab.tsx because the support rail asks the same
// question the shops table does — is this store paid up — and two answers to
// it is how a rail starts contradicting the table an operator just left.
export function coverEnd(shop: PlatformShopRow): { ends: string | null; label: string } {
  if (shop.status === 'trialing') return { ends: shop.trialEndsAt, label: 'trial ends' };
  return { ends: shop.currentPeriodEnd ?? shop.trialEndsAt, label: 'renews' };
}
