import { useEffect } from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Below the mocks in intent, above them in source: babel-plugin-jest-hoist
// lifts every `jest.mock` above the imports regardless.
import { AdminSidebar } from '@/components/admin-sidebar';
import { useAuth } from '@/hooks/use-auth';
import type { Module } from '@/lib/entitlements';
import type { Permission } from '@/lib/permissions';
import { countOrdersNeedingAction } from '@/lib/storefront-admin';

// `signOut` in the ☰ menu reaches lib/auth, which constructs a real Supabase
// client at import time and throws without the app's env vars.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  usePathname: () => '/inventory',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  // The Orders badge refetches on focus (use-refresh-on-focus.ts). Run the
  // callback once, the way mounting does, so nothing here depends on a real
  // navigator.
  useFocusEffect: (cb: () => void | (() => void)) => cb(),
}));
// The one query the rail makes: how many orders are waiting. Automocking the
// whole module would leave it an undefined-returning jest.fn, which the hook
// would swallow into a silent 0 -- and the badge test would then pass for the
// wrong reason.
jest.mock('@/lib/storefront-admin', () => ({ countOrdersNeedingAction: jest.fn(async () => 0) }));
jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
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

// A shop on every plan, run by someone allowed everything. Each test narrows
// the one thing it is about.
function signIn(overrides: { can?: (p: Permission) => boolean; hasModule?: (m: Module) => boolean } = {}) {
  (useAuth as jest.Mock).mockReturnValue({
    shop: { id: 's1', name: 'Jaalala Skincare', logoUrl: null, categories: ['Skincare'] },
    can: () => true,
    canAny: () => true,
    myMembership: { active: true },
    hasModule: () => true,
    ...overrides,
  });
}

beforeEach(() => {
  mounts = 0;
  jest.clearAllMocks();
  (countOrdersNeedingAction as jest.Mock).mockResolvedValue(0);
  signIn();
});

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

// The storefront is a sales channel, not a preference. Filed under Settings →
// Business it was four taps deep on a phone, and 1 of 11 shops had ever
// published a page.
describe('AdminSidebar storefront rows', () => {
  async function renderRail() {
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(false)); });
    return tree!;
  }

  it('offers Storefront and Orders alongside the other five', async () => {
    const shown = labels(await renderRail());
    expect(shown).toContain('Storefront');
    expect(shown).toContain('Orders');
    // The five that were always there are untouched.
    expect(shown).toEqual(expect.arrayContaining(['Dashboard', 'POS', 'Inventory', 'People', 'Accounting']));
  });

  // A shop whose plan has no storefront must not be shown a page it cannot
  // have -- the settings sidebar already gates both rows this way.
  it('hides both from a shop without the storefront module', async () => {
    signIn({ hasModule: (m) => m !== 'storefront' });
    const shown = labels(await renderRail());
    expect(shown).not.toContain('Storefront');
    expect(shown).not.toContain('Orders');
    expect(shown).toContain('Inventory');
  });

  // The nav filter must match the route guard (both routes are settings.access
  // in permissions.ts), or the rail offers a door that bounces straight back.
  it('hides both from someone who cannot open Settings', async () => {
    signIn({ can: (p) => p !== 'settings.access' });
    const shown = labels(await renderRail());
    expect(shown).not.toContain('Storefront');
    expect(shown).not.toContain('Orders');
    expect(shown).toContain('Inventory');
  });

  // The signal that an order is waiting has to travel with the row, or it
  // stays buried on the screen nobody opens.
  it('carries the orders-needing-action count onto the row', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(3);
    const shown = labels(await renderRail());
    expect(shown).toContain('3');
    expect(countOrdersNeedingAction).toHaveBeenCalledWith('s1');
  });

  it('shows no count when nothing is waiting', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(0);
    expect(labels(await renderRail())).not.toContain('0');
  });

  // One count on the wire, not one per row: a shop without the module is never
  // asked at all.
  it('does not ask for the count when the shop has no storefront', async () => {
    signIn({ hasModule: (m) => m !== 'storefront' });
    await renderRail();
    expect(countOrdersNeedingAction).not.toHaveBeenCalled();
  });
});
