import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';

// Below the mocks in intent, above them in source: babel-plugin-jest-hoist
// lifts every `jest.mock` above the imports regardless.
import { AdminSidebar } from '@/components/admin-sidebar';
import { useAuth } from '@/hooks/use-auth';
import { resetStorefrontPresence } from '@/hooks/use-storefront-nav';
import type { Module } from '@/lib/entitlements';
import type { Permission } from '@/lib/permissions';
import { countOrdersNeedingAction, shopHasStorefront } from '@/lib/storefront-admin';

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
// `shopHasStorefront` is the other half of the lapsed test: the nav tells a shop
// that HAD a page from one that never did by asking whether a `storefronts`
// row exists. Stubbed at "never had one", which is the majority case and the
// one every pre-existing test in this file was written against.
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

// The ☰ opens at BOTH widths -- the button lives in `barRight`, outside the
// `compact ?` branch -- and since the rows moved out of the rail it is the only
// surface that carries them, so almost every test below has to open it.
// Found by walking up from the glyph to whatever actually handles the press:
// matching Pressable by TYPE does not work, because react-native's export is a
// forwardRef wrapper and the instance in the tree is not the same reference
// this file would import.
async function openMenu(tree: ReactTestRenderer) {
  const glyph = tree.root.findAllByType(Text).find((t) => t.props.children === '☰');
  let node = glyph as unknown as { props: Record<string, unknown>; parent: unknown } | null;
  while (node && typeof node.props?.onPress !== 'function') node = node.parent as typeof node;
  await act(async () => { (node!.props.onPress as () => void)(); });
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
  (shopHasStorefront as jest.Mock).mockResolvedValue(false);
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
  async function renderWide() {
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(false)); });
    return tree!;
  }

  // THE CHANGE. Both rows used to be rail entries at this width. They are in
  // the ☰ now, at every width, and in no rail at any. The rail assertions are
  // paired with a marker that the rail actually rendered -- "not in the rail"
  // is otherwise satisfied by a build with no rail at all.
  it('offers Storefront and Orders in the ☰ at wide width, and not in the rail', async () => {
    const tree = await renderWide();
    const closed = labels(tree);
    // The rail is on screen: its footer, and the five rows it does carry.
    expect(closed).toContain('Powered by Ka Iibi');
    expect(closed).toEqual(expect.arrayContaining(['Dashboard', 'POS', 'Inventory', 'People', 'Accounting']));
    // And neither row is in it.
    expect(closed).not.toContain('Storefront');
    expect(closed).not.toContain('Orders');

    const shown = labels(await openMenu(tree));
    expect(shown).toContain('Storefront');
    expect(shown).toContain('Orders');
  });

  // A shop that never set a page up is not missing anything it can see. Note
  // what makes this true here and not in the lapsed block below: the stubbed
  // `shopHasStorefront` answers false, i.e. there is no `storefronts` row.
  it('hides both from a shop that never had a storefront and has no module', async () => {
    signIn({ hasModule: (m) => m !== 'storefront' });
    const shown = labels(await openMenu(await renderWide()));
    expect(shown).not.toContain('Storefront');
    expect(shown).not.toContain('Orders');
    // The menu is genuinely open and the rail is genuinely up, so this is an
    // absence of two rows and not an absence of a nav.
    expect(shown).toContain('Settings');
    expect(shown).toContain('Inventory');
  });

  // The nav filter must match the route guard (both routes are settings.access
  // in permissions.ts), or the menu offers a door that bounces straight back.
  it('hides both from someone who cannot open Settings', async () => {
    signIn({ can: (p) => p !== 'settings.access' });
    const shown = labels(await openMenu(await renderWide()));
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
    return openMenu(tree!);
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

  // #102, at the width the rows just moved at. The \u2630 is their one home now, so
  // each has to be on the wide screen exactly once -- in the menu. Counted
  // rather than asserted absent on purpose: they SHOULD be on that screen,
  // just once -- an absence check would pass against a build that lost them
  // altogether, which is the worse bug.
  it('shows each row exactly once per screen at wide width, in the \u2630', async () => {
    const tree = await renderWide();
    // The rail is up and does not have them, so the count below can only come
    // from the menu.
    expect(labels(tree)).toContain('Powered by Ka Iibi');
    expect(labels(tree).filter((l) => l === 'Storefront')).toHaveLength(0);
    await openMenu(tree);
    const shown = labels(tree);
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
  // stays buried on the screen nobody opens. At wide width that is now two
  // places: the ☰ button, which is what the person at the till sees without
  // going looking, and the Orders row inside the menu once they do.
  it('carries the orders-needing-action count onto the ☰ button and the Orders row', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(3);
    const tree = await renderWide();
    // Closed: exactly one 3 on screen, and it is the button's -- the rail has
    // no Orders row to badge any more.
    expect(labels(tree).filter((l) => l === '3')).toHaveLength(1);
    expect(labels(tree)).not.toContain('Orders');

    await openMenu(tree);
    // Open: the button's count and the row's, which is two.
    expect(labels(tree)).toContain('Orders');
    expect(labels(tree).filter((l) => l === '3')).toHaveLength(2);
    expect(countOrdersNeedingAction).toHaveBeenCalledWith('s1');
  });

  it('shows no count when nothing is waiting', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(0);
    expect(labels(await openMenu(await renderWide()))).not.toContain('0');
  });

  // One count on the wire, not one per row: a shop with no page and no module
  // has no Orders row to badge, so it is never asked at all.
  it('does not ask for the count when the shop never had a storefront', async () => {
    signIn({ hasModule: (m) => m !== 'storefront' });
    await renderWide();
    expect(countOrdersNeedingAction).not.toHaveBeenCalled();
  });
});

