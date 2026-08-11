import { Linking, Platform, Text } from 'react-native';
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

// The mirror case, and the more damaging one. Scanning is ON, a scanner is
// plugged in -- and because that scanner IS a keyboard to the OS, Android
// stops offering the on-screen one. Every field in the app goes untypeable
// while scanning keeps working, and nothing on screen says why.
describe('TillKeyboardNotice, scanning already on', () => {
  function actionLabelled(fragment: string) {
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(<TillKeyboardNotice />); });
    const pressables = tree!.root.findAll((node) => typeof node.props?.onPress === 'function', { deep: true });
    return pressables.find((p) => p.findAllByType(Text).some((t) => String(t.props.children).includes(fragment)));
  }

  beforeEach(() => {
    mockAttached = true;
    mockSettingOn = true;
    mockPermitted = true;
    mockDismissed = false;
    Platform.OS = 'android';
  });
  afterEach(() => { Platform.OS = 'ios'; });

  it('explains why typing stopped on an Android till', () => {
    expect(shown()).toBe(true);
  });

  it('opens the OS keyboard settings, which is the only place the switch lives', () => {
    const sendIntent = jest.spyOn(Linking, 'sendIntent').mockResolvedValue(undefined);
    const action = actionLabelled('keyboard settings');
    expect(action).toBeDefined();
    act(() => { action!.props.onPress(); });
    expect(sendIntent).toHaveBeenCalledWith('android.settings.HARD_KEYBOARD_SETTINGS');
    sendIntent.mockRestore();
  });

  // iOS has no such setting and no API to ask for one, so there is nothing to
  // send anybody to. Advice with no action is what the sibling notice above
  // already refuses to give.
  it('says nothing on iOS, where there is no switch to offer', () => {
    Platform.OS = 'ios';
    expect(shown()).toBe(false);
  });

  it('says nothing when no keyboard is attached', () => {
    mockAttached = false;
    expect(shown()).toBe(false);
  });

  it('says nothing when detection could not answer', () => {
    mockAttached = null;
    expect(shown()).toBe(false);
  });

  // Unlike its sibling this is not a shop setting but the tablet's own, so the
  // person holding the tablet can fix it whatever their role.
  it('tells a cashier too, because a cashier can change this one', () => {
    mockPermitted = false;
    expect(shown()).toBe(true);
  });

  it('stays gone once dismissed', () => {
    mockDismissed = true;
    expect(shown()).toBe(false);
  });

  // Two notices about the same cable, one screen. Whichever fires, the other
  // must not: they give opposite advice.
  it('never appears alongside the set-up-scanning notice', () => {
    expect(actionLabelled('Set up scanning')).toBeUndefined();
  });
});
