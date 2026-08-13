import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { TillKeypadHost } from '@/components/till-keypad-host';
import { markSinkInput, resetSinkInput } from '@/lib/wedge-sink-focus';

// What the keypad actually did, in the order it did it.
let mockTyped: string[] = [];
let mockBlurred = 0;

// One object rather than a fresh one per call, so a test can spy on the answer
// the platform gives.
const mockModule = {
  // Deliberately stuck at `true` by default, which is the iPhone failure this
  // suite has to cover: a focus signal that says yes forever, with no field
  // anyone can see.
  isEditorFocused: () => true,
  insertText: (text: string) => { mockTyped.push(text); },
  deleteBackward: () => { mockTyped.push('⌫'); },
  pressEnter: () => { mockTyped.push('↵'); },
  blurEditor: () => { mockBlurred += 1; },
  addListener: () => ({ remove: () => {} }),
};

jest.mock('../../../modules/hardware-keyboard', () => ({
  supportsTyping: () => true,
  getHardwareKeyboardModule: () => mockModule,
}));

// The dock only exists where the platform is withholding its own keyboard.
jest.mock('@/hooks/use-scanner-settings', () => ({
  useScannerSettings: () => ({
    camera: false,
    hardware: true,
    resolveCodes: true,
    onScreenKeypad: true,
    hardwareSetting: true,
  }),
}));

// Unmounted after each test rather than left standing: the dock polls for focus
// on an interval, and a tree that outlives its test keeps polling into a torn-
// down Jest environment -- which takes the whole runner down with it.
let rendered: ReactTestRenderer[] = [];

function render() {
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(<TillKeypadHost />); });
  rendered.push(tree!);
  return tree!;
}

// Keys are Pressables labelled by their glyph. RN's `Pressable` is a memo, so
// it is found by its props rather than its type -- same duck-typing the other
// component tests use.
function press(tree: ReactTestRenderer, label: string) {
  const key = tree.root.findAll((node) => {
    if (typeof node.props?.onPress !== 'function') return false;
    const texts = node.findAllByType(Text).map((t) => String(t.props.children));
    return texts.includes(label);
  }, { deep: true })[0];
  if (!key) throw new Error(`no key labelled ${label}`);
  act(() => { key.props.onPress(); });
}

function labels(tree: ReactTestRenderer) {
  return tree.root.findAllByType(Text).map((t) => String(t.props.children));
}

