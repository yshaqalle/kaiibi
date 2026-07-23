import AppTabs from '@/components/app-tabs';

// The 3 public tabs (index/about/signup) live in this nested `(tabs)` group
// so that `AppTabs`'s routeNode only ever sees those 3 routes. Non-tab
// routes (e.g. `login`) live as siblings of this group in
// `(public)/_layout.tsx`'s wrapping Stack, so they push over the tab bar
// instead of being swallowed by it.
export default function PublicTabsLayout() {
  return <AppTabs />;
}
