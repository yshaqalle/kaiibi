import fs from 'fs';
import path from 'path';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { moduleWallOf } from '@/components/module-wall';
import { useAuth } from '@/hooks/use-auth';
import { MODULES, ROUTE_MODULES, moduleForPath, type Module } from '@/lib/entitlements';

// This file IMPORTS every route under `(admin)` and RENDERS the component each
// one actually default-exports. Both of those are the point.
//
// The gate used to be a single choke point in `(admin)/_layout.tsx`, which
// returned an upgrade wall in place of the `(admin)` Stack. Unmounting a
// navigator mid-transition tears the route out of navigation state, so the
// wall was never reached and a lapsed shop lost its whole shell. The wall
// moved into each screen's own slot (`withModuleWall`), which fixed that and
// cost the structural guarantee the choke point gave for free: nothing stops a
// new module-gated route from simply omitting the wrapper, and a shop that has
// not paid then gets the screen. Reads were never module-gated server-side, so
// it leaks the product rather than the data -- silently, and only until
// someone tries to save.
//
// What replaced the choke point was a SOURCE-TEXT grep (each gated route
// file's text must contain `withModuleWall('<module>'`). That could be
// satisfied by a comment, and could not see the more likely mistake: wrapping
// a screen and then default-exporting the unwrapped one. So this asks the
// exported component itself, twice over -- what it says it is gated on, and
// what it does when the shop has nothing.
//
// A runtime construct was considered instead and rejected; see the note at the
// bottom of this file for why.

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/components/support/support-sheet', () => ({ SupportSheet: () => null }));

// The route files reach for the router at module scope. None of them navigate
// here -- when the wall is up the screen underneath never mounts -- so these
// only have to exist and be inert.
jest.mock('expo-router', () => {
  const noop = () => {};
  const router = {
    push: noop,
    replace: noop,
    back: noop,
    navigate: noop,
    canGoBack: () => false,
    setParams: noop,
    dismissAll: noop,
  };
  const Passthrough = ({ children }: { children?: unknown }) => children ?? null;
  const withScreen = (Component: unknown) =>
    Object.assign(Component as object, { Screen: () => null, Trigger: () => null });
  return {
    router,
    useRouter: () => router,
    usePathname: () => '/',
    useSegments: () => [],
    useLocalSearchParams: () => ({}),
    useGlobalSearchParams: () => ({}),
    useNavigation: () => ({ setOptions: noop, addListener: () => noop }),
    useFocusEffect: noop,
    Link: Object.assign(Passthrough, { Trigger: Passthrough }),
    Redirect: () => null,
    Slot: () => null,
    Stack: withScreen(Passthrough),
    Tabs: withScreen(Passthrough),
    SplashScreen: { hideAsync: noop, preventAutoHideAsync: noop },
  };
});

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Passthrough = ({ children }: { children?: unknown }) => React.createElement(View, null, children);
  return {
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
    SafeAreaView: Passthrough,
    SafeAreaProvider: Passthrough,
    SafeAreaInsetsContext: React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 }, frame: { x: 0, y: 0, width: 390, height: 844 } },
  };
});

const adminDir = path.join(__dirname, '..', 'app', '(admin)');

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(full);
    if (!entry.name.endsWith('.tsx') || entry.name.startsWith('_layout')) return [];
    return [full];
  });
}

// `(admin)/(tabs)/pos.tsx` -> `/pos`. Group segments are routing-invisible, so
// they drop out exactly the way expo-router drops them.
function routePath(file: string): string {
  return `/${path
    .relative(adminDir, file)
    .replace(/\.tsx$/, '')
    .split(path.sep)
    .filter((segment) => !segment.startsWith('('))
    .join('/')}`;
}

// Named by the route it belongs to rather than the file it lives in, because
// that is what a failure needs to say.
const ROUTES = routeFiles(adminDir).map((file) => ({ file, route: routePath(file) }));

function defaultExportOf(file: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require(file) as { default?: unknown }).default;
}

