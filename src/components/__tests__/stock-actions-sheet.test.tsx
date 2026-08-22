import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

import { StockActionsSheet } from '@/components/stock-actions-sheet';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

// `create` is wrapped in `act` because React's concurrent root does the first
// render in a scheduled task, not in the call: a bare `create(...).toJSON()`
// reads the tree before anything has been rendered into it and returns null for
// every case, including the ones that should be full of text. Same reason every
// other renderer test in this directory wraps it.
const render = (over: Partial<React.ComponentProps<typeof StockActionsSheet>> = {}) => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<StockActionsSheet visible onClose={() => {}} onPick={() => {}} showMove {...over} />);
  });
  return textsIn(tree.toJSON() as ReactTestRendererJSON | null);
};

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

  it('offers restock, count, move and import', () => {
    const texts = render();
    expect(texts).toEqual(expect.arrayContaining(['Restock', 'Count', 'Move', 'Import products']));
  });

  // A one-store shop has nowhere to move stock TO, so the row would be a dead
  // end -- the same reason the header's Move pill hides itself today.
  it('hides Move for a shop with one store', () => {
    expect(render({ showMove: false })).not.toContain('Move');
  });

  it('renders nothing when it is not visible', () => {
    expect(render({ visible: false })).toEqual([]);
  });
});
