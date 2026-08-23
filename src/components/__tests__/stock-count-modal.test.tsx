import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';

import { StockCountModal } from '@/components/stock-count-modal';
import { parseCsvText, rowsToCsv } from '@/lib/csv';
import { COUNT_TEMPLATE_COLUMNS } from '@/lib/count-import';
import { toDateColumn } from '@/lib/period';

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

// A single labelled `Pressable` shows up as THREE matching tree nodes, not
// one: the outer `Pressable` element, RN's own inner `View` wrapper, and the
// host view underneath it all carry `accessibilityLabel` unchanged.
// `pressableLabelled` above never notices, because `[0]` is always the
// outermost of the three and its `onPress` works the same as the others' --
// but COUNTING how many rows offer a control needs exactly one entry per
// control, so this keeps only the outermost node in each matching subtree
// (the one whose parent does not already match).
function pressablesLabelled(tree: ReactTestRenderer, label: string): ReactTestInstance[] {
  return tree.root.findAll(
    (n) => n.props.accessibilityLabel === label && (!n.parent || n.parent.props.accessibilityLabel !== label)
  );
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

// The by-hand tab writes in two presses now: Save counts opens the
// confirmation, and only the confirmation's own button commits. The sheet tab
// still writes on one press and does NOT use this.
async function saveByHand(tree: ReactTestRenderer) {
  await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
  await act(async () => pressableLabelled(tree, 'Confirm and save the count').props.onPress());
}

async function open(products = [product({})]): Promise<ReactTestRenderer> {
  listProducts.mockResolvedValue(products);
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />
    );
  });
  return tree;
}

beforeEach(() => {
  saveStockCount.mockClear();
  saveStockCount.mockResolvedValue('count-1');
});

