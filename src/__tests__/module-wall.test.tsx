import fs from 'fs';
import path from 'path';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Below the mocks in intent, above them in source: babel-plugin-jest-hoist
// lifts every `jest.mock` above the imports regardless.
import AdminLayout from '@/app/(admin)/_layout';
import { AdminSidebar } from '@/components/admin-sidebar';
import { withModuleWall } from '@/components/module-wall';
import { useAuth } from '@/hooks/use-auth';
import { resetStorefrontPresence } from '@/hooks/use-storefront-nav';
import { moduleForPath } from '@/lib/entitlements';
import { ALL_PERMISSIONS, type Permission } from '@/lib/permissions';

// What the router does on a real in-app transition is change the pathname
// under a layout that is already mounted. `mockPathname` is that change, and
// `mockStackMounts` is what this whole file exists to watch: how many times
// the `(admin)` navigator has been BUILT. See the first test.
const mockPathname = { current: '/pos' };
const mockStackMounts = { count: 0 };

// `React.createElement` rather than JSX inside the factory: jest hoists this
// above the file's imports, so the JSX runtime the transform would reach for
// isn't bound yet when it runs.
jest.mock('expo-router', () => {
  const React = require('react');
  const { Text: RNText } = require('react-native');
  // Stands in for the `(admin)` Stack. It only has to be identifiable and to
  // count its own mounts -- what matters is whether it is in the tree at all.
  const Stack = () => {
    React.useEffect(() => {
      mockStackMounts.count += 1;
    }, []);
    return React.createElement(RNText, { testID: 'admin-navigator' }, 'admin navigator');
  };
  Stack.displayName = 'Stack';
  const StackScreen = () => null;
  StackScreen.displayName = 'Stack.Screen';
  Stack.Screen = StackScreen;
  return {
    Stack,
    Redirect: ({ href }: { href: string }) => React.createElement(RNText, null, `redirect:${href}`),
    Link: ({ children }: { children: unknown }) => children,
    usePathname: () => mockPathname.current,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => false }),
    useFocusEffect: (cb: () => void | (() => void)) => cb(),
  };
});

// `signOut` reaches lib/auth, which constructs a real Supabase client at
// import time and throws without the app's env vars.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
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
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// A lapsed shop: the owner still holds every permission, the plan has fallen
// back to the free tier's two modules. Both halves matter -- the defect this
// file pins only shows up when the PERMISSION passes and the MODULE does not.
const LAPSED_MODULES = ['pos', 'inventory'];

function authValue({
  permissions = ALL_PERMISSIONS,
  modules = LAPSED_MODULES,
}: { permissions?: readonly Permission[]; modules?: string[] } = {}) {
  return {
    shop: { id: 'shop-1', name: 'Xamdi Electronics' },
    profile: { id: 'u1', role: 'admin' },
    session: { user: { id: 'u1' } },
    loading: false,
    permissions,
    can: (p: Permission) => permissions.includes(p),
    canAny: (ps: Permission[]) => ps.some((p) => permissions.includes(p)),
    myMembership: { id: 'm1', active: true },
    hasModule: (m: string) => modules.includes(m),
    entitlements: { resolved: true, modules },
  };
}

// `create()` on its own leaves the renderer half-committed under React 19 --
// every mount in this file goes through act, the way admin-sidebar.test.tsx
// does.
function render(element: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree;
}

// Every rendered string, one entry per <Text>. Interpolated copy arrives as an
// array of children ("Online storefront" + " isn't on your plan"), so the parts
// are joined rather than dropped.
function labels(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap((node) => {
    const children = node.props.children;
    if (typeof children === 'string') return [children];
    if (Array.isArray(children) && children.every((c) => typeof c === 'string')) return [children.join('')];
    return [];
  });
}

beforeEach(() => {
  mockPathname.current = '/pos';
  mockStackMounts.count = 0;
  resetStorefrontPresence();
  (useAuth as jest.Mock).mockReturnValue(authValue());
});

