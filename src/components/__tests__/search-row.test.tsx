import { useState } from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SearchRow, useSearchKeypadState } from '@/components/search-row';
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

function row(useKeypad: boolean, value: string, onChange: jest.Mock, keypadOpen = false, onKeypadOpenChange: (open: boolean) => void = jest.fn()) {
  return (
    <SearchRow
      value={value}
      onChange={onChange}
      onSubmit={jest.fn()}
      placeholder="Search or scan a product"
      useKeypad={useKeypad}
      showScanButton={false}
      keypadOpen={keypadOpen}
      onKeypadOpenChange={onKeypadOpenChange}
    />
  );
}

function render(useKeypad: boolean, value = '', keypadOpen = false, onKeypadOpenChange: (open: boolean) => void = jest.fn()) {
  const onChange = jest.fn();
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(row(useKeypad, value, onChange, keypadOpen, onKeypadOpenChange)); });
  const labels = () => tree!.root.findAllByType(Text).map((t) => t.props.children);
  return { tree: tree!, onChange, labels };
}

// The caret blinks on a real 550ms Animated loop; under real timers it
// outlives the test environment and crashes the worker at teardown.
beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

describe('SearchRow', () => {
  it('is an ordinary text field on a device with no keyboard attached', () => {
    const { tree } = render(false);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(1);
  });

  // The load-bearing assertion of the whole feature. A TextInput here would
  // take focus from the wedge sink, and scanning would stop the moment someone
  // touched the search box.
  it('renders NO text input at all when the keypad is in use', () => {
    const { tree } = render(true);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
  });

  it('renders no text input even with the keypad open', () => {
    const { tree } = render(true, '', true);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
  });

  // The keypad now docks at the screen root (see the dock-fix mockup); the row
  // itself must never mount it into the scroll flow again.
  it('never renders the keypad itself — the screen owns the dock', () => {
    const { tree } = render(true, '', true);
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(0);
  });

  it('asks the screen to open the keypad when the field is tapped', () => {
    const onOpen = jest.fn();
    const { tree } = render(true, '', false, onOpen);
    act(() => { findPressables(tree)[0].props.onPress(); });
    expect(onOpen).toHaveBeenCalledWith(true);
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

  // ---- Caret tests carried over from the caret-placement fix (commit
  // 69aab51's sibling work): rendering with keypadOpen instead of pressing,
  // since the row is now controlled. The behaviour they lock is unchanged. ----

  // The caret is drawn by hand -- a Pressable has no system caret -- and it
  // must sit where a caret sits: on the text row, after the last character,
  // not wherever the field's column layout happens to drop it.
  it('draws the caret beside the text, on the same row', () => {
    const { tree } = render(true, 'coca co', true);
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
    const { labels, tree } = render(true, '', true);
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
        <SearchRow value="" onChange={jest.fn()} onSubmit={jest.fn()} placeholder="Search"
          useKeypad={false} showScanButton={false} keypadOpen={false} onKeypadOpenChange={jest.fn()} />,
      );
    });

    let counterTree: ReactTestRenderer | undefined;
    act(() => {
      counterTree = create(
        <SearchRow value="" onChange={jest.fn()} onSubmit={jest.fn()} placeholder="Search"
          useKeypad={false} showScanButton={false} keypadOpen={false} onKeypadOpenChange={jest.fn()} size="counter" />,
      );
    });

    expect(fieldHeight(counterTree!)).toBeGreaterThan(fieldHeight(deskTree!));
  });
});

