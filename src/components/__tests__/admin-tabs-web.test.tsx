import { Dimensions, StyleSheet, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Below the mocks in intent, above them in source: babel-plugin-jest-hoist
// lifts every `jest.mock` above the imports regardless.
//
// Imported by its `.web` path rather than as `@/components/admin-tabs`: this
// file is about the WEB shell specifically -- the five-item bottom bar and the
// ☰ menu that sits beside it -- and platform resolution should not decide
// which of the two shells this suite is testing.
import AdminTabs from '@/components/admin-tabs.web';
import { useAuth } from '@/hooks/use-auth';
import { resetStorefrontPresence } from '@/hooks/use-storefront-nav';
import type { Module } from '@/lib/entitlements';
import type { Permission } from '@/lib/permissions';
import { countOrdersNeedingAction, shopHasStorefront } from '@/lib/storefront-admin';

// Same stubs admin-sidebar.test.tsx uses, and for the same reasons: `signOut`
// in the ☰ menu reaches lib/auth, which builds a real Supabase client at
// import time, and the badge refetches on focus.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  // The routed screen. `AdminTabs` renders it inside the one shared slot; what
  // it contains is not what this file is about.
  Slot: () => null,
  usePathname: () => '/inventory',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: (cb: () => void | (() => void)) => cb(),
}));
jest.mock('@/lib/storefront-admin', () => ({
  countOrdersNeedingAction: jest.fn(async () => 0),
  shopHasStorefront: jest.fn(async () => false),
}));
jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-shop-logo', () => ({ useShopLogo: () => ({ editLogo: jest.fn(), canEditLogo: true }) }));
jest.mock('@/components/location-switcher', () => ({ LocationSwitcher: () => null }));
jest.mock('@/components/support/support-banner', () => ({ SupportBanner: () => null }));
jest.mock('@/components/support/support-menu-item', () => ({ SupportMenuItem: () => null }));
jest.mock('@/components/support/support-sheet', () => ({ SupportSheet: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

const PHONE = { width: 390, height: 844, scale: 3, fontScale: 1 };
const DESKTOP = { width: 1280, height: 800, scale: 2, fontScale: 1 };

// `AdminTabs` picks its width from `useWindowDimensions()`, so the width is
// set on `Dimensions` rather than passed in -- the same lever
// stock-count-modal.test.tsx pulls. Wrapped in `act` because any tree still
// mounted from a previous test is still subscribed to the change event.
async function setWidth(size: typeof PHONE) {
  await act(async () => {
    Dimensions.set({ window: size, screen: size });
  });
}

function labels(tree: ReactTestRenderer) {
  return tree.root.findAllByType(Text).flatMap((t) => (typeof t.props.children === 'string' ? [t.props.children] : []));
}

function colourOf(tree: ReactTestRenderer, label: string): string | undefined {
  const node = tree.root.findAllByType(Text).find((t) => t.props.children === label);
  if (!node) throw new Error(`no row labelled ${label} on screen`);
  return (StyleSheet.flatten(node.props.style) as { color?: string } | undefined)?.color;
}

function signIn(
  overrides: { can?: (p: Permission) => boolean; hasModule?: (m: Module) => boolean; entitlements?: { resolved: boolean } } = {}
) {
  (useAuth as jest.Mock).mockReturnValue({
    shop: { id: 's1', name: 'Jaalala Skincare', logoUrl: null, categories: ['Skincare'] },
    can: () => true,
    canAny: () => true,
    myMembership: { active: true },
    hasModule: () => true,
    entitlements: { resolved: true },
    ...overrides,
  });
}

async function render() {
  let tree: ReactTestRenderer | undefined;
  await act(async () => { tree = create(<AdminTabs />); });
  return tree!;
}

// The ☰ is found by walking up from the glyph to whatever actually handles the
// press: matching Pressable by TYPE does not work, because react-native's
// export is a forwardRef wrapper and the instance in the tree is not the same
// reference this file would import.
async function openMenu(tree: ReactTestRenderer) {
  const glyph = tree.root.findAllByType(Text).find((t) => t.props.children === '☰');
  let node = glyph as unknown as { props: Record<string, unknown>; parent: unknown } | null;
  while (node && typeof node.props?.onPress !== 'function') node = node.parent as typeof node;
  await act(async () => { (node!.props.onPress as () => void)(); });
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  (countOrdersNeedingAction as jest.Mock).mockResolvedValue(0);
  (shopHasStorefront as jest.Mock).mockResolvedValue(false);
  resetStorefrontPresence();
  signIn();
});

// `Dimensions.set` is a process-global, so the last width set outlives the
// test that set it.
afterEach(async () => {
  await setWidth(DESKTOP);
});

// WHY THIS FILE EXISTS. #102 was the same two rows appearing twice on one
// screen. The web shell's THIRD nav -- the mobile bottom bar in
// admin-tabs.web.tsx -- had no test at all: admin-sidebar.test.tsx passes
// `bottomNav={<Text>bottom nav</Text>}`, a stub, so the real bar never
// rendered under any assertion. Adding a greyed Storefront row to that bar
// (which is exactly what the comment at the end of its `navItems` warns
// against) would have put a narrow shop's Storefront in the bar AND the menu,
// and nothing would have gone red.
//
// KEEP THAT PROPERTY: this file must go on importing the real
// `@/components/admin-tabs.web` and stubbing nothing below `AdminSidebar`, so
// the actual `BottomNav` renders under every assertion here. A stub would give
// the whole file back to the bug it was written for.
//
// Storefront and Orders now have ONE home at every width -- the ☰ menu -- so
// the rule these tests pin has changed shape: the rows must be in the menu at
// 390 AND at 1280, and in no bar and no rail at either. The counts below are
// per SCREEN, over the whole rendered tree, so they see every nav the shell
// puts up at that width at once.
describe('AdminTabs (web) — each row appears once per screen', () => {
  // The shape that makes this file's subject visible: the phone bar is
  // rendered, the rail is not.
  it('renders the real five-item bottom bar at phone width, and no rail', async () => {
    await setWidth(PHONE);
    const shown = labels(await render());
    expect(shown).toEqual(expect.arrayContaining(['Dashboard', 'POS', 'Inventory', 'People', 'Accounting']));
    // The rail's footer is the marker for the rail being on screen at all.
    expect(shown).not.toContain('Powered by Ka Iibi');
  });

  it('keeps a lapsed shop’s rows out of the bottom bar entirely', async () => {
    signIn({ hasModule: (m) => m !== 'storefront' });
    (shopHasStorefront as jest.Mock).mockResolvedValue(true);
    await setWidth(PHONE);
    // Menu CLOSED: the bottom bar is the only nav on screen, and neither row
    // belongs in it at any lock state.
    const shown = labels(await render());
    expect(shown.filter((l) => l === 'Storefront')).toHaveLength(0);
    expect(shown.filter((l) => l === 'Orders')).toHaveLength(0);
  });

  it('shows a lapsed shop’s rows exactly once with the menu open at phone width', async () => {
    signIn({ hasModule: (m) => m !== 'storefront' });
    (shopHasStorefront as jest.Mock).mockResolvedValue(true);
    await setWidth(PHONE);
    const tree = await openMenu(await render());
    const shown = labels(tree);
    // Counted, not asserted absent: they SHOULD be on this screen, in the ☰
    // menu, exactly once. An absence check would pass against a build that
    // lost them altogether, which is the worse bug.
    expect(shown.filter((l) => l === 'Storefront')).toHaveLength(1);
    expect(shown.filter((l) => l === 'Orders')).toHaveLength(1);
    expect(shown.filter((l) => l === '🔒')).toHaveLength(2);
    expect(shown).toContain('Settings');
  });

  // The same count for a shop that is paying. The bottom bar's own list is not
  // gated on the storefront state at all, so a row added to it would show up
  // here too -- and this is the case that is true for most shops.
  it('shows a paying shop’s rows exactly once with the menu open at phone width', async () => {
    await setWidth(PHONE);
    const tree = await openMenu(await render());
    const shown = labels(tree);
    expect(shown.filter((l) => l === 'Storefront')).toHaveLength(1);
    expect(shown.filter((l) => l === 'Orders')).toHaveLength(1);
    expect(shown).not.toContain('🔒');
  });

  // The desktop twin of the bottom-bar test above: the rail is the nav on
  // screen at this width, and neither row belongs in it at any lock state.
  it('keeps a lapsed shop’s rows out of the rail entirely', async () => {
    signIn({ hasModule: (m) => m !== 'storefront' });
    (shopHasStorefront as jest.Mock).mockResolvedValue(true);
    await setWidth(DESKTOP);
    const shown = labels(await render());
    // The rail is genuinely up -- its footer, and the five rows it carries.
    expect(shown).toContain('Powered by Ka Iibi');
    expect(shown).toEqual(expect.arrayContaining(['Dashboard', 'POS', 'Inventory', 'People', 'Accounting']));
    // Menu CLOSED, so the rail is the only nav on screen.
    expect(shown.filter((l) => l === 'Storefront')).toHaveLength(0);
    expect(shown.filter((l) => l === 'Orders')).toHaveLength(0);
  });

  // And the wide width with the menu open: the ☰ is where both rows live now,
  // at 1280 exactly as at 390. This is #102's own case, asserted through the
  // real web shell rather than through AdminSidebar on its own.
  it('shows the rows once at desktop width, in the menu and not on the rail', async () => {
    signIn({ hasModule: (m) => m !== 'storefront' });
    (shopHasStorefront as jest.Mock).mockResolvedValue(true);
    await setWidth(DESKTOP);
    const tree = await render();
    expect(labels(tree)).toContain('Powered by Ka Iibi');
    expect(labels(tree)).not.toContain('Storefront');
    await openMenu(tree);
    const shown = labels(tree);
    expect(shown.filter((l) => l === 'Storefront')).toHaveLength(1);
    expect(shown.filter((l) => l === 'Orders')).toHaveLength(1);
    expect(shown.filter((l) => l === '🔒')).toHaveLength(2);
  });

  // A shop that never had a page still sees nothing anywhere -- neither bar
  // nor menu -- which is the half of the rule this task did not change.
  it('shows nothing anywhere to a shop that never had a storefront', async () => {
    signIn({ hasModule: (m) => m !== 'storefront' });
    await setWidth(PHONE);
    const tree = await openMenu(await render());
    const shown = labels(tree);
    expect(shown).not.toContain('Storefront');
    expect(shown).not.toContain('Orders');
    expect(shown).toContain('Settings');
    // Not an empty shell: the five that were always there are still in the bar.
    expect(shown).toContain('Inventory');
  });

  // The bar's own lock treatment, which is the reason a greyed row is
  // tempting to add here: the five paid tabs already grey and lock in place.
  // Pinned so that treatment stays about THOSE five.
  it('greys and locks a paid tab in the bar without moving the storefront rows into it', async () => {
    signIn({ hasModule: (m) => m !== 'inventory' && m !== 'storefront' });
    (shopHasStorefront as jest.Mock).mockResolvedValue(true);
    await setWidth(PHONE);
    const tree = await render();
    const shown = labels(tree);
    expect(colourOf(tree, 'Inventory')).not.toBe(colourOf(tree, 'POS'));
    expect(shown.filter((l) => l === '🔒')).toHaveLength(1);
    expect(shown).not.toContain('Storefront');
  });
});