// A shop that has paid for nothing at all. `resolved: true` so the wall shows
// the real "isn't on your plan" copy rather than its lookup-failed variant.
function noModules() {
  return {
    shop: { id: 'shop-1', name: 'Xamdi Electronics' },
    profile: { id: 'u1', role: 'admin' },
    session: { user: { id: 'u1' } },
    loading: false,
    permissions: [],
    can: () => true,
    canAny: () => true,
    myMembership: { id: 'm1', active: true },
    hasModule: () => false,
    entitlements: { resolved: true, modules: [] as string[] },
  };
}

function render(element: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree;
}

function labels(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap((node) => {
    const children = node.props.children;
    if (typeof children === 'string') return [children];
    if (Array.isArray(children) && children.every((c) => typeof c === 'string')) return [children.join('')];
    return [];
  });
}

beforeEach(() => {
  (useAuth as jest.Mock).mockReturnValue(noModules());
});

describe('ROUTE_MODULES is the list of routes that must be walled', () => {
  it('names at least one gated route, so an empty map cannot pass this file vacuously', () => {
    expect(ROUTE_MODULES.length).toBeGreaterThan(0);
    expect(ROUTES.length).toBeGreaterThan(0);
  });

  // Direction one: the map is the source of truth for what MUST be gated. Add
  // a prefix here and forget the wrapper on the route file and this fails,
  // naming the route.
  for (const { prefix, module } of ROUTE_MODULES) {
    describe(`${prefix} (${module})`, () => {
      const matching = ROUTES.filter(
        ({ route }) => route === prefix || route.startsWith(`${prefix}/`)
      );

      it('has a route file', () => {
        // An entry naming a route that does not exist gates nothing, and would
        // otherwise let every assertion below pass over an empty set.
        expect({ prefix, routes: matching.map((m) => m.route) }).toEqual({
          prefix,
          routes: expect.arrayContaining([expect.any(String)]),
        });
      });

      for (const { file, route } of matching) {
        it(`${route} default-exports a component walled on '${module}'`, () => {
          expect({ route, gatedOn: moduleWallOf(defaultExportOf(file)) }).toEqual({ route, gatedOn: module });
        });

        it(`${route} shows the wall instead of the screen when the shop has no modules`, () => {
          const Route = defaultExportOf(file) as React.ComponentType<Record<string, never>>;
          const tree = render(<Route />);
          const seen = labels(tree).join(' ');
          const label = MODULES.find((m) => m.key === module)?.label;
          expect({ route, walled: seen.includes("isn't on your plan"), names: seen.includes(String(label)) }).toEqual(
            { route, walled: true, names: true }
          );
        });
      }
    });
  }
});

// Direction two: nothing wears a wall the map does not know about. A route
// wrapped in a module that is absent from ROUTE_MODULES gets a 🔒 nowhere in
// the navs -- `moduleForPath` drives those -- so the shop is sold a screen it
// is never told it cannot open, and the row does not grey out.
describe('no route is walled on a module ROUTE_MODULES does not name for it', () => {
  for (const { file, route } of ROUTES) {
    it(`${route}`, () => {
      const declared: Module | null = moduleWallOf(defaultExportOf(file));
      expect({ route, declared }).toEqual({ route, declared: moduleForPath(route) });
    });
  }
});

// WHY THIS IS A TEST AND NOT A RUNTIME MECHANISM
//
// A runtime assertion has to answer "the route now on screen is gated, did a
// wall render for it?", which means something must know both the pathname and
// what rendered. Two shapes were considered and both are worse than this:
//
//   - have `withModuleWall` call `usePathname()` and register itself. That
//     puts the router back inside every gated screen -- the coupling the
//     wrapper was written to avoid -- and re-renders all of them on every
//     navigation.
//   - register by MODULE instead, and check from the layout. Tab screens stay
//     mounted, so `/inventory`'s live registration would vouch for an unwalled
//     `/product/new`: the same module, a false pass, on exactly the route most
//     likely to be added next.
//
// Anything checking from the layout also only fires when a developer happens
// to open the route in dev, whereas this runs on every commit; and the one
// shape that could not miss -- deciding in the layout -- is the unmounting
// choke point whose removal caused all of this. So the runtime half is the
// MARK (`MODULE_WALL`, stamped by `withModuleWall` on the component it
// returns) and the render below it, and the enumeration is a test.
