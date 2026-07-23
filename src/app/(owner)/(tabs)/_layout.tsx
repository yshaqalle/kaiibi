import OwnerTabs from '@/components/owner-tabs';

// The 4 owner tabs (dashboard/pos/inventory/sales) live in this nested
// `(tabs)` group so that `OwnerTabs`'s routeNode only ever sees those 4
// routes. Non-tab routes (e.g. `product/new`, `product/[id]`) live as
// siblings of this group in `(owner)/_layout.tsx`'s wrapping Stack, so they
// push over the tab bar instead of being swallowed by it.
export default function OwnerTabsLayout() {
  return <OwnerTabs />;
}
