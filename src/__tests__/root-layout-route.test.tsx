import { act, create } from 'react-test-renderer';

// Lives here rather than beside _layout.tsx ON PURPOSE -- see
// storefront-route.test.tsx's note: expo-router builds its route table from
// `require.context(src/app)`, and nothing on that scan skips `.test.tsx`. A
// test file under src/app would become a real route shipped in the bundle.

// THE LOAD-BEARING CASE. A customer's first paint of a shop must never be
// kaiibi's own marketing page. A post-mount `useEffect` calling
// `router.replace` never rerenders THIS tree at all -- `router.replace` is
// mocked below as a bare spy, same as it would be a real navigation the test
// renderer can't follow -- so it would leave the Stack (the marketing route)
// sitting in the tree even after every effect has flushed. Only resolving
// the redirect during the render pass itself, so the very first tree already
// contains `<Redirect>` instead of `<Stack>`, makes this pass.
import type { ReactNode } from 'react';

// jest.mock() factories may not close over out-of-scope variables (they run
// hoisted, above the imports below) -- hence `require` here rather than the
// `createElement` import used everywhere else in this file.
jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createElement } = require('react');
  function Stack({ children }: { children?: ReactNode }) {
    return createElement('Stack', null, children);
  }
  Stack.Screen = function StackScreen({ name }: { name: string }) {
    return createElement('StackScreen', { name });
  };
  function Redirect({ href }: { href: string }) {
    return createElement('Redirect', { href });
  }
  function ThemeProvider({ children }: { children?: ReactNode }) {
    return children;
  }
  return {
    DarkTheme: {},
    DefaultTheme: {},
    ThemeProvider,
    router: { replace: jest.fn() },
    Stack,
    Redirect,
  };
});

jest.mock('expo-splash-screen', () => ({ preventAutoHideAsync: jest.fn() }));
jest.mock('@/components/animated-icon', () => ({ AnimatedSplashOverlay: () => null }));
jest.mock('@/hooks/use-auth', () => ({
  AuthProvider: function AuthProvider({ children }: { children?: ReactNode }) {
    return children;
  },
}));
jest.mock('@/hooks/use-locale', () => ({
  LocaleProvider: function LocaleProvider({ children }: { children?: ReactNode }) {
    return children;
  },
}));
jest.mock('@/hooks/use-orientation', () => ({ useUnlockedOrientation: () => {} }));
jest.mock('@/components/till-keypad', () => ({ TillKeypad: () => null }));

import { Redirect, router, Stack } from 'expo-router';
import { Platform } from 'react-native';
import RootLayout from '@/app/_layout';

function setLocation(hostname: string, pathname: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, hostname, pathname },
  });
}

describe('RootLayout: pre-render storefront redirect', () => {
  const originalLocation = window.location;
  const originalOS = Platform.OS;

  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    jest.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
  });

  it('resolves a shop hostname to a Redirect, not a post-mount router.replace()', () => {
    setLocation('xamdi.kaiibi.com', '/');

    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<RootLayout />);
    });

    const redirects = tree!.root.findAllByType(Redirect);
    expect(redirects).toHaveLength(1);
    expect(redirects[0].props.href).toBe('/s/xamdi');
    expect(tree!.root.findAllByType(Stack)).toHaveLength(0);
    // Proves the old post-mount `router.replace` path is gone, not merely
    // that a second mechanism was added alongside it.
    expect(router.replace).not.toHaveBeenCalled();

    act(() => {
      tree.unmount();
    });
  });

  it('still loads the normal app for a host slugFromHostname rejects, e.g. localhost', () => {
    setLocation('localhost', '/');

    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<RootLayout />);
    });

    expect(tree!.root.findAllByType(Redirect)).toHaveLength(0);
    expect(tree!.root.findAllByType(Stack)).toHaveLength(1);
    expect(router.replace).not.toHaveBeenCalled();

    act(() => {
      tree.unmount();
    });
  });
});
