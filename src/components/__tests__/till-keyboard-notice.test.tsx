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
    activeLocation: { hardwareScannerEnabled: mockSettingOn },
    can: () => mockPermitted,
  }),
}));
jest.mock('@/hooks/use-caveat-dismissal', () => ({
  useCaveatDismissal: () => ({ dismissed: mockDismissed, dismiss: jest.fn() }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

function shown(): boolean {
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(<TillKeyboardNotice />); });
  return tree!.toJSON() !== null;
}

describe('TillKeyboardNotice', () => {
  beforeEach(() => { mockAttached = true; mockSettingOn = false; mockPermitted = true; mockDismissed = false; });

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
});
