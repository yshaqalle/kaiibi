import { useRouter } from 'expo-router';
import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import type { ScrollView } from 'react-native';

// In-page section navigation for the landing page.
//
// The design's nav links are `#features`, `#plans` and so on, but a React
// Native Web ScrollView is not a document: there are no anchors, and the nav
// lives OUTSIDE the scroller (it is `AppTabs`, a sibling of `TabSlot`) so it
// cannot reach the sections by DOM either. This context is the wiring between
// the two.
//
// Mounted in `(public)/(tabs)/_layout.tsx`, the narrowest node that is an
// ancestor of both the nav and the landing page. That file is shared with
// native, so nothing here may touch a web-only API.

export type SectionId = 'dashboard' | 'features' | 'how' | 'plans' | 'faq' | 'download';

const SECTION_IDS: readonly SectionId[] = ['dashboard', 'features', 'how', 'plans', 'faq', 'download'];

export function isSectionId(value: string): value is SectionId {
  return (SECTION_IDS as readonly string[]).includes(value);
}

type SectionScrollState = {
  /** Each section reports its y offset from its own onLayout. */
  registerSection: (id: SectionId, y: number) => void;
  /** The landing page hands over its ScrollView so the nav can drive it. */
  attachScrollView: (ref: ScrollView | null) => void;
  /** Dropped on unmount so a stale offset can never drive a later scroll. */
  clearSections: () => void;
  /** Scroll there now, or navigate to `/` and scroll once it mounts. */
  scrollToSection: (id: SectionId) => void;
};

const SectionScrollContext = createContext<SectionScrollState | null>(null);

export function SectionScrollProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const offsets = useRef(new Map<SectionId, number>());
  const scrollView = useRef<ScrollView | null>(null);
  // Set when a section is asked for from another route; consumed by the
  // matching registerSection call once the landing page mounts.
  const pending = useRef<SectionId | null>(null);

  // No header offset is subtracted here, and that is deliberate. The header is
  // absolutely positioned OUTSIDE the scroller and `TabSlot` carries a matching
  // paddingTop, so the scroll view's own origin already sits below the chrome —
  // a section at content offset `y` lands directly under the nav at
  // scrollTop === y. Subtracting the header height as well double-counted it
  // and left every jump ~140px short, showing a slice of the previous section.
  const scrollTo = useCallback((y: number) => {
    scrollView.current?.scrollTo({ y: Math.max(0, y), animated: true });
  }, []);

  const registerSection = useCallback(
    (id: SectionId, y: number) => {
      offsets.current.set(id, y);
      // Driving the queued scroll off REGISTRATION rather than a mount effect
      // or a setTimeout is what makes a cross-page jump reliable: it fires at
      // the exact moment the offset becomes knowable, however slowly the page
      // got there.
      if (pending.current === id) {
        pending.current = null;
        scrollTo(y);
      }
    },
    [scrollTo]
  );

  const attachScrollView = useCallback((ref: ScrollView | null) => {
    scrollView.current = ref;
  }, []);

  const clearSections = useCallback(() => {
    offsets.current.clear();
    scrollView.current = null;
  }, []);

  const scrollToSection = useCallback(
    (id: SectionId) => {
      const y = offsets.current.get(id);
      if (y !== undefined && scrollView.current) {
        scrollTo(y);
        return;
      }
      // Not on the landing page (or it hasn't laid out yet): queue and go.
      // An unknown id deliberately does nothing rather than scrolling to 0 —
      // a section that isn't rendered, like `reviews`, must not silently jump
      // the visitor to the top.
      pending.current = id;
      router.push('/');
    },
    [router, scrollTo]
  );

  const value = useMemo<SectionScrollState>(
    () => ({ registerSection, attachScrollView, clearSections, scrollToSection }),
    [registerSection, attachScrollView, clearSections, scrollToSection]
  );

  return <SectionScrollContext.Provider value={value}>{children}</SectionScrollContext.Provider>;
}

export function useSectionScroll() {
  const context = useContext(SectionScrollContext);
  if (!context) throw new Error('useSectionScroll must be used within SectionScrollProvider');
  return context;
}