describe('a line added to a count', () => {
  // The pre-fill is gone, and this is the rule the whole redesign turns on. A
  // field seeded with what the app believes would mean the app had counted
  // every shelf in the shop on its own.
  //
  // MUTATION: seed the field with `String(product.stock)`. This test goes red
  // on the value; the 'skips a product nobody counted' test below goes red on
  // what reaches the RPC.
  it('starts blank, so a row nobody has touched is a product nobody counted', async () => {
    const tree = await open();
    const field = fieldNamed(tree, COUNTED);
    expect(field.props.value).toBe('');
    // Blank and zero must never look alike: the DASH is a placeholder, so the
    // value stays '' and nothing downstream can read it as a count.
    expect(field.props.placeholder).toBe('—');
    expect(allText(tree)).toContain('App says 11');
    expect(allText(tree)).toContain('Nothing counted yet');
  });

  // MUTATION: have `plannedLines` include blank rows. On a real catalogue that
  // is 238 shelves zeroed by a walk that touched two of them.
  it('skips a product nobody counted and sends only the row that was typed', async () => {
    const tree = await open([
      product({}),
      product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 }),
    ]);
    await type(tree, 'Counted units of QA other', '4');
    await saveByHand(tree);
    expect(saveStockCount).toHaveBeenCalledWith(
      'shop-1',
      'loc-1',
      [{ productId: 'p-2', countedQuantity: 4, reason: null }],
      { note: null }
    );
  });

  // MUTATION: make `canSubmit` true when `handLines` is empty. Saving nothing
  // writes a stock-take record against a shelf nobody walked.
  it('refuses to save a catalogue nobody has typed into', async () => {
    const tree = await open();
    expect(pressableLabelled(tree, 'Save counts').props.disabled).toBe(true);
    expect(allText(tree)).toContain('Save 0 counts');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount).not.toHaveBeenCalled();
  });

  // MUTATION: classify an unreadable entry as blank in `walkRow`. `abc` would
  // be silently skipped and the shop would believe it counted that shelf.
  it('blocks the save on an unreadable entry, and says which', async () => {
    const tree = await open([
      product({}),
      product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 }),
    ]);
    await type(tree, COUNTED, '8');
    await type(tree, 'Counted units of QA other', 'abc');
    expect(allText(tree)).toContain('One line is not a whole number');
    expect(pressableLabelled(tree, 'Save counts').props.disabled).toBe(true);
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount).not.toHaveBeenCalled();
  });

  // The regression class three separate 100x cost bugs came from on the restock
  // branch. If anything rewrites the text on its way into state, the recorded
  // value after some keystroke stops equalling what was typed.
  it('never rewrites the text between keystrokes', async () => {
    const tree = await open();
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    await type(tree, COUNTED, '108');
    expect(fieldNamed(tree, COUNTED).props.value).toBe('108');
    await backspace(tree, COUNTED, 1);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('10');
  });

  // An emptied field returns the row to "not counted" -- but the reason chosen
  // beside it survives, so a backspace to retype a number does not silently
  // take the shop's own word for what happened with it.
  //
  // MUTATION: delete the entry outright in `setCounted` when the text is empty.
  // The reason is lost on the first backspace and comes back as 'Reason'.
  it('returns an emptied row to not-counted, and gives the reason back when it is retyped', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Reason for QA widget').props.onPress());
    await act(async () => pressableLabelled(tree, 'Reason: Damaged').props.onPress());
    await backspace(tree, COUNTED, 1);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    expect(allText(tree)).toContain('Nothing counted yet');
    await type(tree, COUNTED, '9');
    expect(allText(tree)).toContain('Damaged');
  });

  // Finding 2: the two-step version never gave an untouched product a WHY
  // cell to press at all -- MatchRow (the search-result row for a product not
  // yet added to the basket) rendered a bare "Count" button, nothing else.
  // That coverage disappeared when every product became a row in this
  // migration, because the WHY cell started rendering unconditionally. A
  // reason is a statement about a count; a blank row has not made one, and
  // the mockup draws this cell as an inert dash for exactly that reason
  // (count-one-step-mockup.html:203, 221).
  //
  // MUTATION: render the pressable Reason chip unconditionally (drop the
  // `touched ? … : …` branch in CountRowView). This test's `toBeUndefined()`
  // goes red -- the chip exists, opens, and a reason can be picked for a shelf
  // nobody counted.
  it('gives a row nobody has counted nothing to press for a reason', async () => {
    const tree = await open();
    expect(pressableLabelled(tree, 'Reason for QA widget')).toBeUndefined();
    expect(allText(tree)).toContain('—');
  });

  // The panel has to close along with the chip, not merely lose its trigger:
  // a reason panel opened before a backspace emptied the field must not stay
  // interactable underneath the dash it left behind.
  //
  // MUTATION: drop the `touched &&` guard on the reason-options panel. The
  // panel (and `Reason: Damaged` inside it) stays open and pressable after the
  // backspace that emptied the field.
  it('closes the open reason panel along with the chip when the count is backspaced to blank', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Reason for QA widget').props.onPress());
    expect(pressableLabelled(tree, 'Reason: Damaged')).toBeDefined();
    await backspace(tree, COUNTED, 1);
    expect(pressableLabelled(tree, 'Reason for QA widget')).toBeUndefined();
    expect(pressableLabelled(tree, 'Reason: Damaged')).toBeUndefined();
  });

  // Zero is a finding, not a blank. Refusing it would leave the door able to
  // record every loss except a total one.
  // MUTATION: filter `handLines` on `countedQuantity !== 0` before the RPC
  // call in `submit`. Every other save test types a non-zero count, so the
  // filter reads as harmless -- but it is the one row that matters most, an
  // empty shelf, and it would silently never reach the RPC at all.
  it('accepts a counted zero, reads it as an empty shelf, and sends it', async () => {
    const tree = await open();
    await type(tree, COUNTED, '0');
    expect(allText(tree)).toContain('−11');
    expect(allText(tree)).toContain('1 will change a number');
    // Not named in the brief's own list of by-hand saves to rewrite -- but a
    // single press here now only opens the confirmation, so left alone this
    // assertion would read `saveStockCount.mock.calls[0]` off a mock that was
    // never called and throw rather than fail cleanly. The zero-as-a-real-count
    // rule is exactly the one the confirmation's own "blank vs zero" guarantee
    // exists to protect, so it has to keep reaching the RPC through the new
    // two-press path.
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    // The confirmation has to draw the SAME distinction the RPC payload does:
    // a zero count is a real, large change (an empty shelf), never folded into
    // "already matched" or left off the list the way an untouched row would be.
    //
    // MUTATION: classify `changing`/`matched` in CountConfirm on
    // `countedQuantity !== 0` instead of `variance !== 0`. Nothing else in this
    // file opens the panel on a zero count and reads what it says, so this is
    // the one place a carve-out for zero would go unnoticed -- and it is
    // exactly the row a mistaken carve-out would hide: a total loss.
    expect(allText(tree)).toContain('1 product will change');
    expect(allText(tree)).toContain('11 → 0');
    await act(async () => pressableLabelled(tree, 'Confirm and save the count').props.onPress());
    expect(saveStockCount).toHaveBeenCalledWith(
      'shop-1',
      'loc-1',
      [{ productId: 'p-1', countedQuantity: 0, reason: null }],
      { note: null }
    );
  });

  // The variance is the column, not a footnote: the person doing the
  // stock-take already knows the 8 -- what they will be asked about is how far
  // off the app was.
  it('shows the variance live and signed', async () => {
    const tree = await open();
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
  //
  // The variance is now a tinted BOX (varianceBox + varianceBoxUp/Down/Flat),
  // not a bare Text -- so the tint itself is read off the box the number sits
  // inside, one level up from the Text node the number is found on. Reading
  // only the text colour (as the old version of this test did) would stay
  // green if the box's background were deleted entirely, since the number
  // itself is still legible without it -- exactly the regression the tint
  // exists to prevent for a reader who cannot rely on colour alone. Verified
  // by mutation: see the report.
  it('marks a shortfall in the shortfall tint, and a surplus in a different one', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8'); // App says 11, counted 8: a shortfall of 3.
    const shortfallText = tree.root.findAll((n) => n.type === Text && textFrom(n) === '−3')[0];
    const shortfallBox = shortfallText.parent!;
    expect(StyleSheet.flatten(shortfallBox.props.style).backgroundColor).toBe('#FBEDEE');
    expect(StyleSheet.flatten(shortfallText.props.style).color).toBe('#A3202F');

    await backspace(tree, COUNTED, 1);
    await type(tree, COUNTED, '14'); // Counted 14: a surplus of 3.
    const surplusText = tree.root.findAll((n) => n.type === Text && textFrom(n) === '+3')[0];
    const surplusBox = surplusText.parent!;
    expect(StyleSheet.flatten(surplusBox.props.style).backgroundColor).toBe('#E9F5EE');
    expect(StyleSheet.flatten(surplusText.props.style).color).toBe('#007A38');
    expect(StyleSheet.flatten(surplusBox.props.style).backgroundColor).not.toBe('#FBEDEE');
    expect(StyleSheet.flatten(surplusText.props.style).color).not.toBe('#A3202F');
  });

  // The sign is the accessibility fallback for the tint above -- '−3' and
  // '+3' must stay distinguishable by glyph alone, never only by the box's
  // colour. Pinned separately from the tint test so a mutation that drops the
  // sign (but leaves the tint and the magnitude intact) still goes red.
  it('keeps the sign on the variance regardless of direction', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8'); // App says 11, counted 8: a shortfall of 3.
    expect(tree.root.findAll((n) => n.type === Text && textFrom(n) === '−3')).toHaveLength(1);
    // The bare, unsigned magnitude must not appear at all -- a mutation that
    // drops the minus (but keeps the magnitude and the tint) would otherwise
    // still read as a plausible "3" in the same spot.
    expect(tree.root.findAll((n) => n.type === Text && textFrom(n) === '3')).toHaveLength(0);

    await backspace(tree, COUNTED, 1);
    await type(tree, COUNTED, '14'); // Counted 14: a surplus of 3.
    expect(tree.root.findAll((n) => n.type === Text && textFrom(n) === '+3')).toHaveLength(1);
    expect(tree.root.findAll((n) => n.type === Text && textFrom(n) === '3')).toHaveLength(0);
  });

  // The regression this whole change exists to prevent: COUNTED used to sit
  // above every field, once per row, which is what made the first child of
  // `qtyPair` taller than its neighbours in the first place. It now renders
  // once, as a header over the whole basket -- pinned here with two lines in
  // the basket, where "once per row" and "once per basket" actually disagree.
  it('renders the COUNTED header once for the whole basket, not once per row', async () => {
    const tree = await open([
      product({}),
      product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 }),
    ]);
    expect(tree.root.findAll((n) => n.type === Text && textFrom(n) === 'COUNTED')).toHaveLength(1);
    expect(allText(tree)).toContain('OFF BY');
    expect(allText(tree)).toContain('WHY');
  });

  // Finding 4: the brief declares this label an interface Tasks 3-5 depend on
  // (paging's own filter box), and deleting it left every other test green --
  // nothing else in the file looks the search field up by name.
  //
  // MUTATION: delete `aria-label="Search products"` from the search
  // TextInput. `fieldNamed` returns `undefined` and this goes red.
  it('carries the aria-label the picker and paging tasks are built on', async () => {
    const tree = await open();
    expect(fieldNamed(tree, 'Search products')).toBeDefined();
  });

  // Finding 4: `filtered` used to read `filterProducts(catalogue, search,
  // category)`; wiring it to `catalogue` directly instead left every existing
  // test green, because none of them ever narrowed the list before this.
  //
  // MUTATION: replace `filterProducts(catalogue, search, category)` with
  // `catalogue` in the `filtered` memo. Both rows stay on screen after the
  // search narrows to one, and this goes red.
  it('narrows the rows on screen to what the search matches', async () => {
    const tree = await open([
      product({}),
      product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 }),
    ]);
    expect(fieldNamed(tree, 'Counted units of QA other')).toBeDefined();
    await act(async () => fieldNamed(tree, 'Search products').props.onChangeText('other'));
    expect(fieldNamed(tree, 'Counted units of QA widget')).toBeUndefined();
    expect(fieldNamed(tree, 'Counted units of QA other')).toBeDefined();
  });
});

