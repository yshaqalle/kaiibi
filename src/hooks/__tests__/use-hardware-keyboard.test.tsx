import { Platform, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useHardwareKeyboard } from '@/hooks/use-hardware-keyboard';

const listeners: ((event: { attached: boolean }) => void)[] = [];
// Prefixed with `mock` (and not `const`, since both are reassigned per test):
// babel-plugin-jest-hoist forbids a hoisted jest.mock() factory from closing
// over an out-of-scope `let`/`var` unless the name starts with `mock`.
let mockAttached = false;
let mockModulePresent = true;
let mockReads = 0;

jest.mock('../../../modules/hardware-keyboard', () => ({
  getHardwareKeyboardModule: () =>
    mockModulePresent
      ? {
          isAttached: () => { mockReads += 1; return mockAttached; },
          addListener: (_name: string, fn: (event: { attached: boolean }) => void) => {
            listeners.push(fn);
            return { remove: () => { listeners.length = 0; } };
          },
        }
      : null,
}));

function Probe({ onValue }: { onValue: (v: boolean | null) => void }) {
  onValue(useHardwareKeyboard());
  return <Text>probe</Text>;
}

function render() {
  const seen: (boolean | null)[] = [];
  act(() => { create(<Probe onValue={(v) => seen.push(v)} />); });
  return seen;
}

describe('useHardwareKeyboard', () => {
  beforeEach(() => { listeners.length = 0; mockAttached = false; mockModulePresent = true; mockReads = 0; });

  it('reports what the device says on mount', () => {
    mockAttached = true;
    expect(render().at(-1)).toBe(true);
  });

  it('follows a keyboard being connected while a screen is open', () => {
    const seen = render();
    expect(seen.at(-1)).toBe(false);
    act(() => { listeners.forEach((fn) => fn({ attached: true })); });
    expect(seen.at(-1)).toBe(true);
  });

  // A JS bundle running on a binary built before the module existed. This is
  // the case the whole `null` contract exists for, and it must not throw.
  it('answers null when the native module is missing', () => {
    mockModulePresent = false;
    expect(render().at(-1)).toBeNull();
  });

  // Web has no native module and no hardware-keyboard concept the app trusts;
  // the answer is null — unknown — and the module must never be touched.
  it('answers null on web without touching the module', () => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    try {
      expect(render().at(-1)).toBeNull();
      expect(mockReads).toBe(0);
      expect(listeners).toHaveLength(0);
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  });

  it('stops listening when the screen unmounts', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(<Probe onValue={() => {}} />); });
    expect(listeners).toHaveLength(1);
    act(() => { tree!.unmount(); });
    expect(listeners).toHaveLength(0);
  });
});
