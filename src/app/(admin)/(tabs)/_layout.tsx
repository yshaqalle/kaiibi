import AdminTabs from '@/components/admin-tabs';

// The 4 admin tabs (dashboard/pos/inventory/sales) live in this nested
// `(tabs)` group so that `AdminTabs`'s routeNode only ever sees those 4
// routes. Non-tab routes (e.g. `product/new`, `product/[id]`) live as
// siblings of this group in `(admin)/_layout.tsx`'s wrapping Stack, so they
// push over the tab bar instead of being swallowed by it.
export default function AdminTabsLayout() {
  return <AdminTabs />;
}