describe('the (admin) navigator on a locked route', () => {
  // THE defect. Tapping a greyed 🔒 row never landed on the upgrade wall: the
  // guard returned the wall INSTEAD of the `(admin)` Stack, and unmounting a
  // navigator mid-transition tears its route out of the navigation state. The
  // pathname collapsed to `/`, the Stack was rebuilt at its initial route, and
  // `(tabs)/me` -- a bare `<Redirect href="/people" />` -- bounced the shop to
  // Customers. Measured in the browser as `start:/pos -> replace->/people x4`,
  // with `/storefront` never once committed to history.
  //
  // The whole Jest suite was green through all of it, because no test had ever
  // asked the layout what it renders on a route the shop's plan doesn't cover.
  // This is that question.
  it('stays mounted when the shop cannot open the route', () => {
    const tree = render(<AdminLayout />);
    expect(tree.root.findAllByProps({ testID: 'admin-navigator' }).length).toBeGreaterThan(0);
    expect(mockStackMounts.count).toBe(1);

    // The in-app transition itself: same mounted layout, new pathname.
    act(() => {
      mockPathname.current = '/storefront';
      tree.update(<AdminLayout />);
    });

    expect(tree.root.findAllByProps({ testID: 'admin-navigator' }).length).toBeGreaterThan(0);
    // Not merely present -- the SAME one. A navigator that unmounts and comes
    // back has already lost the route it was asked for.
    expect(mockStackMounts.count).toBe(1);
  });

  it('still refuses a route the ROLE does not grant, without offering an upgrade', () => {
    // Deliberate ordering, kept: someone whose role doesn't grant a screen is
    // told that, not sold an upgrade for something they still couldn't open.
    (useAuth as jest.Mock).mockReturnValue(
      authValue({ permissions: ['pos.access'], modules: LAPSED_MODULES })
    );
    mockPathname.current = '/storefront';
    const tree = render(<AdminLayout />);
    expect(labels(tree)).toContain('redirect:/pos');
    expect(labels(tree).join(' ')).not.toContain('plan');
  });
});

describe('withModuleWall', () => {
  const Screen = () => <Text>the real screen</Text>;
  const Walled = withModuleWall('storefront', Screen);

  it('shows the upgrade wall in place of the screen when the plan does not cover it', () => {
    const tree = render(<Walled />);
    expect(labels(tree).join(' ')).toContain("isn't on your plan");
    expect(labels(tree)).not.toContain('the real screen');
  });

  it('gets out of the way when the plan does cover it', () => {
    (useAuth as jest.Mock).mockReturnValue(authValue({ modules: ['pos', 'inventory', 'storefront'] }));
    const tree = render(<Walled />);
    expect(labels(tree)).toContain('the real screen');
  });

  it('leaves the shop its navigation', () => {
    // The other half of the same decision. A lapsed shop falls back to `free`,
    // which still carries POS and Inventory -- screens it can use and must be
    // able to reach. The wall replacing the whole shell left it with no rail,
    // no ☰ and no tab bar on the screen it lands on first.
    const tree = render(
      <AdminSidebar bottomNav={null}>
        <Walled />
      </AdminSidebar>
    );
    const seen = labels(tree);
    expect(seen.join(' ')).toContain("isn't on your plan");
    expect(seen).toEqual(expect.arrayContaining(['Dashboard', 'POS', 'Inventory', 'People', 'Accounting']));
  });
});

// The guarantee the old single choke point used to give for free. The wall now
// renders inside each screen's shell rather than in place of the navigator, so
// a new module-gated route that forgets it would simply be free.
//
// Kept, but it is no longer the guard -- it is a cheap first line that reads
// source text and can be satisfied by a comment. The real one is
// src/__tests__/module-gate.test.tsx, which imports each route and interrogates
// the component actually default-exported: what `moduleWallOf()` says it is
// gated on, and whether it renders the wall for a shop with no modules. That
// one is keyed off `ROUTE_MODULES` rather than off the files on disk, so an
// entry added to the map with no walled route fails there and not here.
describe('every module-gated route', () => {
  const adminDir = path.join(__dirname, '..', 'app', '(admin)');

  function routeFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(full);
      if (!entry.name.endsWith('.tsx') || entry.name.startsWith('_layout')) return [];
      return [full];
    });
  }

  function routePath(file: string): string {
    return `/${path
      .relative(adminDir, file)
      .replace(/\.tsx$/, '')
      .split(path.sep)
      .filter((segment) => !segment.startsWith('('))
      .join('/')}`;
  }

  it('renders the wall itself', () => {
    const gated = routeFiles(adminDir)
      .map((file) => ({ file, module: moduleForPath(routePath(file)) }))
      .filter((entry) => entry.module !== null);
    expect(gated.length).toBeGreaterThan(0);
    for (const { file, module } of gated) {
      const source = fs.readFileSync(file, 'utf8');
      expect([routePath(file), source.includes(`withModuleWall('${module}'`)]).toEqual([routePath(file), true]);
    }
  });
});
