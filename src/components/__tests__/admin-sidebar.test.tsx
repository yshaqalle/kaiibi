import { useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Below the mocks in intent, above them in source: babel-plugin-jest-hoist
// lifts every `jest.mock` above the imports regardless.
import { AdminSidebar } from '@/components/admin-sidebar';
import { useAuth } from '@/hooks/use-auth';
import { resetStorefrontPresence } from '@/hooks/use-storefront-nav';
import type { Module } from '@/lib/entitlements';
import type { Permission } from '@/lib/permissions';
import { countOrdersNeedingAction, getMyStorefront } from '@/lib/storefront-admin';

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
// `getMyStorefront` is the other half of the lapsed test: the nav tells a shop
// that HAD a page from one that never did by asking whether a `storefronts`
// row exists. Stubbed at "never had one", which is the majority case and the
// one every pre-existing test in this file was written against.
jest.mock('@/lib/storefront-admin', () => ({
  countOrdersNeedingAction: jest.fn(async () => 0),
  getMyStorefront: jest.fn(async () => null),
}));
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

// The resolved colour a given row's label is painted in. Read rather than
// compared against a literal on purpose: the assertion these tests want to
// make is "the same grey the five paid tabs get", not "#999999".
function colourOf(tree: ReactTestRenderer, label: string): string | undefined {
  const node = tree.root.findAllByType(Text).find((t) => t.props.children === label);
  if (!node) throw new Error(`no row labelled ${label} on screen`);
  return (StyleSheet.flatten(node.props.style) as { color?: string } | undefined)?.color;
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
    // `resolved: false` is the fail-closed default the entitlement lookup
    // falls back to when it could not be read at all (entitlements.ts) --
    // signed-in shops here have a real answer.
    entitlements: { resolved: true },
    ...overrides,
  });
}

beforeEach(() => {
  mounts = 0;
  jest.clearAllMocks();
  (countOrdersNeedingAction as jest.Mock).mockResolvedValue(0);
  (getMyStorefront as jest.Mock).mockResolvedValue(null);
  // The presence lookup is cached per shop for the life of the process, so a
  // test that did not clear it would read the previous test's shop.
  resetStorefrontPresence();
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

  // A shop that never set a page up is not missing anything it can see. Note
  // what makes this true here and not in the lapsed block below: the stubbed
  // `getMyStorefront` returns null, i.e. there is no `storefronts` row.
  it('hides both from a shop that never had a storefront and has no module', async () => {
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

  // THE PHONE. The rail is not what a shopkeeper at 390px sees -- they get a
  // five-item bottom bar and this menu, and the walkthrough that found all of
  // this was run at that width. A fix that only reaches the rail reaches
  // desktop, which is not where these shops are.
  async function openPhoneMenu() {
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(true)); });
    // Found by walking up from the glyph to whatever actually handles a press.
    // Matching on Pressable's TYPE does not work here -- react-native's export
    // is a forwardRef wrapper and the instance in the tree is not the same
    // reference the test imports.
    const glyph = tree!.root.findAllByType(Text).find((t) => t.props.children === '\u2630');
    let node = glyph as unknown as { props: Record<string, unknown>; parent: unknown } | null;
    while (node && typeof node.props?.onPress !== 'function') {
      node = node.parent as typeof node;
    }
    await act(async () => { (node!.props.onPress as () => void)(); });
    return tree!;
  }

  // The point of the whole row: a shopkeeper on POS all day never opens this
  // menu and never stands on the dashboard, so a count that only lives in
  // those two places never reaches the person who has to pick the order.
  it('shows the waiting-order count on the closed menu button', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(3);
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(true)); });
    // Read WITHOUT opening the menu -- that is the whole assertion.
    expect(labels(tree!)).toContain('3');
  });

  it('shows no count on the button when nothing is waiting', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(0);
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(true)); });
    expect(labels(tree!)).not.toContain('0');
  });

  // The rail is the primary nav at wide width and already carries both rows.
  // Repeating them in the menu put the same two destinations on screen twice.
  // Counted rather than asserted absent on purpose: they SHOULD be on that
  // screen, just once -- an absence check would pass against a build that lost
  // them altogether, which is the worse bug.
  it('does not repeat the rows in the menu at wide width, where the rail has them', async () => {
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(false)); });
    expect(labels(tree!)).toContain('Storefront');
    const glyph = tree!.root.findAllByType(Text).find((t) => t.props.children === '\u2630');
    let node = glyph as unknown as { props: Record<string, unknown>; parent: unknown } | null;
    while (node && typeof node.props?.onPress !== 'function') node = node.parent as typeof node;
    await act(async () => { (node!.props.onPress as () => void)(); });
    const shown = labels(tree!);
    expect(shown.filter((l) => l === 'Storefront')).toHaveLength(1);
    expect(shown.filter((l) => l === 'Orders')).toHaveLength(1);
    expect(shown).toContain('Settings');
  });

  it('puts Storefront and Orders one tap from the phone menu', async () => {
    const shown = labels(await openPhoneMenu());
    expect(shown).toContain('Storefront');
    expect(shown).toContain('Orders');
    // Beside Settings, which is where it used to hide four taps below.
    expect(shown).toContain('Settings');
  });

  it('keeps them out of the phone menu without the module', async () => {
    signIn({ hasModule: (m) => m !== 'storefront' });
    const shown = labels(await openPhoneMenu());
    expect(shown).not.toContain('Storefront');
    expect(shown).not.toContain('Orders');
    expect(shown).toContain('Settings');
  });

  it('carries the waiting-order count into the phone menu too', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(2);
    const shown = labels(await openPhoneMenu());
    expect(shown).toContain('2');
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

  // One count on the wire, not one per row: a shop with no page and no module
  // has no Orders row to badge, so it is never asked at all.
  it('does not ask for the count when the shop never had a storefront', async () => {
    signIn({ hasModule: (m) => m !== 'storefront' });
    await renderRail();
    expect(countOrdersNeedingAction).not.toHaveBeenCalled();
  });
});