describe('clearing', () => {
  // The × replaces `Remove`, and the difference matters: there is no basket to
  // take a line out of. It returns the row to blank -- the product was never
  // added in the first place.
  //
  // MUTATION: have `clearRow` set `{ counted: '', reason: <kept> }` instead of
  // deleting the entry. The count clears but a reason nobody can see any more
  // rides along into the next thing typed there.
  it('clears one row back to blank, reason and all', async () => {
    const tree = await open([
      product({}),
      product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 }),
    ]);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Reason for QA widget').props.onPress());
    await act(async () => pressableLabelled(tree, 'Reason: Damaged').props.onPress());
    await type(tree, 'Counted units of QA other', '4');
    expect(allText(tree)).toContain('Save 2 counts');

    await act(async () => pressableLabelled(tree, 'Clear QA widget').props.onPress());
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    expect(allText(tree)).toContain('Save 1 count');
    // The row's own reason is gone, not merely hidden: retyping must not bring
    // 'Damaged' back the way an ordinary backspace does.
    await type(tree, COUNTED, '8');
    expect(pressableLabelled(tree, 'Reason for QA widget')).toBeDefined();
    expect(allText(tree)).not.toContain('Damaged');
    // The other row is untouched.
    expect(fieldNamed(tree, 'Counted units of QA other').props.value).toBe('4');
  });

  // MUTATION: render the × on every row. On a 240-product catalogue that is 240
  // clear buttons for rows there is nothing to clear on -- and the × is one of
  // the three things standing between a mistyped row and an overwritten shelf,
  // so it has to mean "this row is counted".
  it('offers the × only on a counted row', async () => {
    const tree = await open();
    expect(pressablesLabelled(tree, 'Clear QA widget')).toHaveLength(0);
    await type(tree, COUNTED, '8');
    expect(pressablesLabelled(tree, 'Clear QA widget')).toHaveLength(1);
  });

  // A reason without a count is the one shape the sheet planner rejects
  // outright ("Reason is filled in but Counted is empty"). The two tabs must
  // not disagree about it.
  //
  // MUTATION: keep the reason chip pressable on a blank row. A shop can then
  // record why a product it never counted went missing.
  it('offers the reason only on a counted row', async () => {
    const tree = await open();
    expect(pressablesLabelled(tree, 'Reason for QA widget')).toHaveLength(0);
    await type(tree, COUNTED, '8');
    expect(pressablesLabelled(tree, 'Reason for QA widget')).toHaveLength(1);
  });

  // Beside Close, where a destructive action belongs. It empties every field on
  // every page, the reasons and the note -- and leaves the store and the tab
  // where they are.
  //
  // MUTATION: have `clearAll` reset `locationId` too. A shop that clears a
  // mistake is silently moved to a different branch, and the next walk counts
  // the wrong room.
  it('clears every field and the note, and leaves the store alone', async () => {
    const tree = await open([
      product({}),
      product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 }),
    ]);
    await act(async () => pressableWithText(tree, 'Main').props.onPress());
    await act(async () => pressableWithText(tree, 'Branch').props.onPress());
    await type(tree, COUNTED, '8');
    await type(tree, 'Counted units of QA other', '4');
    await type(tree, 'Note about this stock-take', 'aisle three');
    expect(allText(tree)).toContain('Save 2 counts');

    await act(async () => pressableLabelled(tree, 'Clear all').props.onPress());

    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    expect(fieldNamed(tree, 'Counted units of QA other').props.value).toBe('');
    expect(fieldNamed(tree, 'Note about this stock-take').props.value).toBe('');
    expect(allText(tree)).toContain('Save 0 counts');
    // Still at Branch -- the store is not part of what was cleared.
    expect(allText(tree)).toContain('Branch');
  });

  // `reasonOpenFor` is state separate from `entries` -- wiping the entries
  // does not by itself close a reason panel a chip press had already opened.
  // Left standing, it is invisible until the SAME row is counted again after
  // Clear all, when the panel would fold open on its own rather than staying
  // shut until pressed -- indistinguishable from the row confirming a reason
  // nobody chose this time.
  //
  // MUTATION: drop `setReasonOpenFor(null)` from `clearAll`. Every other test
  // in this file stays green, because none of them recount a row whose reason
  // panel was left open across a Clear all.
  it('does not leave a reason panel primed to reopen across Clear all', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Reason for QA widget').props.onPress());
    expect(pressableLabelled(tree, 'Reason: Damaged')).toBeDefined();

    await act(async () => pressableLabelled(tree, 'Clear all').props.onPress());
    await type(tree, COUNTED, '8');

    expect(pressableLabelled(tree, 'Reason: Damaged')).toBeUndefined();
  });

  // MUTATION: drop the `canClearAll` gate. A live destructive button over a
  // walk with nothing in it is a control that can only do harm.
  it('offers Clear all only when there is something to clear', async () => {
    const tree = await open();
    expect(pressableLabelled(tree, 'Clear all').props.disabled).toBe(true);
    await type(tree, COUNTED, '8');
    expect(pressableLabelled(tree, 'Clear all').props.disabled).toBe(false);
  });

  // It clears by-hand state. Over the sheet tab it would read as an offer to
  // discard an uploaded plan, which it does not do.
  //
  // MUTATION: render Clear all unconditionally.
  it('does not offer Clear all over the sheet tab', async () => {
    const tree = await open();
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Clear all')).toHaveLength(0);
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
    await type(tree, COUNTED, '11');
    await act(async () => pressableWithText(tree, 'Main').props.onPress());
    await act(async () => pressableWithText(tree, 'Branch').props.onPress());

    // The row is still on screen -- it is Branch's row now -- and it is blank.
    // MUTATION: remove the `storeChanged` branch's `updateEntries(() => ({}))`.
    // The stale 11 sits in a field captioned "App says 3", ready to overwrite a
    // shelf nobody walked, and the commit below sends 11 instead of 3.
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    expect(allText(tree)).toContain('App says 3');

    await type(tree, COUNTED, '3');
    await saveByHand(tree);
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
  // what has been typed.
  it('does not clear what has been typed when the effect re-runs at the same store', async () => {
    const tree = await open();
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
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Reason for QA widget').props.onPress());
    await act(async () => pressableLabelled(tree, 'Reason: Damaged').props.onPress());
    await saveByHand(tree);

    expect(saveStockCount).toHaveBeenCalledWith(
      'shop-1',
      'loc-1',
      [{ productId: 'p-1', countedQuantity: 8, reason: 'damaged' }],
      { note: null }
    );
  });

  it('sends a null reason rather than defaulting one', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await saveByHand(tree);
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
    await type(tree, COUNTED, '8');
    await saveByHand(tree);
    // The walk is spent: the confirmation is gone and Save is dead, so the one
    // failure that already committed cannot be committed again.
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Confirm and save the count')).toHaveLength(0);
    expect(pressableLabelled(tree, 'Save counts').props.disabled).toBe(true);
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Confirm and save the count')).toHaveLength(0);
    expect(saveStockCount).toHaveBeenCalledTimes(1);
  });

  // A failure that wrote NOTHING is the opposite case, and the basket must
  // survive it -- this is the one failure a shop fixes by pressing again.
  it('keeps the basket when the count itself was refused', async () => {
    saveStockCount.mockRejectedValueOnce(new Error('not authorized for shop shop-1'));
    const tree = await open();
    await type(tree, COUNTED, '8');
    await saveByHand(tree);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('8');
    expect(allText(tree)).toContain('not authorized');
  });
});

