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
jest.mock('@/lib/storefront-admin', () => ({
  countOrdersNeedingAction: (shopId: string) => mockCountOrdersNeedingAction(shopId),
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
  mockCount = 0;
  mockHasModule = true;
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

  it('never fetches the count for a shop without the storefront module -- property 4', async () => {
    mockHasModule = false;
    await renderSidebar();
    expect(mockCountOrdersNeedingAction).not.toHaveBeenCalled();
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
