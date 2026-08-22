import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

import { StockActionsSheet } from '@/components/stock-actions-sheet';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

// Post-order search for the deepest (most specific) node matching `predicate`
// -- children are checked before the node itself, so a match on an outer
// wrapper (e.g. the sheet's own overlay Pressable, which is `focusable` and
// contains every row's text in its subtree) never shadows the actual row
// that owns the property being tested for.
function findNode(
  node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null,
  predicate: (n: ReactTestRendererJSON) => boolean,
): ReactTestRendererJSON | null {
  if (node == null || typeof node === 'string') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  }
  const childMatch = findNode(node.children as ReactTestRendererJSON[] | null, predicate);
  if (childMatch) return childMatch;
  return predicate(node) ? node : null;
}

// `create` is wrapped in `act` because React's concurrent root does the first
// render in a scheduled task, not in the call: a bare `create(...).toJSON()`
// reads the tree before anything has been rendered into it and returns null for
// every case, including the ones that should be full of text. Same reason every
// other renderer test in this directory wraps it.
const renderJSON = (over: Partial<React.ComponentProps<typeof StockActionsSheet>> = {}) => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<StockActionsSheet visible onClose={() => {}} onPick={() => {}} showMove {...over} />);
  });
  return tree.toJSON() as ReactTestRendererJSON | null;
};

const render = (over: Partial<React.ComponentProps<typeof StockActionsSheet>> = {}) => textsIn(renderJSON(over));

describe('the Stock door', () => {
  // The hints are the entire reason this sheet exists: shops were reaching for
  // product import to add stock, which counts the same units twice. Naming the
  // arithmetic on the way in is cheaper than a rejection read afterwards.
  it('says what each door does to the number', () => {
    const texts = render().join(' ');
    expect(texts).toContain('11 becomes 17');
    expect(texts).toContain('11 becomes 8');
    expect(texts).toContain("Your total doesn't change");
    expect(texts).toContain('count the same units twice');
  });

  // The four hints, the blurb and the badge, checked again here verbatim and in
  // full. They are the whole reason this sheet exists (Restock ADDS, Count
  // REPLACES) rather than decoration around it, so a paraphrase that keeps the
  // short substrings above but drops "A delivery arrived.", loses the
  // arithmetic, swaps the dash, or renames the badge should fail a test. The
  // dash in "holds — 11" and "found — 11" is an em dash (U+2014), and the sign
  // on "−3" is a minus sign (U+2212), not a hyphen -- both typed literally so a
  // find-and-replace to ASCII punctuation is itself a failure.
  it('carries the exact copy the arithmetic depends on', () => {
    const texts = render();
    expect(texts).toContain(
      "Change the numbers. To add something you don't sell yet, use + Add product.",
    );
    expect(texts).toContain(
      'A delivery arrived. Adds units to what a store already holds — 11 becomes 17.',
    );
    expect(texts).toContain(
      'A stock-take. Replaces the count with what you actually found — 11 becomes 8, and the app records the −3.',
    );
    expect(texts).toContain(
      "Send units from one of your stores to another. Your total doesn't change.",
    );
    expect(texts).toContain(
      "Only for products you don't sell yet. Importing something you already carry would count the same units twice.",
    );
    expect(texts).toContain('Coming next');
  });

  it('offers restock, count, move and import', () => {
    const texts = render();
    expect(texts).toEqual(expect.arrayContaining(['Restock', 'Count', 'Move', 'Import products']));
  });

  // A one-store shop has nowhere to move stock TO, so the row would be a dead
  // end -- the same reason the header's Move pill hides itself today. The
  // positive assertion matters as much as the negative one: without it,
  // `not.toContain` would pass just as well against a component that rendered
  // nothing at all -- the exact false-pass mode `render` used to have before
  // it was wrapped in `act`.
  it('hides Move for a shop with one store', () => {
    const texts = render({ showMove: false });
    expect(texts).toContain('Restock');
    expect(texts).not.toContain('Move');
  });

  it('renders nothing when it is not visible', () => {
    expect(render({ visible: false })).toEqual([]);
  });

  // Restock, Move and Import are `Pressable`, which React Native marks
  // `accessible`/`focusable` on the host node it renders. Count is a plain
  // `View` carrying only `accessibilityState: { disabled: true }` -- if Count
  // ever became a `Pressable` (even a disabled one), it would pick up
  // `focusable: true` here and this assertion would catch it.
  it('renders Count as an inert row, not a disabled Pressable', () => {
    const tree = renderJSON();

    const countRow = findNode(tree, (n) => n.props?.accessibilityState?.disabled === true);
    expect(countRow).not.toBeNull();
    expect(countRow?.props.focusable).not.toBe(true);
    expect(countRow?.props.accessible).not.toBe(true);

    // A live row, for contrast: the same search, but for a focusable node
    // whose subtree contains "Restock" -- without this, the assertions above
    // would just as well pass against a component with no focusable rows at
    // all.
    const restockRow = findNode(tree, (n) => n.props?.focusable === true && textsIn(n).includes('Restock'));
    expect(restockRow).not.toBeNull();
    expect(restockRow?.props.focusable).toBe(true);
  });
});