describe('the sheet staying open after a save', () => {
  // The reason this whole change exists: a shop with a long catalogue does
  // not finish a stock-take in one sitting, and closing throws away the
  // store, the search, the category filter and the place in the list.
  //
  // MUTATION: call `closeAndReset()` at the tail of `submit` instead of
  // `setSuccess(...)`. `onClose` fires and this goes red.
  it('does not close the sheet on a successful save', async () => {
    listProducts.mockResolvedValue([product({})]);
    const onClose = jest.fn();
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={onClose} onDone={async () => {}} />);
    });
    await type(tree, COUNTED, '8');
    await saveByHand(tree);
    expect(onClose).not.toHaveBeenCalled();
    // Still on the by-hand tab and still able to count -- not merely "did not
    // call onClose" while actually stuck in some broken half-state.
    expect(fieldNamed(tree, COUNTED)).toBeDefined();
  });

  // A successful save and Clear all both leave every field blank -- once the
  // sheet stops closing, this sentence is the only thing on screen that tells
  // them apart, on a door that overwrites stock with no undo. Register
  // matched to CountConfirm's own headline ("N products will change"), past
  // tense.
  //
  // MUTATION: delete the `setSuccess(...)` call from `submit`. The banner
  // never appears and this goes red.
  it('names what changed and where, once the save lands', async () => {
    const tree = await open(); // App says 11
    await type(tree, COUNTED, '8'); // a real change
    await saveByHand(tree);
    expect(allText(tree)).toContain('1 product changed at Main');
  });

  // MUTATION: headline `handSummary.counted` instead of filtering on
  // `variance !== 0` -- the exact mistake CountConfirm's own headline guards
  // against (see its own comment). A row counted at the figure it already
  // held would read as a change here too.
  it('says plainly that nothing changed when every counted row already matched', async () => {
    const tree = await open(); // App says 11
    await type(tree, COUNTED, '11'); // matches
    await saveByHand(tree);
    expect(allText(tree)).toContain('Nothing changed at Main');
  });

  // The banner describes a walk that is already over. Left standing while a
  // new number is typed, it would read as a claim about THAT number -- on a
  // screen whose whole design is that typing a number IS counting it.
  //
  // MUTATION: delete `setSuccess(null)` from `setCounted`. The stale banner
  // is still on screen after the new keystroke and this goes red.
  it('clears the success banner the moment a new count is typed', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await saveByHand(tree);
    expect(allText(tree)).toContain('1 product changed at Main');
    await type(tree, COUNTED, '5');
    expect(allText(tree)).not.toContain('1 product changed at Main');
    expect(allText(tree)).not.toContain('changed at Main');
  });

  // `closeAndReset` is the only thing standing between one stock-take and the
  // next, because this component is never unmounted (the screen renders it
  // with `visible={false}` instead) -- nothing else would ever clear a banner
  // left over from a session ago.
  //
  // MUTATION: drop `setSuccess(null)` from `closeAndReset`. The banner is
  // still there after Close and this goes red.
  it('drops the success banner on close, so the next stock-take does not open under a stale one', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await saveByHand(tree);
    expect(allText(tree)).toContain('1 product changed at Main');
    await act(async () => pressableWithText(tree, 'Close').props.onPress());
    expect(allText(tree)).not.toContain('changed at Main');
  });

  // The whole point of staying open: "App says" has to catch up to what was
  // just saved, or the sheet is lying to whoever counts the next shelf.
  //
  // MUTATION: delete the `load()` / `setCatalogue(refreshed)` call from
  // `submit`. The row goes on reading "App says 11" forever and this goes red.
  it('reloads the catalogue so App says shows the number that was just saved', async () => {
    const tree = await open(); // App says 11
    await type(tree, COUNTED, '5');
    listProducts.mockResolvedValueOnce([product({ stock: 5 })]);
    await saveByHand(tree);
    expect(allText(tree)).toContain('App says 5');
    expect(allText(tree)).not.toContain('App says 11');
  });

  // The reload is not conditioned on the expense write also succeeding -- the
  // count itself already landed either way, and "App says" has to catch up
  // regardless of what happens to the bookkeeping.
  //
  // MUTATION: move the `load()` call after the `if (expenseProblem)` check.
  // This test's "App says 5" assertion goes red because the function returns
  // before ever reaching it.
  it('reloads the catalogue even when the stock-loss expense fails to log afterward', async () => {
    createExpense.mockRejectedValueOnce(new Error('expenses are read-only'));
    const tree = await open(); // App says 11
    await type(tree, COUNTED, '5');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    listProducts.mockResolvedValueOnce([product({ stock: 5 })]);
    await saveByHand(tree);
    expect(allText(tree)).toContain('App says 5');
    expect(allText(tree)).toContain('The count was saved, but the stock loss was not logged');
  });

  // THE guard against a double-commit, proven again now that the sheet stays
  // open to be pressed a second time: `entries` is emptied and `canSubmit`
  // needs a typed row, so Save counts is dead until something new is typed.
  //
  // MUTATION: drop `setBusy(false)` from the tail of `submit`. `busy` stays
  // true forever, and the button reads "Saving…" and stays disabled for a
  // reason that has nothing to do with an empty basket -- but still disabled,
  // so this specific test cannot tell that apart from the fix. It is caught
  // instead by the Clear-all test below, which goes red the same way.
  it('leaves Save counts dead after a successful save until something new is typed', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await saveByHand(tree);
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Confirm and save the count')).toHaveLength(0);
    expect(pressableLabelled(tree, 'Save counts').props.disabled).toBe(true);
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount).toHaveBeenCalledTimes(1);
  });

  // `canClearAll` reads `busy` and `confirming` too, and both have to come
  // back down rather than merely leaving Save counts disabled for the wrong
  // reason (see the comment above).
  //
  // MUTATION: drop `setBusy(false)` OR `setConfirming(false)` from the tail
  // of `submit`. Either flag stuck true keeps Clear all disabled even once
  // there is something to clear again, and this goes red.
  it('leaves Clear all enable-able again after a successful save, once something new is typed', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await saveByHand(tree);
    // Nothing to clear immediately after a clean save -- correctly disabled.
    expect(pressableLabelled(tree, 'Clear all').props.disabled).toBe(true);
    await type(tree, COUNTED, '3');
    expect(pressableLabelled(tree, 'Clear all').props.disabled).toBe(false);
  });

  // A note describes THIS stock-take. Carried silently into the next one, it
  // would attach the wrong sentence to a different walk -- now an observable
  // risk for the first time, since the field is still on screen to carry it.
  it('clears the note after a successful save, so it does not attach to the next stock-take', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await type(tree, 'Note about this stock-take', 'aisle three');
    await saveByHand(tree);
    expect(fieldNamed(tree, 'Note about this stock-take').props.value).toBe('');
  });

  // Same reasoning as the note: the tick was an answer about THIS shortfall,
  // not a standing preference to log the next one too.
  it('un-ticks the stock-loss checkbox after a successful save, so it does not carry into the next one', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await saveByHand(tree);
    // Type a new shortfall-causing count so the checkbox renders again.
    await type(tree, COUNTED, '5');
    expect(pressableLabelled(tree, 'Log the shortfall as stock loss').props.accessibilityState).toEqual({
      checked: false,
    });
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
    await type(tree, COUNTED, '8');
    await act(async () => pressableWithText(tree, 'Close').props.onPress());
    // Every field is blank again. The ROW still renders -- every product is a
    // row now -- so the field's value is what proves the walk was reset, not
    // the row's absence.
    // MUTATION: drop `updateEntries(() => ({}))` from `closeAndReset`. The next
    // stock-take opens holding the last one's numbers under a live Save button.
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    expect(allText(tree)).toContain('Save 0 counts');
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
    await type(tree, COUNTED, '8');
    expect(allText(tree)).toContain('Also log $13.83 of shortfall as stock loss');
    // Not named in the brief's own list -- but a single press only opens the
    // confirmation now, so `submit` (and the gate this test exists to prove)
    // would never run at all, and `createExpense` not being called would stop
    // meaning anything.
    await saveByHand(tree);
    expect(saveStockCount).toHaveBeenCalledTimes(1);
    expect(createExpense).not.toHaveBeenCalled();
  });

  it('writes one stock_loss expense for the store when it is ticked', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await saveByHand(tree);

    expect(createExpense).toHaveBeenCalledTimes(1);
    // The whole payload, not just the three fields a `toMatchObject` used to
    // pin -- `occurredOn` most of all, since `toISOString().slice(0, 10)`
    // would put an evening stock-take into tomorrow's P&L and regressing
    // exactly that used to fail nothing here.
    expect(createExpense.mock.calls[0][1]).toEqual({
      locationId: 'loc-1',
      occurredOn: toDateColumn(new Date()),
      amountCents: 1383,
      category: 'stock_loss',
      vendorId: null,
      paymentMethod: 'cash',
      note: 'Stock-take',
    });
  });

  // After the count, never before: an expense for a stock-take that failed is a
  // number in the P&L with no missing stock behind it.
  it('writes the expense only after the numbers have changed', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await saveByHand(tree);
    expect(saveStockCount.mock.invocationCallOrder[0]).toBeLessThan(createExpense.mock.invocationCallOrder[0]);
  });

  it('writes nothing when the count itself was refused', async () => {
    saveStockCount.mockRejectedValueOnce(new Error('not authorized for shop shop-1'));
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await saveByHand(tree);
    expect(createExpense).not.toHaveBeenCalled();
  });

  // GROSS, not net. Two units found are not a refund, and the checkbox's figure
  // is deliberately larger than the variance line above it.
  it('offers the shortfall without netting off the units that were found', async () => {
    const tree = await open([product({}), product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 24, costCents: 461 })]);
    await type(tree, COUNTED, '8');
    await type(tree, 'Counted units of QA other', '26');
    expect(allText(tree)).toContain('−$4.61');
    expect(allText(tree)).toContain('Also log $13.83 of shortfall as stock loss');
  });

  // Hide, don't lie. An uncosted product contributes nothing to the total, so a
  // count full of them would offer a figure far below the real loss.
  it('hides the offer when a product that came up short has no cost, and says why', async () => {
    const tree = await open([product({ costCents: null })]);
    await type(tree, COUNTED, '8');
    expect(allText(tree)).not.toContain('as stock loss');
    expect(allText(tree)).toContain('no cost recorded');
  });

  // The tick survives a tab switch and an edit, so the gate is re-read at
  // commit rather than trusted -- the checkbox merely disappearing must not
  // leave a stale yes behind it.
  it('does not write when an edit removes the honest total after ticking', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await backspace(tree, COUNTED, 1);
    await type(tree, COUNTED, '11');
    await saveByHand(tree);
    expect(createExpense).not.toHaveBeenCalled();
  });

  // Finding 3: neutering `if (expenseProblem)` in `submit` closes the sheet as
  // though the write succeeded, silently losing the shrinkage cost -- exactly
  // the failure mode the sibling restock screen already guards and asserts.
  // The count itself must stand (one `saveStockCount` call) while the sheet
  // stays open naming what did not land, rather than calling `closeAndReset`.
  it('reports a failed expense instead of closing over it, with the count already standing', async () => {
    createExpense.mockRejectedValueOnce(new Error('expenses are read-only'));
    listProducts.mockResolvedValue([product({})]);
    const onClose = jest.fn();
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={onClose} onDone={async () => {}} />);
    });
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await saveByHand(tree);

    expect(saveStockCount).toHaveBeenCalledTimes(1);
    expect(allText(tree)).toContain('The count was saved, but the stock loss was not logged: expenses are read-only');
    expect(onClose).not.toHaveBeenCalled();
  });

  // Finding 3: `updateEntries(() => ({}))` right after the write commits has
  // no guard of its own -- the test above never presses Save a second time,
  // so deleting that line leaves all other tests green. Without it, the sheet
  // reopens on the failed-expense path holding the same typed count, Save
  // goes live again the moment `busy` resets, and a second press repeats a
  // commit that already landed -- the exact double-commit the comment above
  // `submit`'s try block claims to prevent, and the same Critical that shipped
  // on the sibling Restock screen.
  //
  // MUTATION: delete `updateEntries(() => ({}))` from `submit`, immediately
  // after the `saveStockCount` write resolves. `saveStockCount` goes from 1
  // call to 2 on the second press.
  it('clears what was typed even when the expense after it fails, so a second press cannot repeat the commit', async () => {
    createExpense.mockRejectedValueOnce(new Error('expenses are read-only'));
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await saveByHand(tree);

    expect(saveStockCount).toHaveBeenCalledTimes(1);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    expect(pressableLabelled(tree, 'Save counts').props.disabled).toBe(true);
    // The confirmation went down with the write, same as the reload-failure
    // canary above -- a live "Yes, save" here would be a second route into an
    // expense retry that isn't what this button says it does.
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Confirm and save the count')).toHaveLength(0);

    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount).toHaveBeenCalledTimes(1);
  });
});

