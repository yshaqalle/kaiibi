import AppTabs from '@/components/app-tabs';
import { SectionScrollProvider } from '@/hooks/use-section-scroll';

// The 3 public tabs (index/about/signup) live in this nested `(tabs)` group
// so that `AppTabs`'s routeNode only ever sees those 3 routes. Non-tab
// routes (e.g. `login`) live as siblings of this group in
// `(public)/_layout.tsx`'s wrapping Stack, so they push over the tab bar
// instead of being swallowed by it.
//
// SectionScrollProvider wraps AppTabs rather than living inside either the nav
// or the landing page: it is the narrowest node that is an ancestor of BOTH,
// and the nav (outside the scroller) needs to drive the page (inside it). It
// carries no web-only code, so this shared file stays safe on native.
export default function PublicTabsLayout() {
  return (
    <SectionScrollProvider>
      <AppTabs />
    </SectionScrollProvider>
  );
}
