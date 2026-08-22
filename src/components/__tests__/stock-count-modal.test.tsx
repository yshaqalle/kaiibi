import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';

import { StockCountModal } from '@/components/stock-count-modal';
import { parseCsvText, rowsToCsv } from '@/lib/csv';
import { COUNT_TEMPLATE_COLUMNS } from '@/lib/count-import';

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

const { pickCsvFile } = jest.requireMock('@/lib/pick-csv-file') as { pickCsvFile: jest.Mock };

function uploaded(rows: Record<string, string>[]) {
  const csv = rowsToCsv(
    rows.map((row) => ({ Product: '', SKU: '', Barcode: '', Store: 'Main', Shelf: '', 'App says': '', Counted: '', Reason: '', ...row })),
    COUNT_TEMPLATE_COLUMNS.map((c) => ({ header: c.header, value: (r: Record<string, string>) => r[c.header] ?? '' }))
  );
  return { status: 'ok' as const, fileName: 'count-sheet.csv', parsed: parseCsvText(csv) };
}

describe('a count that arrives as a sheet', () => {
  // A one-store sheet is the same thing the basket holds, so it lands there --
  // where a number can still be corrected before anything is written.
  it('hands a single-store sheet to the by-hand tab and drops the plan behind it', async () => {
    listProducts.mockResolvedValue([product({})]);
    pickCsvFile.mockResolvedValue(uploaded([{ Product: 'QA widget', Counted: '8', Reason: 'Damaged' }]));
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());
    await act(async () => pressableWithText(tree, 'Upload a filled sheet').props.onPress());

    expect(fieldNamed(tree, COUNTED).props.value).toBe('8');
    expect(allText(tree)).toContain('Damaged');
    // Corrected on the hand tab, then the sheet tab is looked at again: it must
    // show no live plan, because the basket is now the only copy of this count.
    await backspace(tree, COUNTED, 1);
    await type(tree, COUNTED, '12');
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());
    expect(allText(tree)).toContain('No sheet yet');
  });

  // Two correct fixes colliding: Task 5's store-transition guard
  // (`lastLocationRef`) clears the basket on a genuine store change, and this
  // handover moves a single-store plan into the basket by calling
  // `setLocationId` to follow it. Without pinning the ref, the guard reads
  // that programmatic call as a user changing stores and empties the basket
  // the same handover just filled -- dead on arrival whenever the sheet names
  // a store other than the one the dropdown is showing, which is the
  // ordinary case for a shop counting a second branch. The dropdown opens on
  // Main (the mocked `activeLocation`); the sheet names Branch.
  it('hands over a single-store sheet naming a different store than the one selected, without losing the line', async () => {
    listProducts.mockImplementation(async (_shopId: string, locationId?: string) => {
      if (locationId === 'loc-2') return [product({ stock: 3 })];
      if (locationId === 'loc-1') return [product({ stock: 11 })];
      return [product({ stock: 11 })];
    });
    pickCsvFile.mockResolvedValue(uploaded([{ Product: 'QA widget', Store: 'Branch', Counted: '8' }]));
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());
    await act(async () => pressableWithText(tree, 'Upload a filled sheet').props.onPress());

    // Without the fix this field does not exist at all: the reload effect
    // clears the basket the same render the handover filled it.
    expect(fieldNamed(tree, COUNTED).props.value).toBe('8');
    expect(allText(tree)).toContain('Save 1 count');
  });

  // Finding 2: the brief's own second test never reached `commitPlan` -- both
  // its rows sat at Main with no rejections, so the plan handed over to the
  // by-hand tab and the assertion ran against `submit` instead. A second
  // store in the plan is what forces the handover to swallow nothing: with
  // two stores in `next.counts`, `handedOver` (`next.counts.length === 1`) is
  // false and the plan stays on the sheet tab, to be committed by
  // `commitPlan` -- the one place a SET can quietly become an ADD. A third,
  // blank row is kept alongside them so the sheet's "leave it out, don't zero
  // it" rule is still proven at the component boundary, not only in
  // count-import.test.ts's pure-function tests.
  it('sends the counted total per store through commitPlan, and never counts a product the sheet left blank', async () => {
    listProducts.mockImplementation(async (_shopId: string, locationId?: string) => {
      if (locationId === 'loc-2') return [product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 })];
      if (locationId === 'loc-1') {
        return [product({}), product({ id: 'p-3', name: 'QA extra', sku: 'QA-3', stock: 4 })];
      }
      return [
        product({}),
        product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 }),
        product({ id: 'p-3', name: 'QA extra', sku: 'QA-3', stock: 4 }),
      ];
    });
    pickCsvFile.mockResolvedValue(
      uploaded([
        { Product: 'QA widget', Store: 'Main', Counted: '8' },
        { Product: 'QA other', Store: 'Branch', Counted: '9' },
        { Product: 'QA extra', Store: 'Main', Counted: '' },
      ])
    );
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());
    await act(async () => pressableWithText(tree, 'Upload a filled sheet').props.onPress());

    // Two stores, so the plan stayed on the sheet tab -- if this ever reads
    // "No sheet yet" again, the handover swallowed it and the assertions below
    // are exercising `submit`, not `commitPlan`.
    expect(allText(tree)).toContain('2 counted');
    // The skipped pill, pinned: deleting it changed nothing in the mutation
    // review, because nothing here asserted it existed.
    expect(allText(tree)).toContain('1 rows left blank — skipped');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());

    // One call per store, and neither carries the blank third row.
    expect(saveStockCount).toHaveBeenCalledTimes(2);
    // App said 11, the shop counted 8 -- the SET this whole feature exists to
    // guarantee. `countedQuantity + previousQuantity` (11 + 8 = 19) is the
    // exact ADD bug this feature exists to prevent, and it must never reach
    // the RPC.
    expect(saveStockCount).toHaveBeenCalledWith(
      'shop-1',
      'loc-1',
      [{ productId: 'p-1', countedQuantity: 8, reason: null }],
      { note: null }
    );
    expect(saveStockCount).toHaveBeenCalledWith(
      'shop-1',
      'loc-2',
      [{ productId: 'p-2', countedQuantity: 9, reason: null }],
      { note: null }
    );
  });

  // Finding 3: a mutation deleting the whole rejected block -- the pill, the
  // "WHAT WON'T" list and the download button -- left all 19 tests green. A
  // shop that cannot see WHY a row was refused does not know what it failed
  // to count, so the reason text is what has to reach the screen, not merely
  // a count of how many rows were rejected.
  it('shows what each rejected row failed for, not merely how many', async () => {
    listProducts.mockResolvedValue([product({})]);
    pickCsvFile.mockResolvedValue(
      uploaded([
        { Product: 'QA widget', Store: 'Main', Counted: '8' },
        { Product: 'Nonexistent widget', Store: 'Main', Counted: '5' },
      ])
    );
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());
    await act(async () => pressableWithText(tree, 'Upload a filled sheet').props.onPress());

    // A rejection keeps `handedOver` false regardless of store count, so this
    // stays on the sheet tab where the rejected block actually renders.
    expect(allText(tree)).toContain('1 rejected');
    expect(allText(tree)).toContain("WHAT WON'T");
    expect(allText(tree)).toContain('Row 3');
    expect(allText(tree)).toContain('No product matches "Nonexistent widget"');
    expect(allText(tree)).toContain('Download the 1 rejected row');
  });
});