// A plan lapses, the month of grace runs out, and the shop keeps its page in
// the database while losing the module. Hiding the rows from THAT shop takes
// away the only signpost back to paying, so they are greyed instead -- the same
// 🔒 the five paid tabs get, landing on the same upgrade wall.
describe('AdminSidebar storefront rows after a lapse', () => {
  // The lapsed shape: no `storefront` module, but a `storefronts` row still
  // there. Everything else about the shop is untouched -- the other four paid
  // modules still resolve, which is what makes the lock assertions below about
  // storefront alone.
  function lapsedWithAPage() {
    signIn({ hasModule: (m) => m !== 'storefront' });
    (getMyStorefront as jest.Mock).mockResolvedValue({ shopId: 's1', slug: 'jaalala', publishedAt: null });
  }

  async function renderRail() {
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(false)); });
    return tree!;
  }

  async function openMenu(tree: ReactTestRenderer) {
    const glyph = tree.root.findAllByType(Text).find((t) => t.props.children === '☰');
    let node = glyph as unknown as { props: Record<string, unknown>; parent: unknown } | null;
    while (node && typeof node.props?.onPress !== 'function') node = node.parent as typeof node;
    await act(async () => { (node!.props.onPress as () => void)(); });
    return tree;
  }

  it('shows Storefront and Orders rather than hiding them', async () => {
    lapsedWithAPage();
    const shown = labels(await renderRail());
    expect(shown).toContain('Storefront');
    expect(shown).toContain('Orders');
  });

  // Property 1: the same treatment, not a second implementation of it. The
  // expected colour is READ OFF a paid tab that is genuinely locked in the
  // same rail, so a fork of the lock styling fails this even if it looks fine.
  it('greys them with the same lock the five paid tabs get', async () => {
    signIn({ hasModule: (m) => m !== 'inventory' });
    const paidTabGrey = colourOf(await renderRail(), 'Inventory');

    resetStorefrontPresence();
    lapsedWithAPage();
    const rail = await renderRail();
    expect(colourOf(rail, 'Storefront')).toBe(paidTabGrey);
    expect(colourOf(rail, 'Orders')).toBe(paidTabGrey);
    // And a row that is NOT locked is not painted that grey, or the assertion
    // above would hold for a rail with no lock treatment at all.
    expect(colourOf(rail, 'Accounting')).not.toBe(paidTabGrey);
  });

  it('marks both rows with the 🔒 and nothing else', async () => {
    lapsedWithAPage();
    const shown = labels(await renderRail());
    expect(shown.filter((l) => l === '🔒')).toHaveLength(2);
  });

  // Property 2: the half of the original reasoning that still stands.
  it('still shows nothing to a shop that never had a page', async () => {
    signIn({ hasModule: (m) => m !== 'storefront' });
    (getMyStorefront as jest.Mock).mockResolvedValue(null);
    const shown = labels(await renderRail());
    expect(shown).not.toContain('Storefront');
    expect(shown).not.toContain('Orders');
    expect(shown).not.toContain('🔒');
    // Not an empty rail -- the other five are still there, so this is an
    // absence of two rows and not an absence of a nav.
    expect(shown).toContain('Inventory');
  });

  // The nav must not offer a door the route guard would bounce. Both routes
  // are `settings.access` in permissions.ts, lapsed or not.
  it('shows nothing to someone who cannot open Settings, lapsed or not', async () => {
    lapsedWithAPage();
    signIn({ can: (p) => p !== 'settings.access', hasModule: (m) => m !== 'storefront' });
    const shown = labels(await renderRail());
    expect(shown).not.toContain('Storefront');
    expect(shown).not.toContain('Orders');
    expect(shown).toContain('Inventory');
  });

  // And not even asked for. `settings.access` is checked before the lookup as
  // well as after it: a cashier's answer cannot change anything on their
  // screen, so asking is a request every cashier session at every shop without
  // the module would spend for nothing.
  it('does not ask the database at all for someone who cannot open Settings', async () => {
    lapsedWithAPage();
    signIn({ can: (p) => p !== 'settings.access', hasModule: (m) => m !== 'storefront' });
    await renderRail();
    expect(getMyStorefront).not.toHaveBeenCalled();
  });

  // #102, restated for the lapsed shop. The rail carries both rows at wide
  // width, so the ☰ menu must not carry them too. Counted rather than asserted
  // absent: they SHOULD be on that screen, exactly once.
  it('still shows each row once per screen at wide width', async () => {
    lapsedWithAPage();
    const tree = await openMenu(await renderRail());
    const shown = labels(tree);
    expect(shown.filter((l) => l === 'Storefront')).toHaveLength(1);
    expect(shown.filter((l) => l === 'Orders')).toHaveLength(1);
    expect(shown.filter((l) => l === '🔒')).toHaveLength(2);
    expect(shown).toContain('Settings');
  });

  // And the phone, where there is no rail and the menu is the only place the
  // rows can live -- still once each, and still locked.
  it('still shows each row once per screen at narrow width', async () => {
    lapsedWithAPage();
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(true)); });
    // Closed menu: neither row is anywhere yet.
    expect(labels(tree!)).not.toContain('Storefront');
    await openMenu(tree!);
    const shown = labels(tree!);
    expect(shown.filter((l) => l === 'Storefront')).toHaveLength(1);
    expect(shown.filter((l) => l === 'Orders')).toHaveLength(1);
    expect(shown.filter((l) => l === '🔒')).toHaveLength(2);
  });

  it('greys the phone menu rows too', async () => {
    lapsedWithAPage();
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(true)); });
    await openMenu(tree!);
    expect(colourOf(tree!, 'Storefront')).not.toBe(colourOf(tree!, 'Settings'));
    expect(colourOf(tree!, 'Orders')).not.toBe(colourOf(tree!, 'Settings'));
  });

  // Property 5. Those orders exist and still need picking; a shop that has
  // stopped paying has not stopped owing its customers their goods.
  it('keeps the waiting-order count on the menu button', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(3);
    lapsedWithAPage();
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(true)); });
    // Read WITHOUT opening the menu -- the count has to reach the person at
    // the till, not only someone who already went looking.
    expect(labels(tree!)).toContain('3');
    expect(countOrdersNeedingAction).toHaveBeenCalledWith('s1');
  });

  // A locked row that also has orders waiting has to carry both marks. The
  // rail used to assume no row was ever locked AND badged, which a lapsed
  // shop with open orders makes false.
  it('carries the count and the lock on the same Orders row', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(3);
    lapsedWithAPage();
    const rail = await renderRail();
    const shown = labels(rail);
    expect(shown).toContain('3');
    expect(shown.filter((l) => l === '🔒')).toHaveLength(2);

    // Both marks present is not enough: they used to be two siblings each
    // claiming `marginLeft: 'auto'`, which was safe only while no row was ever
    // locked AND badged. Two auto margins in one row means the second one gets
    // no space pushed to it, so it lands wherever the first left it. Exactly
    // one thing in the row may claim the far edge.
    // Walked up by `onHoverIn` rather than `onPress`: the rail's rows take
    // their press handler from expo-router's `Link asChild`, which is stubbed
    // out at the top of this file, so no onPress survives into the tree.
    const label = rail.root.findAllByType(Text).find((t) => t.props.children === 'Orders')!;
    let row = label as unknown as { props: Record<string, unknown>; parent: unknown };
    while (row && typeof row.props?.onHoverIn !== 'function') row = row.parent as typeof row;
    const pushedToTheEdge = (row as unknown as ReactTestRenderer['root']).findAll(
      // Host elements only -- a composite and the host it renders would
      // otherwise both count, and one View would read as two.
      (node) =>
        typeof node.type === 'string' &&
        (StyleSheet.flatten(node.props?.style) as { marginLeft?: unknown } | undefined)?.marginLeft === 'auto',
      { deep: true }
    );
    expect(pushedToTheEdge).toHaveLength(1);
  });

  // What the rows render before the answer arrives. Both halves of the
  // condition land asynchronously, and either flash is a defect: a locked row
  // for a shop that turns out to be paying, or an open row for one that is
  // not. Neither row exists until the answer does.
  it('shows nothing at all while the storefront lookup is still in flight', async () => {
    signIn({ hasModule: (m) => m !== 'storefront' });
    (getMyStorefront as jest.Mock).mockReturnValue(new Promise(() => {}));
    const shown = labels(await renderRail());
    expect(shown).not.toContain('Storefront');
    expect(shown).not.toContain('Orders');
    expect(shown).not.toContain('🔒');
    expect(shown).toContain('Inventory');
  });

  // The entitlement lookup failing is NOT the same as a lapse. `resolved:
  // false` is the fail-closed default (entitlements.ts), and telling a
  // possibly-paid-up shop its storefront is locked would be a false
  // accusation dressed up as an upsell -- the same call _layout.tsx makes.
  it('does not lock the rows when the plan could not be read at all', async () => {
    signIn({ hasModule: (m) => m !== 'storefront', entitlements: { resolved: false } });
    (getMyStorefront as jest.Mock).mockResolvedValue({ shopId: 's1', slug: 'jaalala', publishedAt: null });
    const shown = labels(await renderRail());
    expect(shown).not.toContain('Storefront');
    expect(shown).not.toContain('🔒');
    expect(getMyStorefront).not.toHaveBeenCalled();
  });

  // And the same in the direction a background auth reload takes it: the
  // answer was known, then the next entitlement fetch failed. A remembered
  // answer must not outlive the plan it was read against.
  it('takes the lock back off if the plan stops resolving', async () => {
    lapsedWithAPage();
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(false)); });
    expect(labels(tree!)).toContain('Storefront');

    signIn({ hasModule: (m) => m !== 'storefront', entitlements: { resolved: false } });
    await act(async () => { tree!.update(shell(false)); });
    expect(labels(tree!)).not.toContain('Storefront');
    expect(labels(tree!)).not.toContain('🔒');
  });

  // A shop in the grace month keeps its whole plan, so nothing about it looks
  // different -- the greying starts only once grace has run out.
  it('leaves a shop that still has the module completely alone', async () => {
    (getMyStorefront as jest.Mock).mockResolvedValue({ shopId: 's1', slug: 'jaalala', publishedAt: null });
    const rail = await renderRail();
    const shown = labels(rail);
    expect(shown).toContain('Storefront');
    expect(shown).not.toContain('🔒');
    expect(colourOf(rail, 'Storefront')).toBe(colourOf(rail, 'Accounting'));
    // And no query is made for a shop whose module already answers the
    // question -- the nav renders on every screen.
    expect(getMyStorefront).not.toHaveBeenCalled();
  });

  // An answer is about one shop. Someone who moves to a second shop must not
  // be shown the first shop's lapse for the render it takes to find out --
  // that is a locked row on a shop that may well be paying.
  it('does not answer for one shop with another shop’s page', async () => {
    lapsedWithAPage();
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(false)); });
    expect(labels(tree!)).toContain('Storefront');

    const signedIn = (useAuth as jest.Mock)();
    (useAuth as jest.Mock).mockReturnValue({ ...signedIn, shop: { id: 's2', name: 'Xamdi Electronics', logoUrl: null, categories: [] } });
    // Left in flight, so the only thing that could put a row on screen here is
    // the previous shop's answer.
    (getMyStorefront as jest.Mock).mockReturnValue(new Promise(() => {}));
    await act(async () => { tree!.update(shell(false)); });
    expect(labels(tree!)).not.toContain('Storefront');
    expect(labels(tree!)).not.toContain('🔒');
  });

  // One request per shop for the whole session, however many navs ask. The
  // rail and the orders badge are two callers in one tree.
  it('asks the database once however many places need the answer', async () => {
    lapsedWithAPage();
    await renderRail();
    await renderRail();
    expect(getMyStorefront).toHaveBeenCalledTimes(1);
  });
});