// A scanner typing into the field the cashier clicked into. The row is
// controlled, so the text has to round-trip through a real state holder for the
// append to happen the way it does in the app.
describe('SearchRow — a scan into the focused field', () => {
  function Harness({ initial, onSubmit }: { initial: string; onSubmit: (value: string) => void }) {
    const [value, setValue] = useState(initial);
    return (
      <SearchRow
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        placeholder="Search or scan a product"
        useKeypad={false}
        showScanButton={false}
        keypadOpen={false}
        onKeypadOpenChange={jest.fn()}
      />
    );
  }

  function typeInto(initial: string, code: string, gapMs: number) {
    const onSubmit = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(<Harness initial={initial} onSubmit={onSubmit} />); });
    const field = () => tree!.root.findByType(TextInput);

    for (const char of code) {
      const next = field().props.value + char;
      act(() => { field().props.onChangeText(next); });
      act(() => { jest.advanceTimersByTime(gapMs); });
    }
    act(() => { field().props.onSubmitEditing(); });

    return { onSubmit, value: () => field().props.value };
  }

  // The reported bug: the box kept the last code and the next scan landed on
  // the end of it -- 88094472559728809447255972, matching nothing, and growing
  // by thirteen digits every time it was scanned again.
  it('replaces a code left in the box instead of extending it', () => {
    const { onSubmit, value } = typeInto('8809447255972', '4901234567894', 5);
    expect(value()).toBe('4901234567894');
    expect(onSubmit).toHaveBeenCalledWith('4901234567894');
  });

  it('submits a scan into an empty box unchanged', () => {
    const { onSubmit, value } = typeInto('', '4901234567894', 5);
    expect(value()).toBe('4901234567894');
    expect(onSubmit).toHaveBeenCalledWith('4901234567894');
  });

  // The other half of the promise: this is still a search box. Somebody
  // refining "shea" to "shea butter" must not have the first word eaten.
  it('leaves text typed at human speed exactly where it is', () => {
    const { onSubmit, value } = typeInto('shea ', 'butter', 150);
    expect(value()).toBe('shea butter');
    expect(onSubmit).toHaveBeenCalledWith('shea butter');
  });

  // At three milliseconds a character a scan can outrun a commit, so the row
  // reads what it last SHOWED rather than the prop. Held fixed here, which is
  // the worst case: the same characters would otherwise look appended twice and
  // the box would be replaced with a doubled code -- the very bug being fixed.
  it('does not double the code when the value prop lags the burst', () => {
    const onSubmit = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = create(
        <SearchRow value="" onChange={jest.fn()} onSubmit={onSubmit} placeholder="Search"
          useKeypad={false} showScanButton={false} keypadOpen={false} onKeypadOpenChange={jest.fn()} />,
      );
    });
    const field = () => tree!.root.findByType(TextInput);

    let typed = '';
    for (const char of '4901234567894') {
      typed += char;
      const next = typed;
      act(() => { field().props.onChangeText(next); });
    }
    act(() => { field().props.onSubmitEditing(); });

    expect(onSubmit).toHaveBeenCalledWith('4901234567894');
  });

  it('clears the box when the clear button is pressed', () => {
    const onSubmit = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(<Harness initial="8809447255972" onSubmit={onSubmit} />); });
    const clear = findPressables(tree!).find((p) => p.props.accessibilityLabel === 'Clear search');
    expect(clear).toBeDefined();
    act(() => { clear!.props.onPress(); });
    expect(tree!.root.findByType(TextInput).props.value).toBe('');
  });
});

describe('useSearchKeypadState', () => {
  function Probe({ useKeypad, onState }: { useKeypad: boolean; onState: (s: ReturnType<typeof useSearchKeypadState>) => void }) {
    onState(useSearchKeypadState(useKeypad));
    return <Text>probe</Text>;
  }

  function renderHook(useKeypad: boolean) {
    let latest: ReturnType<typeof useSearchKeypadState> | undefined;
    let tree: ReactTestRenderer | undefined;
    const el = (u: boolean) => <Probe useKeypad={u} onState={(s) => { latest = s; }} />;
    act(() => { tree = create(el(useKeypad)); });
    return {
      state: () => latest!,
      rerender: (u: boolean) => act(() => { tree!.update(el(u)); }),
    };
  }

  it('starts closed and opens on request', () => {
    const h = renderHook(true);
    expect(h.state().keypadOpen).toBe(false);
    act(() => { h.state().setKeypadOpen(true); });
    expect(h.state().keypadOpen).toBe(true);
  });

  // Someone unplugs the scanner mid-sale. Closing rather than merely hiding
  // means plugging it back in does not silently reopen a keypad nobody asked
  // for, on top of the product grid.
  it('closes when the keyboard is unplugged and stays closed when it returns', () => {
    const h = renderHook(true);
    act(() => { h.state().setKeypadOpen(true); });
    h.rerender(false);
    expect(h.state().keypadOpen).toBe(false);
    h.rerender(true);
    expect(h.state().keypadOpen).toBe(false);
  });
});