// The dot on the ☰ button points at ONE thing: the Orders row inside the menu.
// A cashier cannot open that row -- `/orders` is `settings.access` in
// permissions.ts and (admin)/_layout.tsx redirects on it -- so a count on their
// button is a notification about a screen they will be bounced off. The lapsed
// path was already gated this way (use-storefront-nav.ts); this is the paying
// shop's half of the same rule.
describe('AdminSidebar orders badge and who can reach Orders', () => {
  async function renderPhone() {
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(true)); });
    return tree!;
  }

  // The POSITIVE half, and it has to come first: everything below asserts an
  // absence, and an absence is satisfied by a nav that never rendered. This is
  // the same shop, the same count, the same closed menu -- with the one
  // permission put back.
  it('shows the count to someone who CAN open Orders, at a shop with the module', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(3);
    const tree = await renderPhone();
    expect(labels(tree)).toContain('3');
    expect(countOrdersNeedingAction).toHaveBeenCalledWith('s1');
  });

  it('shows no count to a cashier at a paying shop, and does not count for them', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(3);
    signIn({ can: (p) => p !== 'settings.access' });
    const tree = await renderPhone();
    // The nav is genuinely on screen -- the ☰ button and the bottom bar are
    // both up -- so this is a missing dot, not a missing menu.
    expect(labels(tree)).toContain('☰');
    expect(labels(tree)).toContain('bottom nav');
    expect(labels(tree)).not.toContain('3');
    expect(countOrdersNeedingAction).not.toHaveBeenCalled();
  });

  it('offers a cashier no Orders row to badge either, once the menu is open', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(3);
    signIn({ can: (p) => p !== 'settings.access' });
    const shown = labels(await openMenu(await renderPhone()));
    // The menu is open -- Settings and Sign out are in it -- so the two
    // absences below are about the row and the dot, not about the sheet.
    expect(shown).toContain('Settings');
    expect(shown).toContain('Sign out');
    expect(shown).not.toContain('Orders');
    expect(shown).not.toContain('3');
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
    (shopHasStorefront as jest.Mock).mockResolvedValue(true);
  }

  async function renderWide() {
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(false)); });
    return tree!;
  }

  it('shows Storefront and Orders rather than hiding them', async () => {
    lapsedWithAPage();
    const shown = labels(await openMenu(await renderWide()));
    expect(shown).toContain('Storefront');
    expect(shown).toContain('Orders');
  });

  // Property 1: the lock treatment, on both surfaces it now has to hold on.
  //
  // The two are checked separately BECAUSE they are different surfaces: the
  // rail paints on white and the ☰ sheet on white too, but through different
  // styles (`navTextLocked` vs `menuItemTextLocked`), and the rows moved from
  // the first to the second. The old form of this test read the expected
  // colour off a locked paid tab in the SAME rail; that comparison no longer
  // has a subject, since no storefront row is in the rail. So:
  //   - the rail's own lock treatment is still pinned, on a genuinely locked
  //     paid tab, so it cannot quietly disappear;
  //   - and in the menu, both rows are painted the same colour as each other
  //     and NOT the colour of an unlocked row in the same sheet.
  it('greys both rows in the ☰, and still greys a locked paid tab in the rail', async () => {
    signIn({ hasModule: (m) => m !== 'inventory' });
    const rail = await renderWide();
    // The rail still greys what it locks, and a row it does not lock is not
    // painted that grey -- or this would hold for a rail with no treatment.
    expect(colourOf(rail, 'Inventory')).not.toBe(colourOf(rail, 'Accounting'));

    resetStorefrontPresence();
    lapsedWithAPage();
    const menu = await openMenu(await renderWide());
    const locked = colourOf(menu, 'Storefront');
    expect(colourOf(menu, 'Orders')).toBe(locked);
    // Settings is an unlocked row in the same sheet, so this is the greying
    // and not just "the sheet paints text".
    expect(colourOf(menu, 'Settings')).not.toBe(locked);
  });

  it('marks both rows with the 🔒 and nothing else', async () => {
    lapsedWithAPage();
    const shown = labels(await openMenu(await renderWide()));
    expect(shown.filter((l) => l === '🔒')).toHaveLength(2);
  });

  // Property 2: the half of the original reasoning that still stands.
  it('still shows nothing to a shop that never had a page', async () => {
    signIn({ hasModule: (m) => m !== 'storefront' });
    (shopHasStorefront as jest.Mock).mockResolvedValue(false);
    const shown = labels(await openMenu(await renderWide()));
    expect(shown).not.toContain('Storefront');
    expect(shown).not.toContain('Orders');
    expect(shown).not.toContain('🔒');
    // Not an empty screen -- the menu is open and the rail is up, so this is
    // an absence of two rows and not an absence of a nav.
    expect(shown).toContain('Settings');
    expect(shown).toContain('Inventory');
  });

  // The nav must not offer a door the route guard would bounce. Both routes
  // are `settings.access` in permissions.ts, lapsed or not.
  it('shows nothing to someone who cannot open Settings, lapsed or not', async () => {
    lapsedWithAPage();
    signIn({ can: (p) => p !== 'settings.access', hasModule: (m) => m !== 'storefront' });
    const shown = labels(await openMenu(await renderWide()));
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
    await renderWide();
    expect(shopHasStorefront).not.toHaveBeenCalled();
  });

  // #102 at 1280, restated for the lapsed shop. The ☰ is the only surface that
  // carries these rows now, so a wide screen has to show each exactly once --
  // there, and in no rail. Counted rather than asserted absent: they SHOULD be
  // on that screen, exactly once.
  it('still shows each row once per screen at wide width', async () => {
    lapsedWithAPage();
    const tree = await renderWide();
    // The rail rendered and does not carry them, so the counts below can only
    // come from the menu.
    expect(labels(tree)).toContain('Powered by Ka Iibi');
    expect(labels(tree).filter((l) => l === 'Storefront')).toHaveLength(0);
    expect(labels(tree).filter((l) => l === 'Orders')).toHaveLength(0);

    await openMenu(tree);
    const shown = labels(tree);
    expect(shown.filter((l) => l === 'Storefront')).toHaveLength(1);
    expect(shown.filter((l) => l === 'Orders')).toHaveLength(1);
    expect(shown.filter((l) => l === '🔒')).toHaveLength(2);
    expect(shown).toContain('Settings');
  });

  // And the phone, where the bottom bar does not carry them either -- still
  // once each, and still locked.
  it('still shows each row once per screen at narrow width', async () => {
    lapsedWithAPage();
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(true)); });
    // Closed menu: the bottom nav is up and neither row is anywhere yet.
    expect(labels(tree!)).toContain('bottom nav');
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

  // A locked row that also has orders waiting has to carry both marks. This
  // followed the row from the rail into the ☰ when the row moved: the sheet
  // has the same shape of hazard, `menuBadgeSlot` claiming the far edge and
  // the lock trailing it.
  it('carries the count and the lock on the same Orders row', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(3);
    lapsedWithAPage();
    const tree = await openMenu(await renderWide());
    const shown = labels(tree);
    expect(shown).toContain('3');
    expect(shown.filter((l) => l === '🔒')).toHaveLength(2);

    // Both marks present is not enough: two siblings each claiming
    // `marginLeft: 'auto'` is safe only while no row is ever locked AND
    // badged. Two auto margins in one row means the second one gets no space
    // pushed to it, so it lands wherever the first left it. Exactly one thing
    // in the row may claim the far edge.
    // Walked up by `onPress`: a menu row is a plain Pressable, not a `Link
    // asChild`, so its handler does survive the expo-router stub at the top of
    // this file.
    const label = tree.root.findAllByType(Text).find((t) => t.props.children === 'Orders')!;
    let row = label as unknown as { props: Record<string, unknown>; parent: unknown };
    while (row && typeof row.props?.onPress !== 'function') row = row.parent as typeof row;
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
    (shopHasStorefront as jest.Mock).mockReturnValue(new Promise(() => {}));
    const shown = labels(await openMenu(await renderWide()));
    expect(shown).not.toContain('Storefront');
    expect(shown).not.toContain('Orders');
    expect(shown).not.toContain('🔒');
    // The menu is open and the rail is up, so this is not an empty screen.
    expect(shown).toContain('Settings');
    expect(shown).toContain('Inventory');
  });

  // The entitlement lookup failing is NOT the same as a lapse. `resolved:
  // false` is the fail-closed default (entitlements.ts), and telling a
  // possibly-paid-up shop its storefront is locked would be a false
  // accusation dressed up as an upsell -- the same call _layout.tsx makes.
  it('does not lock the rows when the plan could not be read at all', async () => {
    signIn({ hasModule: (m) => m !== 'storefront', entitlements: { resolved: false } });
    (shopHasStorefront as jest.Mock).mockResolvedValue(true);
    const shown = labels(await openMenu(await renderWide()));
    expect(shown).not.toContain('Storefront');
    expect(shown).not.toContain('🔒');
    expect(shown).toContain('Settings');
    expect(shopHasStorefront).not.toHaveBeenCalled();
  });

  // And the same in the direction a background auth reload takes it: the
  // answer was known, then the next entitlement fetch failed. A remembered
  // answer must not outlive the plan it was read against.
  it('takes the lock back off if the plan stops resolving', async () => {
    lapsedWithAPage();
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(false)); });
    // The menu stays open across the update below -- it is the same component
    // instance, so `menuOpen` survives.
    await openMenu(tree!);
    expect(labels(tree!)).toContain('Storefront');

    signIn({ hasModule: (m) => m !== 'storefront', entitlements: { resolved: false } });
    await act(async () => { tree!.update(shell(false)); });
    expect(labels(tree!)).not.toContain('Storefront');
    expect(labels(tree!)).not.toContain('🔒');
    // Still the open menu, so the row went and the sheet did not.
    expect(labels(tree!)).toContain('Settings');
  });

  // A shop in the grace month keeps its whole plan, so nothing about it looks
  // different -- the greying starts only once grace has run out.
  it('leaves a shop that still has the module completely alone', async () => {
    (shopHasStorefront as jest.Mock).mockResolvedValue(true);
    const menu = await openMenu(await renderWide());
    const shown = labels(menu);
    expect(shown).toContain('Storefront');
    expect(shown).not.toContain('🔒');
    // Painted like Settings, an ordinary unlocked row in the same sheet.
    expect(colourOf(menu, 'Storefront')).toBe(colourOf(menu, 'Settings'));
    // And no query is made for a shop whose module already answers the
    // question -- the nav renders on every screen.
    expect(shopHasStorefront).not.toHaveBeenCalled();
  });

  // An answer is about one shop. Someone who moves to a second shop must not
  // be shown the first shop's lapse for the render it takes to find out --
  // that is a locked row on a shop that may well be paying.
  it('does not answer for one shop with another shop’s page', async () => {
    lapsedWithAPage();
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(false)); });
    await openMenu(tree!);
    expect(labels(tree!)).toContain('Storefront');

    const signedIn = (useAuth as jest.Mock)();
    (useAuth as jest.Mock).mockReturnValue({ ...signedIn, shop: { id: 's2', name: 'Xamdi Electronics', logoUrl: null, categories: [] } });
    // Left in flight, so the only thing that could put a row on screen here is
    // the previous shop's answer.
    (shopHasStorefront as jest.Mock).mockReturnValue(new Promise(() => {}));
    await act(async () => { tree!.update(shell(false)); });
    expect(labels(tree!)).not.toContain('Storefront');
    expect(labels(tree!)).not.toContain('🔒');
  });

  // One request per shop for the whole session, however many navs ask. The ☰
  // menu and the orders badge are two callers in one tree.
  it('asks the database once however many places need the answer', async () => {
    lapsedWithAPage();
    await renderWide();
    await renderWide();
    expect(shopHasStorefront).toHaveBeenCalledTimes(1);
  });
});