describe('TillKeypadHost', () => {
  beforeEach(() => { mockTyped = []; mockBlurred = 0; resetSinkInput(); });
  afterEach(() => {
    act(() => { rendered.forEach((tree) => tree.unmount()); });
    rendered = [];
  });

  it('types lowercase by default', () => {
    const tree = render();
    press(tree, 'a');
    expect(mockTyped).toEqual(['a']);
  });

  // A single capital at the start of a name is the common case, so shift costs
  // one key rather than two -- and spends itself, the way every phone does it.
  // The keycaps show the case they will type, so the test presses what the
  // cashier sees: 'A' while shift is armed, 'b' once it has been spent.
  it('capitalises one letter after shift, then falls back', () => {
    const tree = render();
    press(tree, '⇧');
    press(tree, 'A');
    press(tree, 'b');
    expect(mockTyped).toEqual(['A', 'b']);
  });

  // An all-caps SKU read off a label would be unbearable one shift at a time.
  it('holds capitals once shift is pressed twice', () => {
    const tree = render();
    press(tree, '⇧');
    press(tree, '⇧'); // armed once, then locked -- the cap only reads ⇪ after
    press(tree, 'A');
    press(tree, 'B');
    expect(mockTyped).toEqual(['A', 'B']);
  });

  it('lets go of caps on a third press', () => {
    const tree = render();
    press(tree, '⇧');
    press(tree, '⇧');
    press(tree, '⇪'); // locked, and this releases it
    press(tree, 'a');
    expect(mockTyped).toEqual(['a']);
  });

  // The gap that made the keypad unusable for anything but search: a customer
  // email needs an `@` and a `.`, and neither existed anywhere on it.
  it('reaches the symbols an email address needs', () => {
    const tree = render();
    press(tree, '?123');
    expect(labels(tree)).toEqual(expect.arrayContaining(['@', '.', '-', '_', '+']));
    press(tree, '@');
    press(tree, '.');
    expect(mockTyped).toEqual(['@', '.']);
  });

  it('comes back to letters from the symbol layer', () => {
    const tree = render();
    press(tree, '?123');
    press(tree, 'ABC');
    press(tree, 'a');
    expect(mockTyped).toEqual(['a']);
  });

  // Digits are on every layer: a barcode typed by hand must never cost a layer
  // switch, whichever layer the last thing left it on.
  it('keeps digits on both layers', () => {
    const tree = render();
    expect(labels(tree)).toEqual(expect.arrayContaining(['1', '0']));
    press(tree, '?123');
    expect(labels(tree)).toEqual(expect.arrayContaining(['1', '0']));
  });

  it('carries backspace and the scanner\'s own terminator', () => {
    const tree = render();
    press(tree, '⌫');
    press(tree, '↵');
    expect(mockTyped).toEqual(['⌫', '↵']);
  });

  // The iPhone trap. `Keyboard.dismiss` only blurs the field React Native's own
  // cache is holding, and that cache is empty by the time a field unmounts --
  // while UIKit still answers "an editor is focused". Done went through the
  // motions, the dock stayed, and it covers the tab bar: no keyboard, no
  // navigation, no way out but killing the app.
  //
  // So Done is believed on its own terms. Whatever the platform claims about
  // focus, the person pressing it has said they are finished typing.
  it('puts the dock away on Done even while the platform insists a field is focused', () => {
    const tree = render();
    expect(labels(tree)).toEqual(expect.arrayContaining(['Done']));
    press(tree, 'Done');
    expect(tree.toJSON()).toBeNull();
  });

  // Blurring for real as well, so the stuck responder is cleared rather than
  // merely ignored -- otherwise the next scan types into a field nobody can see.
  it('releases the focused editor natively, not just in the JS cache', () => {
    const tree = render();
    press(tree, 'Done');
    expect(mockBlurred).toBe(1);
  });

  // The iPhone-with-a-scanner-and-no-keyboard trap, at its source.
  //
  // `WedgeSink` keeps the caret in a one-pixel invisible field so that a binary
  // which cannot capture keys still catches scans. Counting that as "someone is
  // typing" put the dock on screen with nothing focused that anyone could see,
  // over the tab bar, and blurring it only made the sink take the caret back
  // 150ms later -- so it could not be dismissed either. On a till whose only
  // hardware is a scanner, that is a phone you cannot navigate.
  it('does not raise the dock for the scan sink holding the caret', () => {
    jest.useFakeTimers();
    const sink = { getNativeRef: () => ({}) } as never;
    markSinkInput(sink);
    const focus = jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue(sink);
    const editor = jest.spyOn(mockModule, 'isEditorFocused').mockReturnValue(false);
    try {
      const tree = render();
      act(() => { jest.advanceTimersByTime(1000); });
      expect(tree.toJSON()).toBeNull();
    } finally {
      focus.mockRestore();
      editor.mockRestore();
      jest.useRealTimers();
    }
  });

  // ...while a field the cashier actually tapped still gets its keyboard, even
  // with the sink registered and scanning.
  it('still raises the dock for a real field while the sink exists', () => {
    jest.useFakeTimers();
    markSinkInput({ getNativeRef: () => ({}) } as never);
    const field = { getNativeRef: () => ({}) } as never;
    const focus = jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue(field);
    const editor = jest.spyOn(mockModule, 'isEditorFocused').mockReturnValue(false);
    try {
      const tree = render();
      act(() => { jest.advanceTimersByTime(400); });
      expect(labels(tree)).toEqual(expect.arrayContaining(['Done']));
    } finally {
      focus.mockRestore();
      editor.mockRestore();
      jest.useRealTimers();
    }
  });

  // Dismissed is not disabled: the next field the cashier taps gets its
  // keyboard back. Believed from React's side rather than the platform's,
  // because the platform is the half that is stuck -- a live field in the focus
  // cache is a focus that genuinely MOVED, which a stale responder never does.
  it('comes back when a live field takes focus afterwards', () => {
    jest.useFakeTimers();
    const live = { getNativeRef: () => ({}) } as never;
    // `null` is what the real cache returns with nothing focused; the typed
    // signature only admits an element.
    const focus = jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue(null as never);
    try {
      const tree = render();
      press(tree, 'Done');
      expect(tree.toJSON()).toBeNull();
      focus.mockReturnValue(live);
      act(() => { jest.advanceTimersByTime(400); });
      expect(labels(tree)).toEqual(expect.arrayContaining(['Done']));
    } finally {
      focus.mockRestore();
      jest.useRealTimers();
    }
  });
});
