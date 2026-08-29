import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

// Task 7: publishing a storefront is retroactively consent to take orders,
// and a shop that never thinks to open Settings -> Orders would otherwise
// never find out one arrived. This is property 1 -- seeing that without
// opening the Orders screen -- for the surface the brief names directly:
// the nav item itself, at both widths (SettingsSidebar for tablet/desktop,
// SettingsNavList for the phone sheet).

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
// useRefreshOnFocus reaches for expo-router's navigation object, which does
// not exist outside a NavigationContainer -- same stub
// invoices-payable-caveat.test.tsx uses for the same reason.
jest.mock('expo-router', () => ({ useFocusEffect: () => {} }));

// N3: this badge used to read `listOrders(shopId).length` after a
// client-side filter -- every order the shop has ever placed, filtered here.
// countOrdersNeedingAction (storefront-admin.ts) does that filtering
// server-side (`.in('status', ORDERS_NEEDING_ACTION)`) and returns the
// integer this badge actually needs, so the mock below returns a count
// directly rather than a list of statuses to filter.
let mockCount = 0;
const mockCountOrdersNeedingAction = jest.fn((_shopId: string) => Promise.resolve(mockCount));
// The badge now also asks whether a shop WITHOUT the module still has a
// `storefronts` row -- a lapsed shop's orders are still waiting on it
// (use-storefront-nav.ts). Stubbed at "never had one", which is what every
// assertion in this file was written against.
let mockHasStorefrontRow = false;
jest.mock('@/lib/storefront-admin', () => ({
  countOrdersNeedingAction: (shopId: string) => mockCountOrdersNeedingAction(shopId),
  shopHasStorefront: () => Promise.resolve(mockHasStorefrontRow),
}));

let mockHasModule = true;
const mockAuth = {
  shop: { id: 'shop-1', name: 'Xamdi Electronics' },
  locations: [],
  can: () => true,
  hasModule: (module: string) => (module === 'storefront' ? mockHasModule : true),
  entitlements: { resolved: true },
};
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => mockAuth }));

import { SettingsNavList, SettingsSidebar } from '@/components/settings/settings-sidebar';
import { resetStorefrontPresence } from '@/hooks/use-storefront-nav';

// `@testing-library/react-native` is not installed in this repo -- flatten
// the rendered tree to strings instead, the same pattern
// storefront-theme-counter.test.tsx uses.
function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

beforeEach(() => {
  mockCount = 0;
  mockHasModule = true;
  mockHasStorefrontRow = false;
  resetStorefrontPresence();
  mockCountOrdersNeedingAction.mockClear();
});

async function renderSidebar() {
  let tree: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<SettingsSidebar active="profile" onSelect={() => {}} />);
  });
  return tree!;
}

async function renderNavList() {
  let tree: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<SettingsNavList onSelect={() => {}} />);
  });
  return tree!;
}

describe('SettingsSidebar — orders badge', () => {
  it('badges the Orders nav item with the count of orders needing action', async () => {
    mockCount = 2;
    const tree = await renderSidebar();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('Orders');
    expect(texts).toContain('2');
  });

  it('shows no badge when nothing needs action', async () => {
    mockCount = 0;
    const tree = await renderSidebar();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).not.toContain('1');
    expect(texts).not.toContain('0');
  });

  // Both halves matter, and the name has to say so: "no module" alone is NOT
  // enough to stay silent any more. A shop that lost the module but still has
  // a `storefronts` row is a lapse, and the test below it is the one that
  // pins what happens then.
  it('never fetches the count for a shop with neither the storefront module nor a storefronts row -- property 4', async () => {
    mockHasModule = false;
    mockHasStorefrontRow = false;
    await renderSidebar();
    expect(mockCountOrdersNeedingAction).not.toHaveBeenCalled();
  });

  // The lapse. The module is gone, the page and its orders are not: those
  // customers are still waiting, and a count that drops to zero the moment
  // somebody stops paying hides them (use-orders-needing-action-badge.ts).
  it('still fetches the count for a shop that lost the module but kept its storefront row', async () => {
    mockHasModule = false;
    mockHasStorefrontRow = true;
    mockCount = 2;
    await renderSidebar();
    expect(mockCountOrdersNeedingAction).toHaveBeenCalledWith('shop-1');
  });
});

describe('SettingsNavList — orders badge', () => {
  it('badges the Orders row on the phone sheet too', async () => {
    mockCount = 1;
    const tree = await renderNavList();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('Orders');
    expect(texts).toContain('1');
  });
});
