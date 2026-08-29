import { StyleSheet, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The Settings pane was the last surface that still HID the two storefront
// rows from a lapsed shop, where the ☰ now greys them (admin-sidebar.tsx).
//
// It looked like a uniform rule worth keeping -- `promotions` hides the same
// way -- but the two are not the same kind of row. `promotions` opens a PANEL
// that lives inside this screen, and there is no wall behind it to land on.
// `storefront` and `orders` open nothing here at all: handleSelectNav routes
// both straight out to /storefront and /orders (settings.tsx:186,192), the
// same module-gated routes the ☰ points at, each rendering its own upgrade
// wall. So these are the SAME doors, listed twice, and a shop that is shown
// the way back in one nav and has it taken away in the other is being told two
// different things about one plan.

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({ useFocusEffect: () => {} }));

let mockCount = 0;
let mockHasStorefrontRow = false;
const mockCountOrdersNeedingAction = jest.fn((_shopId: string) => Promise.resolve(mockCount));
jest.mock('@/lib/storefront-admin', () => ({
  countOrdersNeedingAction: (shopId: string) => mockCountOrdersNeedingAction(shopId),
  shopHasStorefront: () => Promise.resolve(mockHasStorefrontRow),
}));

let mockModules: Record<string, boolean> = {};
let mockCan: (permission: string) => boolean = () => true;
const mockAuth = {
  shop: { id: 'shop-1', name: 'Xamdi Electronics' },
  locations: [],
  can: (permission: string) => mockCan(permission),
  hasModule: (module: string) => mockModules[module] ?? true,
  entitlements: { resolved: true },
};
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => mockAuth }));

import { SettingsNavList, SettingsSidebar } from '@/components/settings/settings-sidebar';
import { resetStorefrontPresence } from '@/hooks/use-storefront-nav';

function labels(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap((t) => (typeof t.props.children === 'string' ? [t.props.children] : []));
}

// The resolved colour a row's label is painted in. Read rather than compared
// against a literal, the same way admin-sidebar.test.tsx does it: the claim is
// "not the colour an ordinary row gets", not "#717078".
function colourOf(tree: ReactTestRenderer, label: string): string | undefined {
  const node = tree.root.findAllByType(Text).find((t) => t.props.children === label);
  if (!node) throw new Error(`no row labelled ${label} on screen`);
  return (StyleSheet.flatten(node.props.style) as { color?: string } | undefined)?.color;
}

