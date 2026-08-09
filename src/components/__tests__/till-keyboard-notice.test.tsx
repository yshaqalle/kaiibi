import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { TillKeyboardNotice } from '@/components/till-keyboard-notice';

// `mock`-prefixed on purpose, and not cosmetic: `jest.mock()` is hoisted above
// these declarations, and `babel-plugin-jest-hoist` REFUSES to compile a
// factory that closes over an out-of-scope `let` unless its name begins with
// `mock`. Rename these and the suite fails to transform at all.
let mockAttached: boolean | null = true;
let mockSettingOn = false;
let mockPermitted = true;
let mockDismissed = false;

jest.mock('@/hooks/use-hardware-keyboard', () => ({ useHardwareKeyboard: () => mockAttached }));
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    can: () => mockPermitted,
    activeLocation: { id: 'loc-1', name: 'Hargeisa Main' },
  }),
}));
jest.mock('@/hooks/use-scanner-settings', () => ({
  useScannerSettings: () => ({
    camera: false,
    hardware: mockSettingOn,
    resolveCodes: mockSettingOn,
    onScreenKeypad: false,
    hardwareSetting: mockSettingOn,
  }),
}));
jest.mock('@/hooks/use-caveat-dismissal', () => ({
  useCaveatDismissal: () => ({ dismissed: mockDismissed, dismiss: jest.fn() }),
}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

function shown(): boolean {
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(<TillKeyboardNotice />); });
  return tree!.toJSON() !== null;
}

describe('TillKeyboardNotice', () => {
  beforeEach(() => { mockAttached = true; mockSettingOn = false; mockPermitted = true; mockDismissed = false; mockPush.mockClear(); });

  it('offers the toggle when a keyboard is plugged into a store that has not enabled scanning', () => {
    expect(shown()).toBe(true);
  });

  // Each of the four below has to silence it on its own.
  it('says nothing once scanning is already on', () => {
    mockSettingOn = true;
    expect(shown()).toBe(false);
  });

  it('says nothing when no keyboard is attached', () => {
    mockAttached = false;
    expect(shown()).toBe(false);
  });

  // An unknown answer must never produce advice.
  it('says nothing when detection could not answer', () => {
    mockAttached = null;
    expect(shown()).toBe(false);
  });

  // A cashier cannot change a store setting. Telling them to is worse than
  // silence, because they cannot act and cannot make it stop.
  it('says nothing to someone who cannot change the setting', () => {
    mockPermitted = false;
    expect(shown()).toBe(false);
  });

  it('stays gone once dismissed', () => {
    mockDismissed = true;
    expect(shown()).toBe(false);
  });

  // The Caveat contract forbids an action on tone="context", and this notice
  // is about a cable rather than a number — so it must not render a Caveat.
  it('does not wear the Caveat family uniform', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(<TillKeyboardNotice />); });
    const { Caveat } = jest.requireActual('@/components/ui/caveat');
    expect(tree!.root.findAllByType(Caveat)).toHaveLength(0);
  });

  // The button used to drop the reader on the Locations PANEL and leave them
  // to find the right store; the fix lives in one store's editor, so the
  // action deep-links there.
  it('deep-links the action to the active store, not just the panel', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(<TillKeyboardNotice />); });
    const pressables = tree!.root.findAll((node) => typeof node.props?.onPress === 'function', { deep: true });
    const action = pressables.find((p) => p.findAllByType(Text).some((t) => String(t.props.children).includes('Set up scanning')));
    expect(action).toBeDefined();
    act(() => { action!.props.onPress(); });
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/settings', params: { nav: 'locations', location: 'loc-1' } });
  });
});
