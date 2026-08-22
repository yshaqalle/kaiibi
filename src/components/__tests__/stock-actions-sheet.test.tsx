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
const renderJSON = (over: Partial<React.ComponentProps<typeof StockActionsSheet>> = {}) => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <StockActionsSheet visible onClose={() => {}} onPick={() => {}} showMove showCount {...over} />,
    );
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

  // The four hints and the blurb, checked again here verbatim and in full.
  // They are the whole reason this sheet exists (Restock ADDS, Count
  // REPLACES) rather than decoration around it, so a paraphrase that keeps the
  // short substrings above but drops "A delivery arrived." or loses the
  // arithmetic should fail a test. The dash in "holds — 11" and "found — 11"
  // is an em dash (U+2014), and the sign on "−3" is a minus sign (U+2212),
  // not a hyphen -- both typed literally so a find-and-replace to ASCII
  // punctuation is itself a failure.
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
});

describe('the Count door', () => {
  // It shipped disabled with a "Coming next" badge, because the sheet cannot
  // teach the difference between adding and replacing with the replacing half
  // missing. The badge going away is the feature.
  it('no longer says it is coming', () => {
    expect(render().join(' ')).not.toContain('Coming next');
  });

  it('hands Count to onPick like any other door', () => {
    const picked: string[] = [];
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <StockActionsSheet visible onClose={() => {}} onPick={(a) => picked.push(a)} showMove showCount />,
      );
    });
    const row = tree.root.findAll((n) => n.props.accessibilityLabel === 'Count')[0];
    act(() => row.props.onPress());
    expect(picked).toEqual(['count']);
  });

  // The permission is enforced in the RPC, which is what actually stops a
  // write-off. This is the other half: a role that cannot do it is not offered
  // it, so nobody meets the refusal by pressing a button that looked live.
  it('is absent for someone without the permission', () => {
    const texts = render({ showCount: false });
    expect(texts).not.toContain('Count');
    // And the door does not become an empty room: Restock is the base meaning
    // of inventory.edit and is still there.
    expect(texts).toContain('Restock');
  });

  it('hides Move for someone without the transfer permission, one-store or not', () => {
    expect(render({ showMove: false })).not.toContain('Move');
  });
});
