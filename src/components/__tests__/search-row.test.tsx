import { StyleSheet, Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SearchRow } from '@/components/search-row';
import { SearchKeypad } from '@/components/search-keypad';

// RN 0.86's `Pressable` is `React.memo(...)`, and React 19's
// react-test-renderer collapses a memo's fiber `.type` to the inner function,
// so `findAllByType(Pressable)` silently matches zero nodes. Duck-type on the
// prop instead -- see dashboard-cards.test.tsx and search-keypad.test.tsx.
function findPressables(tree: ReactTestRenderer) {
  return tree.root.findAll((node) => typeof node.props?.onPress === 'function', { deep: true });
}

// The caret has no type of its own (it may be an Animated.View), so it is
// found by its one unmistakable trait: a 2pt-wide bar. `deep: false`
// collapses the Animated.View wrapper chain -- every layer carries the same
// style prop, and deep matching would count one caret three times.
function findCarets(tree: ReactTestRenderer) {
  return tree.root.findAll((node) => {
    const flat = StyleSheet.flatten(node.props?.style);
    return flat?.width === 2 && flat?.height === 16;
  }, { deep: false });
}

function row(useKeypad: boolean, value: string, onChange: jest.Mock) {
  return (
    <SearchRow
      value={value}
      onChange={onChange}
      onSubmit={jest.fn()}
      placeholder="Search or scan a product"
      useKeypad={useKeypad}
      showScanButton={false}
    />
  );
}

function render(useKeypad: boolean, value = '') {
  const onChange = jest.fn();
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(row(useKeypad, value, onChange)); });
  const rerender = (nextUseKeypad: boolean) => {
    act(() => { tree!.update(row(nextUseKeypad, value, onChange)); });
  };
  const labels = () => tree!.root.findAllByType(Text).map((t) => t.props.children);
  return { tree: tree!, onChange, rerender, labels };
}

// The caret blinks on a real 550ms Animated loop; under real timers it
// outlives the test environment and crashes the worker at teardown.
beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

describe('SearchRow', () => {
  it('is an ordinary text field on a device with no keyboard attached', () => {
    const { tree } = render(false);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(1);
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(0);
  });

  // The load-bearing assertion of the whole feature. A TextInput here would
  // take focus from the wedge sink, and scanning would stop the moment someone
  // touched the search box.
  it('renders NO text input at all when the keypad is in use', () => {
    const { tree } = render(true);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
  });

  it('opens the keypad only once the field is tapped', () => {
    const { tree } = render(true);
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(0);
    act(() => { findPressables(tree)[0].props.onPress(); });
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(1);
  });

  it('renders no text input even with the keypad open', () => {
    // A TextInput here would take focus from the wedge sink and stop hardware scanning.
    const { tree } = render(true);
    act(() => { findPressables(tree)[0].props.onPress(); });
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(1);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
  });

  it('says how to use it while it is closed and empty', () => {
    expect(render(true).labels()).toContain('Tap to type, or scan');
  });

  it('shows the typed text instead of the prompt', () => {
    expect(render(true, 'shea').labels()).toContain('shea');
  });

  // The promise the whole design turns on, and it must be visible in the world
  // that needs it and absent from the one that does not.
  it('promises the scanner is still live in the keypad world', () => {
    expect(render(true).labels()).toContain('Scanner ready');
  });

  it('makes no such promise on a device with no scanner', () => {
    expect(render(false).labels()).not.toContain('Scanner ready');
  });

  // Someone unplugs the scanner mid-sale. Closing rather than merely hiding
  // means plugging it back in does not silently reopen a keypad nobody asked
  // for, on top of the product grid.
  it('closes the keypad when the keyboard is unplugged', () => {
    const { tree, rerender } = render(true);
    act(() => { findPressables(tree)[0].props.onPress(); });
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(1);

    rerender(false);
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(0);

    rerender(true);
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(0);
  });

  // The caret is drawn by hand -- a Pressable has no system caret -- and it
  // must sit where a caret sits: on the text row, after the last character,
  // not wherever the field's column layout happens to drop it.
  it('draws the caret beside the text, on the same row', () => {
    const { tree } = render(true, 'coca co');
    act(() => { findPressables(tree)[0].props.onPress(); });
    const carets = findCarets(tree);
    expect(carets).toHaveLength(1);
    // The caret's own wrapper (BlinkingCaret) carries no style; the layout
    // assertion belongs to the nearest styled ancestor -- the value row.
    let holder = carets[0].parent!;
    while (!StyleSheet.flatten(holder.props?.style)) holder = holder.parent!;
    expect(StyleSheet.flatten(holder.props.style).flexDirection).toBe('row');
    expect(holder.findAllByType(Text).map((t) => t.props.children)).toContain('coca co');
  });

  // With the keypad open the field is live, like a focused TextInput: an empty
  // live field shows a bare caret, not advice to tap a thing already tapped.
  it('replaces the prompt with a bare caret while the keypad is open and empty', () => {
    const { tree, labels } = render(true);
    act(() => { findPressables(tree)[0].props.onPress(); });
    expect(labels()).not.toContain('Tap to type, or scan');
    expect(findCarets(tree)).toHaveLength(1);
  });

  it('shows no caret while the keypad is closed', () => {
    expect(findCarets(render(true, 'shea').tree)).toHaveLength(0);
  });

  // POS's field is deliberately bigger than Inventory's -- read at arm's
  // length in shop lighting rather than at a desk. This locks the relative
  // size in so a future edit to the shared row can't silently flatten it.
  it('makes the counter field taller than the desk field', () => {
    const fieldHeight = (tree: ReactTestRenderer) => {
      const field = tree.root.findAllByType(TextInput)[0];
      const flat = StyleSheet.flatten(field.props.style);
      return flat.height;
    };

    let deskTree: ReactTestRenderer | undefined;
    act(() => {
      deskTree = create(
        <SearchRow
          value=""
          onChange={jest.fn()}
          onSubmit={jest.fn()}
          placeholder="Search"
          useKeypad={false}
          showScanButton={false}
        />,
      );
    });

    let counterTree: ReactTestRenderer | undefined;
    act(() => {
      counterTree = create(
        <SearchRow
          value=""
          onChange={jest.fn()}
          onSubmit={jest.fn()}
          placeholder="Search"
          useKeypad={false}
          showScanButton={false}
          size="counter"
        />,
      );
    });

    expect(fieldHeight(counterTree!)).toBeGreaterThan(fieldHeight(deskTree!));
  });
});
