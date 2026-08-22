import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';

import { StockCountModal } from '@/components/stock-count-modal';

// The half of the count screen that a pure test cannot reach.
//
// count-import.test.ts tests planCount and summariseCount against finished
// values. Every input bug that shipped from the RESTOCK screen was
// finished-string-correct and lived here instead, in the component's own
// setter, where a normalising .replace() rewrote a controlled field between
// keystrokes so the next character landed on text the person never typed. A
// test that feeds whole strings to the classifier stays green through all of
// them.
//
// So every case below is driven the way a controlled TextInput actually drives
// it: read the field's current value, append or remove ONE character, hand that
// back to the component's own onChangeText, then read the field again. A helper
// that did `state + character` would never touch the component and could not
// catch the class it was written for.

// Two stores, not one: `hasMultipleLocations` renders nothing for a single
// store, and the store-switch regression (below) can only happen where a
// switcher exists at all. Every other test in this file still opens on
// 'loc-1' via `activeLocation`, so this is not a change of default for them.
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    locations: [
      { id: 'loc-1', name: 'Main', active: true },
      { id: 'loc-2', name: 'Branch', active: true },
    ],
    activeLocation: { id: 'loc-1', name: 'Main', active: true },
  }),
}));

jest.mock('@/lib/categories', () => ({ listCategories: jest.fn(async () => []) }));

const product = (over: Record<string, unknown>) => ({
  id: 'p-1',
  shopId: 'shop-1',
  name: 'QA widget',
  description: null,
  sku: 'QA-1',
  barcode: null,
  brand: null,
  category: null,
  tags: [],
  supplierName: null,
  costCents: 461,
  priceCents: 500,
  stock: 11,
  reorderLevel: null,
  shelfNumber: 'A3',
  expiryDate: null,
  batchNumber: null,
  imageUrl: null,
  isListedOnline: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

jest.mock('@/lib/products', () => ({
  listProducts: jest.fn(async () => []),
  saveStockCount: jest.fn(async () => 'count-1'),
}));
const { listProducts, saveStockCount } = jest.requireMock('@/lib/products') as {
  listProducts: jest.Mock;
  saveStockCount: jest.Mock;
};

jest.mock('@/lib/pick-csv-file', () => ({ pickCsvFile: jest.fn() }));
jest.mock('@/lib/expenses', () => ({ createExpense: jest.fn(async () => ({})) }));

const COUNTED = 'Counted units of QA widget';

function fieldNamed(tree: ReactTestRenderer, label: string): ReactTestInstance {
  return tree.root.findAll((n) => n.props['aria-label'] === label)[0];
}

function pressableLabelled(tree: ReactTestRenderer, label: string): ReactTestInstance {
  return tree.root.findAll((n) => n.props.accessibilityLabel === label)[0];
}

// For the handful of Pressables (the header Close button, StoreDropdown's
// trigger and its options) that carry no accessibilityLabel at all -- found
// instead by walking up from the Text they render to the nearest ancestor
// that actually handles a press. Not matched by `n.type === Pressable`:
// RN's `Pressable` renders through an inner function component of the same
// name, so the instance found by walking `.parent` is that inner one and
// fails a reference match against the imported `Pressable` -- `onPress` is
// present on both and is what a test actually needs to call.
function pressableWithText(tree: ReactTestRenderer, text: string): ReactTestInstance {
  const label = tree.root.findAll((n) => n.type === Text && textFrom(n) === text)[0];
  let node: ReactTestInstance | null = label;
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  if (!node) throw new Error(`No pressable ancestor found for text "${text}"`);
  return node;
}

// `node.children` is the TEST-INSTANCE tree, not the `children` prop: React
// Native's `Text` wraps its content in a host-level `Text` primitive, so a
// found node's immediate `.children` is that ONE nested instance, never the
// raw string, even for the plainest `<Text>{name}</Text>`. Recursing until a
// string turns up is what actually reaches it, one level deeper than a literal
// reading of "map children, keep the strings" would stop at.
function textFrom(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map((child) => textFrom(child)).join('');
}

function allText(tree: ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map((node) => textFrom(node))
    .join(' | ');
}

// One character at a time, through the component's own handler.
async function type(tree: ReactTestRenderer, label: string, characters: string) {
  for (const character of characters) {
    const field = fieldNamed(tree, label);
    const next = String(field.props.value ?? '') + character;
    await act(async () => field.props.onChangeText(next));
  }
}

async function backspace(tree: ReactTestRenderer, label: string, times = 1) {
  for (let i = 0; i < times; i += 1) {
    const field = fieldNamed(tree, label);
    const current = String(field.props.value ?? '');
    await act(async () => field.props.onChangeText(current.slice(0, -1)));
  }
}

async function open(products = [product({})]): Promise<ReactTestRenderer> {
  listProducts.mockResolvedValue(products);
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />
    );
  });
  // The results list renders the whole (short) catalogue with no search term.
  await act(async () => pressableLabelled(tree, 'Count QA widget').props.onPress());
  return tree;
}

