import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { TillKeypadHost } from '@/components/till-keypad-host';

// What the keypad actually did, in the order it did it.
let mockTyped: string[] = [];

jest.mock('../../../modules/hardware-keyboard', () => ({
  supportsTyping: () => true,
  getHardwareKeyboardModule: () => ({
    isEditorFocused: () => true,
    insertText: (text: string) => { mockTyped.push(text); },
    deleteBackward: () => { mockTyped.push('⌫'); },
    pressEnter: () => { mockTyped.push('↵'); },
    addListener: () => ({ remove: () => {} }),
  }),
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

function render() {
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(<TillKeypadHost />); });
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
  beforeEach(() => { mockTyped = []; });

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
});
