import { StyleSheet, Text, View } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';

// Below the mocks in intent, above them in source: babel-plugin-jest-hoist
// lifts every `jest.mock` above the imports regardless.
//
// The PHONE shell, imported by its bare path so platform resolution picks the
// native file -- this suite is about `admin-tabs.tsx`, the branch a shopkeeper
// on an iPhone actually gets. `admin-tabs-web.test.tsx` covers the other one.
//
// This file exists because it did not: two defects (a "9+" badge that wrapped
// onto two lines, and a ☰ sheet exposed to VoiceOver as one blob) shipped in a
// component with no test file at all, and were only found by driving a real
// simulator.
import AdminTabs from '@/components/admin-tabs';
import { useAuth } from '@/hooks/use-auth';
import { resetStorefrontPresence } from '@/hooks/use-storefront-nav';
import type { Module } from '@/lib/entitlements';
import type { Permission } from '@/lib/permissions';
import { countOrdersNeedingAction, getMyStorefront } from '@/lib/storefront-admin';

// Same stubs the sibling shells' suites use, and for the same reasons:
// `signOut` in the ☰ menu reaches lib/auth, which builds a real Supabase
// client at import time, and the badge refetches on focus.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  // The routed screen. Only the tablet branch renders it; the phone branch
  // hands the screens to `NativeTabs` below.
  Slot: () => null,
  usePathname: () => '/inventory',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: (cb: () => void | (() => void)) => cb(),
}));
// `NativeTabs` is a native UITabBarController through react-native-screens --
// there is nothing for it to attach to under Jest. Stubbed down to plain views
// so the header above it, which is what this suite is about, still renders.
jest.mock('expo-router/unstable-native-tabs', () => {
  const { View: RNView } = jest.requireActual('react-native');
  const Trigger = Object.assign(({ children }: { children?: React.ReactNode }) => <RNView>{children}</RNView>, {
    Label: ({ children }: { children?: React.ReactNode }) => <RNView>{children}</RNView>,
    Icon: () => null,
    Badge: ({ children }: { children?: React.ReactNode }) => <RNView>{children}</RNView>,
  });
  return { NativeTabs: Object.assign(({ children }: { children?: React.ReactNode }) => <RNView>{children}</RNView>, { Trigger }) };
});
jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: false })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true })),
}));
// The one query the header makes: how many orders are waiting. Automocking the
// whole module would leave it an undefined-returning jest.fn, which the hook
// swallows into a silent 0 -- and every badge test below would then pass for
// the wrong reason.
jest.mock('@/lib/storefront-admin', () => ({
  countOrdersNeedingAction: jest.fn(async () => 0),
  getMyStorefront: jest.fn(async () => null),
}));
jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-shop-logo', () => ({ useShopLogo: () => ({ editLogo: jest.fn(), canEditLogo: true }) }));
jest.mock('@/lib/shops', () => ({ updateShop: jest.fn(), uploadShopLogo: jest.fn() }));
jest.mock('@/lib/storage', () => ({ deleteImageByPublicUrl: jest.fn() }));
// The phone branch, deliberately. `isTabletDevice()` is the one lever that
// swaps this component for `AdminSidebar`, and a tablet-shaped run would test
// a different file entirely.
jest.mock('@/lib/device', () => ({ isTabletDevice: () => false }));
jest.mock('@/components/location-switcher', () => ({ LocationSwitcher: () => null }));
jest.mock('@/components/support/support-banner', () => ({ SupportBanner: () => null }));
jest.mock('@/components/support/support-menu-item', () => ({ SupportMenuItem: () => null }));
jest.mock('@/components/support/support-sheet', () => ({ SupportSheet: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

function labels(tree: ReactTestRenderer) {
  return tree.root.findAllByType(Text).flatMap((t) => (typeof t.props.children === 'string' ? [t.props.children] : []));
}

// The nearest ancestor that actually handles a press. Matching `Pressable` by
// TYPE does not work: react-native's export is a forwardRef wrapper and the
// instance in the tree is not the same reference this file would import.
function pressableAbove(node: ReactTestInstance, skip = 0): ReactTestInstance {
  let found = skip;
  let cursor: ReactTestInstance | null = node.parent as ReactTestInstance | null;
  while (cursor) {
    if (typeof cursor.props?.onPress === 'function') {
      if (found === 0) return cursor;
      found -= 1;
    }
    cursor = cursor.parent as ReactTestInstance | null;
  }
  throw new Error('no pressable ancestor');
}

function glyph(tree: ReactTestRenderer, char: string): ReactTestInstance {
  const node = tree.root.findAllByType(Text).find((t) => t.props.children === char);
  if (!node) throw new Error(`no ${char} on screen`);
  return node;
}

// The ☰ button in the header, and the little red count that hangs off its
// corner. The dot's `Text` is found through the BUTTON rather than by its
// string, because the Orders row inside the sheet renders the same "9+".
function menuButton(tree: ReactTestRenderer) {
  return pressableAbove(glyph(tree, '☰'));
}
function headerDot(tree: ReactTestRenderer) {
  const text = menuButton(tree)
    .findAllByType(Text)
    .find((t) => t.props.children !== '☰');
  if (!text) return null;
  return { text, box: text.parent as ReactTestInstance };
}

// Every labelled element on screen, read off the host `View` each `Pressable`
// renders. Filtered by type on purpose: a labelled `Pressable` shows up twice
// in this tree, once as the composite and once as the `View` it returns.
function a11yRows(tree: ReactTestRenderer) {
  return tree.root.findAll((n) => n.type === View && typeof n.props.accessibilityLabel === 'string');
}
function a11yRow(tree: ReactTestRenderer, label: string) {
  const rows = a11yRows(tree).filter((n) => (n.props.accessibilityLabel as string).startsWith(label));
  if (rows.length !== 1) throw new Error(`expected exactly one row starting "${label}", found ${rows.length}`);
  return rows[0];
}

async function openMenu(tree: ReactTestRenderer) {
  await act(async () => { (menuButton(tree).props.onPress as () => void)(); });
  return tree;
}

// A shop on every plan, run by someone allowed everything. Each test narrows
// the one thing it is about.
function signIn(
  overrides: { can?: (p: Permission) => boolean; hasModule?: (m: Module) => boolean; entitlements?: { resolved: boolean } } = {}
) {
  (useAuth as jest.Mock).mockReturnValue({
    shop: { id: 's1', name: 'Jaalala Skincare', logoUrl: null, categories: ['Skincare'] },
    can: () => true,
    canAny: () => true,
    myMembership: { active: true },
    hasModule: () => true,
    refreshShop: jest.fn(),
    entitlements: { resolved: true },
    ...overrides,
  });
}

// The shop whose plan has lapsed but whose customers are still waiting: no
// `storefront` module, but a `storefronts` row still on file. That is the pair
// `useStorefrontNavState` reads as 'locked', and the pair
// `useOrdersNeedingActionBadge` still counts orders for.
function signInLapsed() {
  signIn({ hasModule: (m) => m !== 'storefront' });
  (getMyStorefront as jest.Mock).mockResolvedValue({ id: 'sf1', slug: 'jaalala' });
}

async function render() {
  let tree: ReactTestRenderer | undefined;
  await act(async () => { tree = create(<AdminTabs />); });
  return tree!;
}

beforeEach(() => {
  jest.clearAllMocks();
  (countOrdersNeedingAction as jest.Mock).mockResolvedValue(0);
  (getMyStorefront as jest.Mock).mockResolvedValue(null);
  // Cached per shop for the life of the process, so a test that did not clear
  // it would read the previous test's shop.
  resetStorefrontPresence();
  signIn();
});

// DEFECT 1. On a real iPhone with 12 orders waiting, the header dot rendered
// "9" stacked above "+" as a tall red pill covering a third of the ☰. The
// cause, confirmed on the simulator by enlarging the ☰ glyph and NOTHING else
// (the wrap vanished): the dot is `position: 'absolute'` with no width, so
// Yoga measures it against the ☰ button's content box -- about 19pt of glyph
// -- and after the dot's own 10pt of horizontal padding there is not enough
// room for a two-character string, so the `Text` wraps.
describe('the ☰ waiting-order count', () => {
  it('caps the count at 9+ when more than nine orders are waiting', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(12);
    const dot = headerDot(await render());
    expect(dot?.text.props.children).toBe('9+');
  });

  it('shows the exact count while it still fits in one character', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(3);
    const dot = headerDot(await render());
    expect(dot?.text.props.children).toBe('3');
  });

  it('renders no dot at all when nothing is waiting', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(0);
    const tree = await render();
    // Paired with a marker that the header genuinely rendered -- "no dot" is
    // otherwise satisfied by a build with no header.
    expect(labels(tree)).toContain('☰');
    expect(headerDot(tree)).toBeNull();
  });

  // The fix, stated as the property that was violated: the dot must carry its
  // own width, so nothing about the button it hangs off can decide whether
  // "9+" fits.
  it('sizes the dot from its own style, not from the ☰ button it hangs off', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(12);
    const dot = headerDot(await render());
    const box = StyleSheet.flatten(dot!.box.props.style) as { width?: number; height?: number };
    expect(typeof box.width).toBe('number');
    // Wide enough for the two characters it must hold: "9+" at 10.5pt/800 is
    // roughly 14pt.
    expect(box.width).toBeGreaterThanOrEqual(14);
    expect(typeof box.height).toBe('number');
  });

  // Belt to that brace, and the assertion that names the symptom directly: at
  // any font scale, the count is one line or it is nothing.
  it('never lets the count wrap onto a second line', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(12);
    const dot = headerDot(await render());
    expect(dot!.text.props.numberOfLines).toBe(1);
  });

  // The badge is load-bearing for exactly this shop: the plan lapsed, the
  // module is gone, and the orders its customers already placed still have to
  // be picked. Losing the count here loses the only signal at the till.
  it('keeps the 9+ badge for a lapsed shop whose customers are still waiting', async () => {
    signInLapsed();
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(12);
    const tree = await render();
    const dot = headerDot(tree);
    expect(dot?.text.props.children).toBe('9+');
    const box = StyleSheet.flatten(dot!.box.props.style) as { width?: number };
    expect(typeof box.width).toBe('number');
    // And the row behind it is still there, greyed and locked rather than gone.
    const shown = labels(await openMenu(tree));
    expect(shown).toContain('Orders');
    expect(shown).toContain('🔒');
  });
});