describe('closing the sheet tab', () => {
  // The five pieces of sheet-tab state (sheetFile, sheetHeaders, plan,
  // sheetNotice, partialCount) did not exist before this component grew a
  // sheet tab, so closeAndReset could not have reset them. Adding the tab
  // without adding these resets is exactly the shape of bug that shipped on
  // the restock screen: this component is never unmounted (the screen renders
  // it with `visible={false}`), so a plan left standing behind a closed sheet
  // sits there under a still-live Save button, ready to commit the same
  // stock-take again the next time the sheet is opened.
  it('drops a live plan on close, so re-opening the sheet cannot commit it twice', async () => {
    // Two stores, so the sheet plan is NOT handed over to the by-hand tab
    // (handover only happens for a single-store, rejection-free plan) and
    // stays a live, committable plan on the sheet tab itself.
    listProducts.mockImplementation(async (_shopId: string, locationId?: string) => {
      if (locationId === 'loc-2') return [product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 })];
      if (locationId === 'loc-1') return [product({})];
      return [product({}), product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 })];
    });
    pickCsvFile.mockResolvedValue(
      uploaded([
        { Product: 'QA widget', Store: 'Main', Counted: '8' },
        { Product: 'QA other', Store: 'Branch', Counted: '9' },
      ])
    );
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());
    await act(async () => pressableWithText(tree, 'Upload a filled sheet').props.onPress());

    // The plan is live: two counted lines across two stores, and the button
    // that would commit them is enabled.
    expect(allText(tree)).toContain('2 counted');
    expect(allText(tree)).toContain('count-sheet.csv');
    expect(pressableLabelled(tree, 'Save counts').props.disabled).toBe(false);

    await act(async () => pressableWithText(tree, 'Close').props.onPress());
    // closeAndReset also sends the tab back to 'hand' -- switch back to see
    // what the sheet tab is left holding.
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());

    // `plan` is null, not merely emptied: the footer reads the same "nothing
    // uploaded yet" sentence a sheet tab that was never touched would, and
    // the button that used to commit the two-store plan is disabled again
    // rather than sitting there live with the old numbers still visible.
    expect(allText(tree)).toContain('No sheet yet');
    // Pins `setSheetFile(null)` / `setSheetHeaders([])`: an existing test that
    // asserted only plan-derived text passed even with both left out, because
    // neither ever reached a Text node it was checking. The filename is the
    // one thing on this screen that only `sheetFile` renders.
    expect(allText(tree)).not.toContain('count-sheet.csv');
    expect(allText(tree)).not.toContain('2 counted');
    expect(pressableLabelled(tree, 'Save counts').props.disabled).toBe(true);
  });

  it('drops the upload notice on close, so the by-hand tab does not show a stale banner', async () => {
    listProducts.mockResolvedValue([product({})]);
    pickCsvFile.mockResolvedValue(uploaded([{ Product: 'QA widget', Counted: '8' }]));
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());
    await act(async () => pressableWithText(tree, 'Upload a filled sheet').props.onPress());
    expect(allText(tree)).toContain('ready. Change anything before saving.');

    await act(async () => pressableWithText(tree, 'Close').props.onPress());
    expect(allText(tree)).not.toContain('ready. Change anything before saving.');
  });

  it('drops what a partial failure counted, so the next sheet does not read as a continuation of it', async () => {
    listProducts.mockImplementation(async (_shopId: string, locationId?: string) => {
      if (locationId === 'loc-2') return [product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 })];
      if (locationId === 'loc-1') return [product({})];
      return [product({}), product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 })];
    });
    pickCsvFile.mockResolvedValue(
      uploaded([
        { Product: 'QA widget', Store: 'Main', Counted: '8' },
        { Product: 'QA other', Store: 'Branch', Counted: '9' },
      ])
    );
    // Main succeeds, Branch fails -- a partial failure, which is the one case
    // that leaves `plan` non-null (`{ ...plan, counts: [] }`) after commitPlan
    // returns without reaching closeAndReset.
    saveStockCount.mockResolvedValueOnce('count-1').mockRejectedValueOnce(new Error('not authorized for shop shop-1'));
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());
    await act(async () => pressableWithText(tree, 'Upload a filled sheet').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());

    expect(allText(tree)).toContain('1 line already counted');
    expect(allText(tree)).toContain('before the failure above');

    await act(async () => pressableWithText(tree, 'Close').props.onPress());
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());

    // Without the reset, `plan` would still be the emptied-but-non-null object
    // commitPlan left behind, and the footer would read "0 counted" -- a
    // sheet tab that looks touched rather than one that was never opened.
    expect(allText(tree)).toContain('No sheet yet');
    expect(allText(tree)).not.toContain('already counted');
    expect(allText(tree)).not.toContain('before the failure above');
  });
});