describe('logging the shortfall from a sheet', () => {
  beforeEach(() => createExpense.mockClear());

  // Finding 1: `commitPlan` used to trust `logExpense` alone rather than
  // re-reading the aggregate actually on screen for the sheet tab.
  // `uncostedShortfallLines` is computed across every store, so the moment
  // ANY store has an uncosted short line, `planSummary.shortfallCents` goes
  // null and the checkbox is replaced entirely by the "no cost recorded"
  // sentence -- while a `logExpense` ticked earlier (on the by-hand tab, then
  // carried across a tab switch) is still `true`. This reproduces the
  // reviewer's exact scenario: a two-store sheet where Branch's product has
  // no cost, ticked on the by-hand tab first.
  it('does not write when the sheet tab never offered the checkbox at all', async () => {
    listProducts.mockImplementation(async (_shopId: string, locationId?: string) => {
      if (locationId === 'loc-2') return [product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 24, costCents: null })];
      if (locationId === 'loc-1') return [product({})];
      return [product({}), product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 24, costCents: null })];
    });
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    // Tick the checkbox on the by-hand tab, against Main's own costed
    // shortfall -- this is the stale `true` the fix must not trust later.
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());

    // Switch to the sheet tab and upload a two-store plan where Branch's
    // product has no cost -- the aggregate goes null, so the checkbox is
    // replaced by the withheld-cost sentence and nothing offers a tick here.
    pickCsvFile.mockResolvedValue(
      uploaded([
        { Product: 'QA widget', Store: 'Main', Counted: '8' },
        { Product: 'QA other', Store: 'Branch', Counted: '20' },
      ])
    );
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());
    await act(async () => pressableWithText(tree, 'Upload a filled sheet').props.onPress());

    expect(allText(tree)).toContain('no cost recorded');
    expect(allText(tree)).not.toContain('as stock loss');

    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());

    // Both stores' counts still go through -- only the expense must be
    // withheld.
    expect(saveStockCount).toHaveBeenCalledTimes(2);
    expect(createExpense).not.toHaveBeenCalled();
  });

  // Finding 2: deleting the whole `if (offered) { ... }` block left every
  // existing test green, because nothing asserted per-store attribution --
  // "the point of the whole feature" per the brief's own Step 6. Two costed
  // shortfalls at two different stores, with two different amounts, so a
  // mutation swapping `count.locationId` for `plan.counts[0].locationId`
  // (attributing the whole loss to whichever store went first) is also
  // caught, not just a missing call.
  it('writes one stock_loss expense per store, each for its own shortfall and its own store', async () => {
    listProducts.mockImplementation(async (_shopId: string, locationId?: string) => {
      if (locationId === 'loc-2') return [product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 10, costCents: 200 })];
      if (locationId === 'loc-1') return [product({})];
      return [product({}), product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 10, costCents: 200 })];
    });
    pickCsvFile.mockResolvedValue(
      uploaded([
        { Product: 'QA widget', Store: 'Main', Counted: '8' },
        { Product: 'QA other', Store: 'Branch', Counted: '4' },
      ])
    );
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());
    await act(async () => pressableWithText(tree, 'Upload a filled sheet').props.onPress());
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());

    expect(saveStockCount).toHaveBeenCalledTimes(2);
    expect(createExpense).toHaveBeenCalledTimes(2);
    // Main: 11 - 8 = 3 short × 461c = 1383c. Branch: 10 - 4 = 6 short × 200c
    // = 1200c -- deliberately different amounts and stores, so a lump-sum or
    // first-store attribution bug shows up as a wrong number, not merely a
    // wrong count of calls.
    expect(createExpense.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ locationId: 'loc-1', amountCents: 1383, category: 'stock_loss' }),
      expect.objectContaining({ locationId: 'loc-2', amountCents: 1200, category: 'stock_loss' }),
    ]);
  });

  // Finding 2, second half: one store's expense failing must not roll back or
  // hide the other store's count, and the error must name the store whose
  // expense failed -- kept apart from "Some of the count did not go through",
  // which would falsely say the stock-take itself failed.
  it('names the one store whose expense failed while the count at both stores still stands', async () => {
    listProducts.mockImplementation(async (_shopId: string, locationId?: string) => {
      if (locationId === 'loc-2') return [product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 10, costCents: 200 })];
      if (locationId === 'loc-1') return [product({})];
      return [product({}), product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 10, costCents: 200 })];
    });
    pickCsvFile.mockResolvedValue(
      uploaded([
        { Product: 'QA widget', Store: 'Main', Counted: '8' },
        { Product: 'QA other', Store: 'Branch', Counted: '4' },
      ])
    );
    createExpense.mockRejectedValueOnce(new Error('expenses are read-only'));
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());
    await act(async () => pressableWithText(tree, 'Upload a filled sheet').props.onPress());
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());

    // Both stores' counts went through -- the failure is in bookkeeping only.
    expect(saveStockCount).toHaveBeenCalledTimes(2);
    expect(createExpense).toHaveBeenCalledTimes(2);
    expect(allText(tree)).toContain('The count was saved, but the stock loss was not logged:');
    expect(allText(tree)).toContain('Main: expenses are read-only');
    expect(allText(tree)).not.toContain('Some of the count did not go through');
  });
});

