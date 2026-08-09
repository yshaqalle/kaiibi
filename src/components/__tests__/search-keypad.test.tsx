import { StyleSheet, Text, View } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { SearchKeypad } from '@/components/search-keypad';

function render(props: Partial<React.ComponentProps<typeof SearchKeypad>> = {}) {
  const onChange = jest.fn();
  const onSubmit = jest.fn();
  const onClose = jest.fn();
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(
      <SearchKeypad value="she" onChange={onChange} onSubmit={onSubmit} onClose={onClose} {...props} />,
    );
  });
  const press = (label: string) => {
    // Duck-type on `onPress` rather than matching by `.type`: RN's Pressable
    // is exported as a React.memo, and what a memo's fiber `.type` collapses
    // to is an undocumented reconciler detail, not react-test-renderer's
    // contract. Any pressable carries `props.onPress` regardless. See
    // dashboard-cards.test.tsx's `pressLabelled` for the same pattern.
    const target = tree!.root
      .findAll((node) => typeof node.props?.onPress === 'function', { deep: true })
      .find((node) => node.findAllByType(Text).some((t) => t.props.children === label));
    if (!target) throw new Error(`no key labelled ${label}`);
    act(() => { target.props.onPress(); });
  };
  return { onChange, onSubmit, onClose, press, tree: tree! };
}

describe('SearchKeypad', () => {
  it('is QWERTY, with the digits on top', () => {
    const { tree } = render();
    const labels = tree.root.findAllByType(Text).map((t) => t.props.children);
    expect(labels.slice(0, 10)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
    expect(labels.slice(10, 20)).toEqual(['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P']);
  });

  // Lowercase out, whatever the cap on the key: search is case-insensitive and
  // the value goes straight into the same filter a typed query uses.
  it('appends the letter in lower case', () => {
    const { onChange, press } = render();
    press('A');
    expect(onChange).toHaveBeenCalledWith('shea');
  });

  it('deletes and clears', () => {
    const { onChange, press } = render();
    press('⌫');
    expect(onChange).toHaveBeenCalledWith('sh');
    press('Clear');
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('submits and closes on Done', () => {
    const { onSubmit, onClose, press } = render();
    press('Done');
    expect(onSubmit).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  // Every key row is a flexbox row with `gap: 5`; a short row is centred with
  // a spacer of equal flex on each side rather than stretched. A key is only
  // the same width on every row if a row's TOTAL flex (its keys' flex plus
  // both spacers') equals the top row's key count -- that is what "half the
  // shortfall on each side" is for. A fixed 0.5-flex spacer only balances a
  // row that is exactly one key short ('asdfghjkl'); it under-corrects the
  // bottom row, which is three keys short, leaving its keys visibly wider.
  it('gives every row the same total flex as the top row, so keys stay equal width', () => {
    const { tree } = render();

    const flexOf = (style: unknown): number => {
      if (Array.isArray(style)) {
        return (style as ({ flex?: number } | null | undefined)[]).reduce(
          (sum, s) => sum + (s?.flex ?? 0),
          0,
        );
      }
      return (style as { flex?: number } | undefined)?.flex ?? 0;
    };

    const isKeyRow = (node: ReactTestInstance) => {
      if (node.type !== View) return false;
      const style = node.props.style as { flexDirection?: string; gap?: number } | undefined;
      return style?.flexDirection === 'row' && style?.gap === 5;
    };

    // The 4 letter/digit rows all use this exact row style; the utility row
    // (Clear/space/⌫/Done) reuses the same style object but comes after them.
    const rows = tree.root.findAll(isKeyRow).slice(0, 4);
    expect(rows).toHaveLength(4);

    // A row's key and spacer elements are its shallowest flex-bearing
    // descendants -- `deep: false` stops at each one rather than also
    // matching the native view each Pressable/View forwards its style prop
    // to underneath.
    const totalFlex = (row: ReactTestInstance) =>
      row
        .findAll((node) => flexOf(node.props?.style) !== 0, { deep: false })
        .reduce((sum, node) => sum + flexOf(node.props?.style), 0);

    // The top row has no spacers, so its total flex IS its key count (10).
    const topRowKeyCount = totalFlex(rows[0]);
    expect(topRowKeyCount).toBe(10);

    for (const row of rows) {
      expect(totalFlex(row)).toBe(topRowKeyCount);
    }
  });

  // On a tablet the dock surface spans the screen but the KEYS cap at a
  // phone-ish width and centre -- stretched to tablet width they become a
  // piano and the hand loses the row shape it learned on the phone.
  it('caps the key block width so tablet keys do not stretch', () => {
    const { tree } = render();
    const capped = tree.root.findAll((node) => {
      const flat = StyleSheet.flatten(node.props?.style);
      return flat?.maxWidth === 560 && flat?.alignSelf === 'center';
    });
    expect(capped.length).toBeGreaterThan(0);
  });
});