const { createExpense } = jest.requireMock('@/lib/expenses') as { createExpense: jest.Mock };

describe('logging the shortfall', () => {
  beforeEach(() => createExpense.mockClear());

  // Unticked, for the same reason Restock's sibling is: a silent write into
  // Accounting is a surprise, and opt-in is recoverable where opt-out is not.
  // (The double-count argument that justifies Restock's default does NOT apply
  // here -- nothing else in the app or in a shop's paperwork records shrinkage
  // -- which is exactly why it is worth stating that this is a deliberate
  // match rather than the same reasoning.)
  it('offers the write and does not make it', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    expect(allText(tree)).toContain('Also log $13.83 of shortfall as stock loss');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(createExpense).not.toHaveBeenCalled();
  });

  it('writes one stock_loss expense for the store when it is ticked', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());

    expect(createExpense).toHaveBeenCalledTimes(1);
    expect(createExpense.mock.calls[0][1]).toMatchObject({
      locationId: 'loc-1',
      amountCents: 1383,
      category: 'stock_loss',
    });
  });

  // After the count, never before: an expense for a stock-take that failed is a
  // number in the P&L with no missing stock behind it.
  it('writes the expense only after the numbers have changed', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount.mock.invocationCallOrder[0]).toBeLessThan(createExpense.mock.invocationCallOrder[0]);
  });

  it('writes nothing when the count itself was refused', async () => {
    saveStockCount.mockRejectedValueOnce(new Error('not authorized for shop shop-1'));
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(createExpense).not.toHaveBeenCalled();
  });

  // GROSS, not net. Two units found are not a refund, and the checkbox's figure
  // is deliberately larger than the variance line above it.
  it('offers the shortfall without netting off the units that were found', async () => {
    const tree = await open([product({}), product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 24, costCents: 461 })]);
    await act(async () => pressableLabelled(tree, 'Count QA other').props.onPress());
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await backspace(tree, 'Counted units of QA other', 2);
    await type(tree, 'Counted units of QA other', '26');
    expect(allText(tree)).toContain('−$4.61');
    expect(allText(tree)).toContain('Also log $13.83 of shortfall as stock loss');
  });

  // Hide, don't lie. An uncosted product contributes nothing to the total, so a
  // count full of them would offer a figure far below the real loss.
  it('hides the offer when a product that came up short has no cost, and says why', async () => {
    const tree = await open([product({ costCents: null })]);
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    expect(allText(tree)).not.toContain('as stock loss');
    expect(allText(tree)).toContain('no cost recorded');
  });

  // The tick survives a tab switch and an edit, so the gate is re-read at
  // commit rather than trusted -- the checkbox merely disappearing must not
  // leave a stale yes behind it.
  it('does not write when an edit removes the honest total after ticking', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await backspace(tree, COUNTED, 1);
    await type(tree, COUNTED, '11');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(createExpense).not.toHaveBeenCalled();
  });
});