// A catalogue long enough to page. Names are zero-padded so the aria-label of
// any row is predictable, and stock is uniform so a variance is only ever the
// result of something this test typed.
const catalogueOf = (count: number, prefix = 'QA') =>
  Array.from({ length: count }, (_, i) =>
    product({ id: `p-${i}`, name: `${prefix} ${String(i).padStart(3, '0')}`, sku: `${prefix}-${i}`, stock: 10 })
  );

describe('paging a long catalogue', () => {
  // THE regression this feature keeps producing, pinned at the only boundary
  // that can see it: what `saveStockCount` is actually handed. A count typed on
  // page 1 and dropped by paging to page 2 is invisible until a shelf comes out
  // wrong.
  //
  // MUTATION: build `handLines` from `paged.items` (or from `filtered`) instead
  // of from the whole `catalogue`. The render stays perfect and the commit
  // silently loses every count not currently scrolled into view.
  it('keeps a count typed on page 1 while the walk is on page 2, and sends both', async () => {
    const tree = await open(catalogueOf(150));
    await type(tree, 'Counted units of QA 000', '4');
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());

    // Page 2 genuinely does not render page 1's row.
    expect(tree.root.findAll((n) => n.props['aria-label'] === 'Counted units of QA 000')).toHaveLength(0);
    await type(tree, 'Counted units of QA 100', '7');
    await act(async () => pressableLabelled(tree, 'Previous page').props.onPress());
    expect(fieldNamed(tree, 'Counted units of QA 000').props.value).toBe('4');

    // Not named in the brief's own list -- but left as a single press this
    // would only open the confirmation, and `saveStockCount.mock.calls[0]`
    // would be undefined rather than the two-page payload this test exists to
    // prove.
    await saveByHand(tree);
    expect(saveStockCount.mock.calls[0][2]).toEqual([
      { productId: 'p-0', countedQuantity: 4, reason: null },
      { productId: 'p-100', countedQuantity: 7, reason: null },
    ]);
  });

  // The same rule for the other two things that change what is rendered.
  //
  // MUTATION: rebuild `entries` from `filtered` on every search change.
  it('keeps a count typed under one search term after the search changes, and sends both', async () => {
    const tree = await open([
      product({ id: 'p-1', name: 'Dr Althea', sku: 'SK-1', stock: 7 }),
      product({ id: 'p-2', name: 'clay mask sachet', sku: 'SK-2', stock: 12 }),
    ]);
    await type(tree, 'Search products', 'Althea');
    await type(tree, 'Counted units of Dr Althea', '5');
    await backspace(tree, 'Search products', 6);
    await type(tree, 'Search products', 'clay');
    await type(tree, 'Counted units of clay mask sachet', '15');
    await backspace(tree, 'Search products', 4);

    expect(fieldNamed(tree, 'Counted units of Dr Althea').props.value).toBe('5');
    await saveByHand(tree);
    expect(saveStockCount.mock.calls[0][2]).toEqual([
      { productId: 'p-1', countedQuantity: 5, reason: null },
      { productId: 'p-2', countedQuantity: 15, reason: null },
    ]);
  });

  // A control that can never do anything should not be on screen -- and most
  // shops on the platform carry fewer than a hundred products.
  //
  // MUTATION: render the pager whenever `pageCount > 0`. Every shop in the
  // country grows a Previous/Next row that does nothing.
  it('renders no pager at all at a hundred products', async () => {
    const tree = await open(catalogueOf(100));
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Next page')).toHaveLength(0);
    expect(allText(tree)).not.toContain('Showing');
  });

  // MUTATION: off-by-one in `from`/`to`, or reading `filtered.length` as the
  // page length. This line is the only thing on screen that says how much of
  // the shop is not visible.
  it('says which window it is showing and how much of the walk is off-screen', async () => {
    const tree = await open(catalogueOf(240));
    expect(allText(tree)).toContain('Showing 1–100 of 240');
    await type(tree, 'Counted units of QA 000', '4');
    expect(allText(tree)).toContain('Showing 1–100 of 240 · 1 counted so far, on any page');
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    expect(allText(tree)).toContain('Showing 101–200 of 240 · 1 counted so far, on any page');
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    expect(allText(tree)).toContain('Showing 201–240 of 240');
  });

  // MUTATION: leave both buttons always enabled. `Next` on the last page walks
  // off the end into a blank list.
  it('disables the ends of the walk', async () => {
    const tree = await open(catalogueOf(240));
    expect(pressableLabelled(tree, 'Previous page').props.disabled).toBe(true);
    expect(pressableLabelled(tree, 'Next page').props.disabled).toBe(false);
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    expect(pressableLabelled(tree, 'Next page').props.disabled).toBe(true);
    expect(pressableLabelled(tree, 'Previous page').props.disabled).toBe(false);
  });

  // Staying on page 3 of a set that now has 12 rows shows nothing. The clamp in
  // `pageSlice` would rescue the empty-list case on its own, so this is built
  // to be a case the clamp CANNOT rescue: 250 down to 150 leaves page 3
  // clamping to page 2, which renders rows 101-150 of the new set rather than
  // its first row.
  //
  // MUTATION: delete `setPage(1)` from the search handler.
  it('goes back to the first page when the search narrows the set', async () => {
    const tree = await open([...catalogueOf(150, 'SKIN'), ...catalogueOf(100, 'HOME')]);
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    expect(allText(tree)).toContain('Showing 201–250 of 250');
    await type(tree, 'Search products', 'SKIN');
    expect(allText(tree)).toContain('Showing 1–100 of 150');
    expect(fieldNamed(tree, 'Counted units of SKIN 000').props.value).toBe('');
  });

  // --- coverage beyond the brief's own six cases -------------------------
  //
  // `setPage(1)` lands at six call sites in total: the search box, the
  // category chips, the store-transition guard, `closeAndReset`, and the
  // sheet-upload handover -- plus the pager's own buttons. The search case
  // above proves the pattern works; these four prove the other guarded sites
  // actually carry it, since a mutation dropping any ONE of them leaves every
  // test above green (none of them touch a store switch, a close, or a
  // sheet upload while parked on page 2).

  // `Clear all` replaces the whole `entries` object in one write
  // (`updateEntries(() => ({}))`), which should already reach every page --
  // but nothing above ever presses it after paging, so nothing proves it.
  //
  // MUTATION: scope the wipe to `paged.items` (delete only the entries for
  // products on the CURRENT page) instead of replacing the whole object. A
  // shop that presses Clear all on page 1 would still find page 2's counts
  // alive and reach Save believing the walk was cleared.
  it('clears every page, not just the one on screen', async () => {
    const tree = await open(catalogueOf(150));
    await type(tree, 'Counted units of QA 000', '4');
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    await type(tree, 'Counted units of QA 100', '7');
    expect(allText(tree)).toContain('Save 2 counts');

    await act(async () => pressableLabelled(tree, 'Clear all').props.onPress());
    expect(allText(tree)).toContain('Save 0 counts');
    expect(fieldNamed(tree, 'Counted units of QA 100').props.value).toBe('');

    await act(async () => pressableLabelled(tree, 'Previous page').props.onPress());
    expect(fieldNamed(tree, 'Counted units of QA 000').props.value).toBe('');
  });

  // Both stores carry 150 -- two pages each -- on purpose: with only one page
  // at the destination, `pageSlice`'s own clamp would land on page 1 anyway
  // and the test would pass whether or not the guard's `setPage(1)` exists.
  //
  // MUTATION: delete `setPage(1)` from the store-transition branch. Page 2 of
  // Main becomes page 2 of Branch, a set the clamp alone cannot correct back
  // to page 1 because Branch also has a page 2.
  it('goes back to the first page when the store changes', async () => {
    listProducts.mockImplementation(async (_shopId: string, locationId: string) =>
      locationId === 'loc-2' ? catalogueOf(150, 'BR') : catalogueOf(150, 'MA')
    );
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    expect(allText(tree)).toContain('Showing 101–150 of 150');

    await act(async () => pressableWithText(tree, 'Main').props.onPress());
    await act(async () => pressableWithText(tree, 'Branch').props.onPress());

    expect(allText(tree)).toContain('Showing 1–100 of 150');
  });

  // This component is never unmounted -- the screen renders it with
  // `visible={false}` and it returns null -- so `closeAndReset` is the only
  // thing standing between a stock-take parked on page 2 and the next one
  // opening stranded there before anything has been typed.
  //
  // MUTATION: delete `setPage(1)` from `closeAndReset`. The sheet reopens on
  // whatever page it was last left on.
  it('resets the page on close, so the sheet does not reopen stranded on a later page', async () => {
    const tree = await open(catalogueOf(150));
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    expect(allText(tree)).toContain('Showing 101–150 of 150');
    await act(async () => pressableWithText(tree, 'Close').props.onPress());
    expect(allText(tree)).toContain('Showing 1–100 of 150');
  });

  // A sheet that turns out to be one store hands its lines to the by-hand tab
  // scattered across the whole catalogue -- a page left on 2 from before the
  // upload would hide the very row the notice above is about.
  //
  // MUTATION: delete `setPage(1)` from the upload handover. The filled row is
  // in `entries` (Save would still send it) but sits on page 1 behind a
  // screen still parked on page 2.
  it('goes back to the first page when an uploaded sheet hands its single store over to the by-hand tab', async () => {
    pickCsvFile.mockResolvedValue(uploaded([{ Product: 'QA 000', Store: 'Main', Counted: '4' }]));
    const tree = await open(catalogueOf(150));
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());
    await act(async () => pressableWithText(tree, 'Upload a filled sheet').props.onPress());

    expect(allText(tree)).toContain('Showing 1–100 of 150');
    expect(fieldNamed(tree, 'Counted units of QA 000').props.value).toBe('4');
  });
});