// DEFECT 2. Dumping the iOS hierarchy with the sheet open returned ONE node
// labelled "🌐, Storefront, 🛍, Orders, 9+, ⚙, Settings, Help and support,
// Sign out". Cause: the full-screen backdrop is a `Pressable`, and RN's
// Pressable defaults `accessible` to true (Pressable.js:252), which makes the
// whole subtree a single iOS accessibility element. On a phone the ☰ is the
// ONLY route to Storefront and Orders, so a screen-reader user could reach
// neither.
describe('the ☰ sheet as accessibility', () => {
  it('does not swallow its rows into the backdrop', async () => {
    const tree = await openMenu(await render());
    // The row, then the backdrop that wraps every row.
    const backdrop = pressableAbove(glyph(tree, '🌐'), 1);
    expect(backdrop.props.accessible).toBe(false);
  });

  it('gives every row its own label instead of letting the emoji name it', async () => {
    const tree = await openMenu(await render());
    const rows = a11yRows(tree).map((n) => n.props.accessibilityLabel as string);
    // Every destination the sheet offers, named in words.
    expect(rows).toEqual(expect.arrayContaining(['Storefront', 'Orders', 'Settings', 'Sign out']));
    // And not one of them led with a glyph a screen reader would read aloud.
    for (const row of rows) expect(row).toMatch(/^[A-Z]/);
  });

  it('marks the rows as buttons', async () => {
    const tree = await openMenu(await render());
    expect(a11yRow(tree, 'Storefront').props.accessibilityRole).toBe('button');
  });

  // The badge is a red dot to a sighted shopkeeper and nothing at all to a
  // screen reader unless the count is said out loud -- and said as the real
  // number, not as the "9+" the pill is clamped to.
  it('says the waiting count out loud on the ☰ button and on the Orders row', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(12);
    const tree = await render();
    expect(menuButton(tree).props.accessibilityLabel).toBe('Menu, 12 orders waiting');
    await openMenu(tree);
    expect(a11yRow(tree, 'Orders').props.accessibilityLabel).toBe('Orders, 12 waiting');
  });

  it('says just Menu when nothing is waiting', async () => {
    const tree = await render();
    expect(menuButton(tree).props.accessibilityLabel).toBe('Menu');
  });

  it('counts one waiting order in the singular', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(1);
    const tree = await render();
    expect(menuButton(tree).props.accessibilityLabel).toBe('Menu, 1 order waiting');
  });

  // The 🔒 is the other piece of decoration in this sheet. A lapsed shop's
  // rows are still navigable -- they land on the upgrade wall -- so the lock
  // belongs in the label, not in `accessibilityState.disabled`.
  it('conveys the lock on a lapsed shop rather than drawing it only', async () => {
    signInLapsed();
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(12);
    const tree = await openMenu(await render());
    const rows = a11yRows(tree).map((n) => n.props.accessibilityLabel as string);
    expect(rows).toContain('Storefront, locked');
    expect(rows).toContain('Orders, 12 waiting, locked');
  });

  // Taking the backdrop out of the accessibility tree takes the tap-anywhere
  // dismissal with it, so the sheet has to answer VoiceOver's escape gesture.
  it('can still be dismissed by a screen reader', async () => {
    const tree = await openMenu(await render());
    const sheet = tree.root.find((n) => typeof n.props.onAccessibilityEscape === 'function');
    await act(async () => { (sheet.props.onAccessibilityEscape as () => void)(); });
    // The sheet is gone: its rows are off screen again.
    expect(labels(tree)).not.toContain('Storefront');
    expect(labels(tree)).toContain('☰');
  });
});