beforeEach(() => {
  saveStockCount.mockClear();
  saveStockCount.mockResolvedValue('count-1');
});

describe('a line added to a count', () => {
  // Difference 1 from Restock, and the reason the footer can say "3 counted"
  // while only 2 change anything: a stock-take mostly CONFIRMS, so the field
  // starts at the current figure and a row left untouched means "I looked, it
  // matched" -- which is real information.
  it('starts at what the app believes, not at zero or empty', async () => {
    const tree = await open();
    expect(fieldNamed(tree, COUNTED).props.value).toBe('11');
    expect(allText(tree)).toContain('App says 11');
  });

  it('counts an untouched row and reports that it changes nothing', async () => {
    const tree = await open();
    expect(allText(tree)).toContain('Save 1 count');
    expect(allText(tree)).toContain('0 will change a number');
  });

  // The regression class three separate 100x cost bugs came from on the restock
  // branch. If anything rewrites the text on its way into state, the recorded
  // value after some keystroke stops equalling what was typed.
  it('never rewrites the text between keystrokes', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    await type(tree, COUNTED, '108');
    expect(fieldNamed(tree, COUNTED).props.value).toBe('108');
    await backspace(tree, COUNTED, 1);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('10');
  });

  // An empty field is just an empty field. Dropping the row at 0 -- the restock
  // screen's first attempt -- unmounted the focused input on the first
  // backspace, closed the keyboard, and took the reason chosen beside it.
  it('keeps the row and its reason when the field is emptied', async () => {
    const tree = await open();
    await act(async () => pressableLabelled(tree, 'Reason for QA widget').props.onPress());
    await act(async () => pressableLabelled(tree, 'Reason: Damaged').props.onPress());
    await backspace(tree, COUNTED, 2);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    expect(allText(tree)).toContain('Damaged');
    expect(allText(tree)).toContain('Type what you found on every line');
  });

  // Zero is a finding, not a blank. Refusing it would leave the door able to
  // record every loss except a total one.
  it('accepts a counted zero and reads it as an empty shelf', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '0');
    expect(allText(tree)).toContain('−11');
    expect(allText(tree)).toContain('1 will change a number');
  });

  // The variance is the column, not a footnote: the person doing the
  // stock-take already knows the 8 -- what they will be asked about is how far
  // off the app was.
  it('shows the variance live and signed', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    expect(allText(tree)).toContain('−3');
    await backspace(tree, COUNTED, 1);
    await type(tree, COUNTED, '14');
    expect(allText(tree)).toContain('+3');
  });

  // Colour is the ONLY signal that a variance is a shortfall rather than a
  // surplus -- the glyph itself ('−3') reads the same whether or not the
  // style attached to it survives a refactor. Caught a real mutation: with
  // the red/green styling deleted, every one of this file's other cases
  // stayed green because none of them look at style.
  it('marks a shortfall in the shortfall colour, and a surplus in a different one', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8'); // App says 11, counted 8: a shortfall of 3.
    const shortfall = tree.root.findAll((n) => n.type === Text && textFrom(n) === '−3')[0];
    expect(StyleSheet.flatten(shortfall.props.style).color).toBe('#A3202F');

    await backspace(tree, COUNTED, 1);
    await type(tree, COUNTED, '14'); // Counted 14: a surplus of 3.
    const surplus = tree.root.findAll((n) => n.type === Text && textFrom(n) === '+3')[0];
    expect(StyleSheet.flatten(surplus.props.style).color).toBe('#007A38');
    expect(StyleSheet.flatten(surplus.props.style).color).not.toBe('#A3202F');
  });
});

