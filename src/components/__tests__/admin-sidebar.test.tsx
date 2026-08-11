import { useEffect } from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Below the mocks in intent, above them in source: babel-plugin-jest-hoist
// lifts every `jest.mock` above the imports regardless.
import { AdminSidebar } from '@/components/admin-sidebar';

// `signOut` in the ☰ menu reaches lib/auth, which constructs a real Supabase
// client at import time and throws without the app's env vars.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  usePathname: () => '/inventory',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    shop: { name: 'Jaalala Skincare', logoUrl: null, categories: ['Skincare'] },
    can: () => true,
    canAny: () => true,
    myMembership: { active: true },
    hasModule: () => true,
  }),
}));
jest.mock('@/hooks/use-shop-logo', () => ({ useShopLogo: () => ({ editLogo: jest.fn(), canEditLogo: true }) }));
jest.mock('@/components/location-switcher', () => ({ LocationSwitcher: () => null }));
jest.mock('@/components/support/support-banner', () => ({ SupportBanner: () => null }));
jest.mock('@/components/support/support-menu-item', () => ({ SupportMenuItem: () => null }));
jest.mock('@/components/support/support-sheet', () => ({ SupportSheet: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

// Stands in for the routed screen. Counting mounts is the whole assertion: a
// screen that is REBUILT rather than updated runs its effects again, and every
// `useState` in it starts over -- which is how a scanned barcode disappeared
// out of a search box that had just found it.
let mounts = 0;
function Screen() {
  useEffect(() => { mounts += 1; }, []);
  return <Text>inventory screen</Text>;
}

function shell(compact: boolean) {
  return (
    <AdminSidebar compact={compact} bottomNav={<Text>bottom nav</Text>}>
      <Screen />
    </AdminSidebar>
  );
}

function labels(tree: ReactTestRenderer) {
  return tree.root.findAllByType(Text).flatMap((t) => (typeof t.props.children === 'string' ? [t.props.children] : []));
}

beforeEach(() => { mounts = 0; });

describe('AdminSidebar', () => {
  // The bug this shape exists to prevent. Both widths used to be separate
  // returns with a `<Slot />` each, so React tore the screen down on the way
  // past 820px and built a new one with empty state.
  it('keeps the screen mounted when the width crosses the breakpoint', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(shell(true)); });
    expect(mounts).toBe(1);

    act(() => { tree!.update(shell(false)); });
    expect(mounts).toBe(1);

    // And back again — a dragged window crosses the line in both directions.
    act(() => { tree!.update(shell(true)); });
    expect(mounts).toBe(1);
  });

  it('shows the rail only at the wide width', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(shell(false)); });
    expect(labels(tree!)).toContain('Powered by Ka Iibi');

    act(() => { tree!.update(shell(true)); });
    expect(labels(tree!)).not.toContain('Powered by Ka Iibi');
  });

  it('shows the bottom nav only at the narrow width', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(shell(true)); });
    expect(labels(tree!)).toContain('bottom nav');

    act(() => { tree!.update(shell(false)); });
    expect(labels(tree!)).not.toContain('bottom nav');
  });

  // The rail carries the shop's identity at desktop width; with no rail, the
  // narrow bar has to carry it instead, or the shop name disappears entirely.
  it('names the shop at both widths', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(shell(false)); });
    expect(labels(tree!)).toContain('Jaalala Skincare');

    act(() => { tree!.update(shell(true)); });
    expect(labels(tree!)).toContain('Jaalala Skincare');
  });

  // Native tablets render `<AdminSidebar><Slot /></AdminSidebar>` with no props
  // at all, and must keep the rail they have always had.
  it('defaults to the wide layout with no bottom nav', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(<AdminSidebar><Screen /></AdminSidebar>); });
    expect(labels(tree!)).toContain('Powered by Ka Iibi');
    expect(labels(tree!)).toContain('inventory screen');
  });
});
