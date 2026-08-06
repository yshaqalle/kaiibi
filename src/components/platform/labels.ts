import { LIMIT_RESOURCES, type LimitResource } from '@/lib/entitlements';

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
