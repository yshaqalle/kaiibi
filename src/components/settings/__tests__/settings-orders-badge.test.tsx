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

let mockOrderStatuses: string[] = [];
const mockListOrders = jest.fn((_shopId: string) => Promise.resolve(mockOrderStatuses.map((status, i) => ({ id: `o${i}`, status }))));
// A factory, not a bare `jest.mock('@/lib/storefront-admin')` automock --
// automock silently replaces ORDERS_NEEDING_ACTION (a plain array export)
// with an empty one, which is exactly the trap storefront-admin.ts's own
// comment on that constant documents.
jest.mock('@/lib/storefront-admin', () => ({
  listOrders: (shopId: string) => mockListOrders(shopId),
  ORDERS_NEEDING_ACTION: ['pending', 'accepted', 'ready'],
}));

let mockHasModule = true;
const mockAuth = {
  shop: { id: 'shop-1', name: 'Xamdi Electronics' },
  locations: [],
  can: () => true,
  hasModule: (module: string) => (module === 'storefront' ? mockHasModule : true),
};
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => mockAuth }));

import { SettingsNavList, SettingsSidebar } from '@/components/settings/settings-sidebar';

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
  mockOrderStatuses = [];
  mockHasModule = true;
  mockListOrders.mockClear();
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
    mockOrderStatuses = ['pending', 'accepted', 'completed'];
    const tree = await renderSidebar();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('Orders');
    // 'completed' does not count -- property 2, a count of orders needing
    // action, not all orders.
    expect(texts).toContain('2');
  });

  it('shows no badge when nothing needs action', async () => {
    mockOrderStatuses = ['completed', 'cancelled'];
    const tree = await renderSidebar();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).not.toContain('1');
    expect(texts).not.toContain('0');
  });

  it('never fetches orders for a shop without the storefront module -- property 4', async () => {
    mockHasModule = false;
    await renderSidebar();
    expect(mockListOrders).not.toHaveBeenCalled();
  });
});

describe('SettingsNavList — orders badge', () => {
  it('badges the Orders row on the phone sheet too', async () => {
    mockOrderStatuses = ['ready'];
    const tree = await renderNavList();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('Orders');
    expect(texts).toContain('1');
  });
});