// WCAG relative luminance, and the contrast between two inks. Here to answer
// "can a person SEE that this row is greyed?", which `not.toBe` cannot: the
// sidebar shipped a locked ink of #717078 against an ordinary #6B7280, two
// hex digits and a contrast of 1.01 apart -- a different string, an identical
// row. `not.toBe` passed on it for as long as it was there.
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function separation(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// The floor a difference has to clear to count as one. 1.25 sits well above
// the 1.01 the old sidebar shipped and below the 1.31 it wears now, so it
// fails the invisible greying and passes the visible one.
const VISIBLE = 1.25;

// Locked rows are still doors -- tapping one lands on the upgrade wall -- so
// "greyed" has to mean RECEDING from the pane's ordinary ink, not just
// differing from it. Direction is pinned as well as magnitude: a future
// change that greys a Settings row DARKER than its neighbours would clear the
// magnitude floor while making the locked row the loudest thing in the pane.
function expectGreyedAgainst(locked: string | undefined, ordinary: string | undefined) {
  expect({ locked, ordinary }).toEqual({ locked: expect.any(String), ordinary: expect.any(String) });
  const gap = separation(locked!, ordinary!);
  expect({
    lighterThanOrdinary: luminance(locked!) > luminance(ordinary!),
    visible: gap >= VISIBLE,
    gap: Number(gap.toFixed(2)),
  }).toEqual({ lighterThanOrdinary: true, visible: true, gap: expect.any(Number) });
}

beforeEach(() => {
  mockCount = 0;
  mockHasStorefrontRow = false;
  mockModules = {};
  mockCan = () => true;
  resetStorefrontPresence();
  mockCountOrdersNeedingAction.mockClear();
});

// The lapse: the plan fell back past its grace month, the module is gone, the
// `storefronts` row is not.
function lapsedWithAPage() {
  mockModules = { storefront: false };
  mockHasStorefrontRow = true;
}

async function renderSidebar() {
  let tree: ReactTestRenderer | undefined;
  await act(async () => { tree = create(<SettingsSidebar active="profile" onSelect={() => {}} />); });
  return tree!;
}

async function renderNavList() {
  let tree: ReactTestRenderer | undefined;
  await act(async () => { tree = create(<SettingsNavList onSelect={() => {}} />); });
  return tree!;
}

describe('Settings nav — storefront rows after a lapse', () => {
  it('greys both rows rather than hiding them, in the sidebar', async () => {
    lapsedWithAPage();
    const tree = await renderSidebar();
    const shown = labels(tree);
    expect(shown).toContain('Storefront');
    expect(shown).toContain('Orders');
    expect(shown.filter((l) => l === '🔒')).toHaveLength(2);
    // Receipt is an ordinary row in the same pane, so this is the greying and
    // not just "the pane paints text".
    const locked = colourOf(tree, 'Storefront');
    expect(colourOf(tree, 'Orders')).toBe(locked);
    expect(colourOf(tree, 'Receipt')).not.toBe(locked);
    // ...and the difference is one a lapsed shop can actually see.
    expectGreyedAgainst(locked, colourOf(tree, 'Receipt'));
  });

  it('greys both rows on the phone list too', async () => {
    lapsedWithAPage();
    const tree = await renderNavList();
    const shown = labels(tree);
    expect(shown).toContain('Storefront');
    expect(shown).toContain('Orders');
    expect(shown.filter((l) => l === '🔒')).toHaveLength(2);
    expect(colourOf(tree, 'Storefront')).not.toBe(colourOf(tree, 'Receipt'));
    // This pane's ordinary row is #111111, so `bentoMuted2` is a real greying
    // here and stays. Held to the same visible floor as the sidebar so the two
    // cannot silently diverge on what "locked" is worth.
    expectGreyedAgainst(colourOf(tree, 'Storefront'), colourOf(tree, 'Receipt'));
  });

  // The requirement that outranks everything else here: those customers are
  // still waiting, and the owner still has to pick their goods.
  it('still badges the Orders row for a lapsed shop with waiting orders', async () => {
    lapsedWithAPage();
    mockCount = 2;
    const shown = labels(await renderSidebar());
    expect(shown).toContain('Orders');
    expect(shown).toContain('2');
    expect(mockCountOrdersNeedingAction).toHaveBeenCalledWith('shop-1');
  });

  // The other half of the rule, unchanged: a row for a page that has never
  // existed is an advert, not navigation.
  it('shows neither row to a shop that never had a page', async () => {
    mockModules = { storefront: false };
    mockHasStorefrontRow = false;
    const shown = labels(await renderSidebar());
    expect(shown).not.toContain('Storefront');
    expect(shown).not.toContain('Orders');
    expect(shown).not.toContain('🔒');
    // The pane genuinely rendered, so this is an absence of two rows and not
    // an absence of a nav.
    expect(shown).toContain('Receipt');
    expect(shown).toContain('Profile');
  });

  it('leaves a shop that still has the module completely alone', async () => {
    const tree = await renderSidebar();
    const shown = labels(tree);
    expect(shown).toContain('Storefront');
    expect(shown).toContain('Orders');
    expect(shown).not.toContain('🔒');
    expect(colourOf(tree, 'Storefront')).toBe(colourOf(tree, 'Receipt'));
  });

  // Neither row exists until the answer does -- the same rule the ☰ holds.
  // Showing them open and then locking them, or locked and then unlocking
  // them, are both defects.
  it('shows neither row while the storefront lookup is still in flight', async () => {
    mockModules = { storefront: false };
    const inFlight = jest.requireMock('@/lib/storefront-admin') as { shopHasStorefront: () => Promise<boolean> };
    const original = inFlight.shopHasStorefront;
    inFlight.shopHasStorefront = () => new Promise<boolean>(() => {});
    try {
      const shown = labels(await renderSidebar());
      expect(shown).not.toContain('Storefront');
      expect(shown).not.toContain('Orders');
      expect(shown).toContain('Receipt');
    } finally {
      inFlight.shopHasStorefront = original;
    }
  });
});

// The rule this pane keeps. A module-gated row that opens a panel of its own
// still vanishes, because there is nothing behind it to land on -- the
// storefront rows are an exception only because they are not panels.
describe('Settings nav — module-gated panels still hide', () => {
  it('hides Promotions from a shop without the promotions module', async () => {
    mockModules = { promotions: false };
    const shown = labels(await renderSidebar());
    expect(shown).not.toContain('Promotions');
    expect(shown).not.toContain('🔒');
    // Payments is the row directly below it in the same group, so the group
    // itself rendered.
    expect(shown).toContain('Payments');
  });
});