// The same two defects that were found on the phone shell by driving a real
// iPhone. They belong here too because this file is not web-only: `admin-tabs
// .tsx` hands every TABLET straight to `<AdminSidebar>` (its `isTabletDevice()`
// branch), so on an iPad these are the same Yoga layout and the same iOS
// accessibility tree as the ones that broke -- from a byte-identical copy of
// the same style block and the same backdrop.
//
// On the WEB half the exposure is smaller: a browser sizes an absolutely
// positioned box against the padding box rather than the content box, so the
// count had more room and was unlikely to wrap; and the DOM has no way to
// collapse a subtree into one node, so the rows were always separate elements
// there. Neither of those saves the tablet, and neither is a reason to keep the
// construct that broke.

// The nearest ancestor that actually handles a press -- matching `Pressable` by
// TYPE does not work, for the reason `openMenu` above already gives.
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

// Found through the BUTTON rather than by its string, because the Orders row
// inside the sheet renders the same "9+".
function headerDot(tree: ReactTestRenderer) {
  const text = pressableAbove(glyph(tree, '☰'))
    .findAllByType(Text)
    .find((t) => t.props.children !== '☰');
  if (!text) return null;
  return { text, box: text.parent as ReactTestInstance };
}

// Labelled elements, read off the host `View` each `Pressable` renders -- a
// labelled `Pressable` appears twice in this tree, once as the composite.
function a11yLabels(tree: ReactTestRenderer) {
  return tree.root
    .findAll((n) => n.type === View && typeof n.props.accessibilityLabel === 'string')
    .map((n) => n.props.accessibilityLabel as string);
}