describe('changing the store', () => {
  // Finding 1: the reload effect used to re-point every line's `product` at
  // the new store's row while leaving the typed `counted` string untouched.
  // Main holds this product at 11, Branch at 3 -- pre-fill at Main reads 11,
  // switch to Branch, and the stale "11" was still sitting in a field now
  // captioned "App says 3", ready to overwrite a shelf nobody walked. The
  // fix has to be proven at the boundary that matters: what `saveStockCount`
  // is actually called with, not just what the screen renders.
  it('empties the basket, so a commit after the switch cannot send the old store\'s number', async () => {
    listProducts.mockImplementation(async (_shopId: string, locationId: string) =>
      locationId === 'loc-2' ? [product({ stock: 3 })] : [product({ stock: 11 })]
    );
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    await act(async () => pressableLabelled(tree, 'Count QA widget').props.onPress());
    expect(fieldNamed(tree, COUNTED).props.value).toBe('11');

    // Open the store picker (trigger reads the current store's name) and
    // choose the other one.
    await act(async () => pressableWithText(tree, 'Main').props.onPress());
    await act(async () => pressableWithText(tree, 'Branch').props.onPress());

    // The row counted at Main is gone entirely -- not merely re-pointed.
    expect(tree.root.findAll((n) => n.props['aria-label'] === COUNTED)).toHaveLength(0);
    expect(allText(tree)).not.toContain('App says 11');

    // Re-add at Branch and commit untouched: it must read Branch's own
    // stock (3), never the 11 that was typed for Main.
    await act(async () => pressableLabelled(tree, 'Count QA widget').props.onPress());
    expect(fieldNamed(tree, COUNTED).props.value).toBe('3');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount).toHaveBeenCalledWith(
      'shop-1',
      'loc-2',
      [{ productId: 'p-1', countedQuantity: 3, reason: null }],
      { note: null }
    );
  });

  // The reload effect re-runs for reasons that are NOT a store change too --
  // this component is hidden with `visible={false}` rather than unmounted,
  // so a screen toggling it back and forth re-fires the same effect at the
  // same `locationId`. That must not be mistaken for a transition and clear
  // a basket someone is mid-typing.
  it('does not clear the basket when the effect re-runs at the same store', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => {
      tree.update(<StockCountModal visible={false} shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    await act(async () => {
      tree.update(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    expect(fieldNamed(tree, COUNTED).props.value).toBe('8');
  });
});

describe('saving a count', () => {
  // THE distinction from Restock, at the only layer a component test can see
  // it: the RPC is handed the TOTAL that was found, never the difference.
  it('sends the counted total, not the change', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Reason for QA widget').props.onPress());
    await act(async () => pressableLabelled(tree, 'Reason: Damaged').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());

    expect(saveStockCount).toHaveBeenCalledWith(
      'shop-1',
      'loc-1',
      [{ productId: 'p-1', countedQuantity: 8, reason: 'damaged' }],
      { note: null }
    );
  });

  it('sends a null reason rather than defaulting one', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount.mock.calls[0][2]).toEqual([
      { productId: 'p-1', countedQuantity: 8, reason: null },
    ]);
  });

  // The CRITICAL from the restock branch, pinned here so it cannot be
  // reintroduced: `await onDone()` inside the try that had already committed
  // meant a reload failing on a network blip landed in the catch, showed an
  // error, cleared busy and LEFT THE BASKET FULL -- and pressing Save again
  // wrote the same count a second time.
  it('does not leave a live basket behind a failed reload', async () => {
    listProducts.mockResolvedValue([product({})]);
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <StockCountModal
          visible
          shopId="shop-1"
          onClose={() => {}}
          onDone={async () => {
            throw new Error('network');
          }}
        />
      );
    });
    await act(async () => pressableLabelled(tree, 'Count QA widget').props.onPress());
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount).toHaveBeenCalledTimes(1);
  });

  // A failure that wrote NOTHING is the opposite case, and the basket must
  // survive it -- this is the one failure a shop fixes by pressing again.
  it('keeps the basket when the count itself was refused', async () => {
    saveStockCount.mockRejectedValueOnce(new Error('not authorized for shop shop-1'));
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(fieldNamed(tree, COUNTED).props.value).toBe('8');
    expect(allText(tree)).toContain('not authorized');
  });
});

describe('closing the sheet', () => {
  // This component is never unmounted -- the screen renders it with
  // `visible={false}` and it returns null, keeping all of its state -- so
  // `closeAndReset` is the ONLY thing that empties the basket between one
  // stock-take and the next. A basket that survives a close is a double-count
  // waiting to happen the next time this sheet is opened.
  it('empties the basket', async () => {
    const tree = await open();
    await act(async () => pressableWithText(tree, 'Close').props.onPress());
    // The row is gone, not merely blanked -- "App says 11" still appears in
    // the search results below (the product is available to add again), so
    // the field itself is what proves the basket, not the surrounding text.
    expect(tree.root.findAll((n) => n.props['aria-label'] === COUNTED)).toHaveLength(0);
    expect(allText(tree)).toContain('Save 0 count');
  });
});