describe('the confirmation', () => {
  // Count SETS a number. There is no undo, and a mistyped row overwrites a real
  // shelf -- so pressing Save must not write.
  //
  // MUTATION: wire the list footer's button straight to `submit`. The write
  // happens on the first press and the panel never appears.
  it('writes nothing on the first press, and names the store, the changes and the reasons', async () => {
    const tree = await open([
      product({ id: 'p-1', name: 'Dr Althea', sku: 'SK-1', stock: 7 }),
      product({ id: 'p-2', name: 'daily facial', sku: 'SK-2', stock: 5 }),
      product({ id: 'p-3', name: 'clay mask sachet', sku: 'SK-3', stock: 12 }),
      product({ id: 'p-4', name: 'untouched thing', sku: 'SK-4', stock: 3 }),
    ]);
    await type(tree, 'Counted units of Dr Althea', '5');
    await act(async () => pressableLabelled(tree, 'Reason for Dr Althea').props.onPress());
    await act(async () => pressableLabelled(tree, 'Reason: Theft or loss').props.onPress());
    await type(tree, 'Counted units of daily facial', '5');
    await type(tree, 'Counted units of clay mask sachet', '15');

    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount).not.toHaveBeenCalled();

    const shown = allText(tree);
    // The headline is the number that CHANGES, not the number counted.
    // MUTATION: headline `summary.counted` instead. It reads "3 counted" as
    // "3 will change" on any walk where a row matched -- overstating what is
    // about to happen, on the one screen that exists to state it exactly.
    expect(shown).toContain('2 products will change');
    expect(shown).not.toContain('3 products will change');
    // MUTATION: drop the store name. Stock-takes go wrong by being saved
    // against the wrong branch, and this is the last screen that can catch it.
    expect(shown).toContain('At Main');
    expect(shown).toContain('3 counted, 1 already matched');
    // Both numbers for every change, and the reason each carries.
    expect(shown).toContain('Dr Althea');
    expect(shown).toContain('7 → 5');
    expect(shown).toContain('Theft or loss');
    expect(shown).toContain('clay mask sachet');
    expect(shown).toContain('12 → 15');
    // MUTATION: hide the reasonless line's caption. Unexplained shrinkage IS
    // the finding, and a blank there reads as "no shrinkage".
    expect(shown).toContain('no reason given');
    // A matched row is recorded, and says so rather than appearing as a change.
    expect(shown).toContain('daily facial was counted at 5 and is already 5');
    expect(shown).toContain('1 product was not counted and is untouched.');
  });

  // MUTATION: replace the panel with a `Modal` (or `AppModal`). On iOS a modal
  // presented from a modal is silently dropped and the button reads as dead --
  // this has bitten twice on this branch. The panel must be a plain View inside
  // the AppModal already on screen.
  it('unfolds inside the sheet already on screen, opening no second modal', async () => {
    const tree = await open();
    const modalsBefore = tree.root.findAll((n) => n.props.transparent !== undefined).length;
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(allText(tree)).toContain('1 product will change');
    expect(tree.root.findAll((n) => n.props.transparent !== undefined)).toHaveLength(modalsBefore);
  });

  // "Cancel" reads like it might throw the walk away, and on a shelf you just
  // spent twenty minutes counting that ambiguity is cruel.
  //
  // MUTATION: have `Go back` call `clearAll` as well. Twenty minutes gone.
  it('goes back to the list with everything intact', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    await act(async () => pressableLabelled(tree, 'Go back').props.onPress());
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Go back')).toHaveLength(0);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('8');
    expect(saveStockCount).not.toHaveBeenCalled();
  });

  // If the stock-loss box is ticked, this write also touches the P&L. That
  // belongs in the confirmation, not only in a checkbox scrolled past.
  //
  // MUTATION: render the money line whenever `logExpense` is true, ignoring
  // `handExpenseCents`. The panel then promises a P&L row on a walk with no
  // shortfall, which `submit` correctly refuses to write -- a confirmation that
  // lies about what it is about to do.
  it('discloses the stock-loss expense, and only when one will actually be written', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(allText(tree)).toContain('Also logs $13.83 as a stock-loss expense');

    await act(async () => pressableLabelled(tree, 'Go back').props.onPress());
    await backspace(tree, COUNTED, 1);
    await type(tree, COUNTED, '11');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(allText(tree)).not.toContain('stock-loss expense');
  });

  // Recording that a shelf was checked and found correct is a real and useful
  // result, so this still offers to save.
  //
  // MUTATION: disable the confirm button when nothing changes, or refuse to
  // open the panel at all. A shop that walks a shelf and finds it right can no
  // longer record that it did.
  it('says plainly that nothing will change, and still offers to save', async () => {
    const tree = await open();
    await type(tree, COUNTED, '11');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(allText(tree)).toContain('Nothing will change');
    expect(allText(tree)).toContain('Yes, record the count');
    await act(async () => pressableLabelled(tree, 'Confirm and save the count').props.onPress());
    expect(saveStockCount).toHaveBeenCalledWith(
      'shop-1',
      'loc-1',
      [{ productId: 'p-1', countedQuantity: 11, reason: null }],
      { note: null }
    );
  });

  // HAZARD 3, from the other direction: a refused write leaves the walk intact,
  // and the confirmation must not be left standing over it with a live button.
  //
  // MUTATION: drop `setConfirming(false)` from the catch. The error renders
  // behind a panel still offering "Yes, save 1 change" against numbers that
  // just failed, which is a second live route into the same write.
  it('returns to the list on a refused write, with everything typed still there', async () => {
    saveStockCount.mockRejectedValueOnce(new Error('not authorized for shop shop-1'));
    const tree = await open();
    await type(tree, COUNTED, '8');
    await saveByHand(tree);
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Confirm and save the count')).toHaveLength(0);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('8');
    expect(allText(tree)).toContain('not authorized');
  });

  // MUTATION: leave `Clear all` live during the confirmation. Pressing it from
  // behind the panel empties the walk the panel is describing, and the panel
  // goes on offering to save it.
  it('stands Clear all down while the confirmation is open', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(pressableLabelled(tree, 'Clear all').props.disabled).toBe(true);
  });

  // MUTATION: drop `setConfirming(false)` from `closeAndReset`. The next
  // stock-take opens straight into a confirmation of the last one's numbers.
  it('is gone when the sheet is closed and re-opened', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    await act(async () => pressableWithText(tree, 'Close').props.onPress());
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Confirm and save the count')).toHaveLength(0);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
  });
});