describe('AdminSidebar ☰ badge and sheet accessibility', () => {
  async function renderWide() {
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(shell(false)); });
    return tree!;
  }

  // The shop whose plan has lapsed but whose page is still on file: no
  // `storefront` module, and a `storefronts` row that outlived the lapse.
  // `shopHasStorefront` answering true IS that row -- the nav asks the
  // question as a head count now, not by reading the editor's payload back.
  function lapsedWithAPage() {
    signIn({ hasModule: (m) => m !== 'storefront' });
    (shopHasStorefront as jest.Mock).mockResolvedValue(true);
  }

  it('caps the ☰ count at 9+ and sizes the dot from its own style', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(12);
    const dot = headerDot(await renderWide());
    expect(dot?.text.props.children).toBe('9+');
    const box = StyleSheet.flatten(dot!.box.props.style) as { width?: number; height?: number };
    expect(typeof box.width).toBe('number');
    expect(box.width).toBeGreaterThanOrEqual(14);
    expect(typeof box.height).toBe('number');
    expect(dot!.text.props.numberOfLines).toBe(1);
  });

  it('keeps the 9+ badge for a lapsed shop whose customers are still waiting', async () => {
    lapsedWithAPage();
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(12);
    const tree = await renderWide();
    expect(headerDot(tree)?.text.props.children).toBe('9+');
    // And the row behind it is still there, greyed and locked rather than gone.
    const shown = labels(await openMenu(tree));
    expect(shown).toContain('Orders');
    expect(shown).toContain('🔒');
  });

  it('does not swallow its rows into the backdrop', async () => {
    const tree = await openMenu(await renderWide());
    // The row, then the backdrop that wraps every row.
    expect(pressableAbove(glyph(tree, '🌐'), 1).props.accessible).toBe(false);
  });

  it('gives every row its own label instead of letting the emoji name it', async () => {
    const tree = await openMenu(await renderWide());
    const rows = a11yLabels(tree);
    expect(rows).toEqual(expect.arrayContaining(['Storefront', 'Orders', 'Settings', 'Sign out']));
    for (const row of rows) expect(row).toMatch(/^[A-Z]/);
  });

  it('says the waiting count out loud on the ☰ button and on the Orders row', async () => {
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(12);
    const tree = await renderWide();
    expect(pressableAbove(glyph(tree, '☰')).props.accessibilityLabel).toBe('Menu, 12 orders waiting');
    await openMenu(tree);
    expect(a11yLabels(tree)).toContain('Orders, 12 waiting');
  });

  it('says just Menu when nothing is waiting', async () => {
    const tree = await renderWide();
    expect(pressableAbove(glyph(tree, '☰')).props.accessibilityLabel).toBe('Menu');
  });

  it('conveys the lock on a lapsed shop rather than drawing it only', async () => {
    lapsedWithAPage();
    (countOrdersNeedingAction as jest.Mock).mockResolvedValue(12);
    const rows = a11yLabels(await openMenu(await renderWide()));
    expect(rows).toContain('Storefront, locked');
    expect(rows).toContain('Orders, 12 waiting, locked');
  });

  it('can still be dismissed by a screen reader', async () => {
    const tree = await openMenu(await renderWide());
    const sheet = tree.root.find((n) => typeof n.props.onAccessibilityEscape === 'function');
    await act(async () => { (sheet.props.onAccessibilityEscape as () => void)(); });
    expect(labels(tree)).not.toContain('Storefront');
    expect(labels(tree)).toContain('☰');
  });
});
